const storeName = "reading";
const lastBookKey = "last-book-id";
const shelfPrefix = "shelf/";
const publicBodyPrefix = "public-body/";
const publicBodyKey = (id) => publicBodyPrefix + id;
const publicViewKey = (archived) => archived ? "public-archive" : "public-library";
const shelfKey = (id) => shelfPrefix + id;
const textKey = (id) => "source/" + id;

function savedBook(meta, source) {
  if (!meta || typeof source !== "string") return null;
  return {
    book: { id: meta.id, source, title: meta.title, format: meta.format },
    position: { offset: meta.offset, fontIndex: meta.fontIndex },
  };
}

function matchesOrNewer(incoming, local) {
  return !local || incoming.progressAt > local.progressAt
    || (incoming.progressAt === local.progressAt && incoming.offset >= local.offset);
}

function catalogRecord(book, position, pendingUpload, pendingPublication) {
  return {
    id: book.id, title: book.title, format: book.format,
    bytes: new TextEncoder().encode(book.source).length,
    createdAt: book.createdAt,
    offset: position.offset || 0, fontIndex: position.fontIndex, progressAt: position.progressAt || 0,
    cached: true, pendingUpload, pendingPublication, pendingProgress: Boolean(position.progressAt),
  };
}

export function createBookStorage(indexedDB) {
  let connecting;

  function open() {
    connecting ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("paperfold-reader", 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Reading database is in use"));
    });
    return connecting;
  }

  async function transact(mode, start) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error("Reading transaction aborted"));
      start(transaction.objectStore(storeName), (value) => { result = value; });
    });
  }

  function get(key) {
    return transact("readonly", (store, finish) => {
      const request = store.get(key);
      request.onsuccess = () => finish(request.result);
    });
  }

  function put(key, value) {
    return transact("readwrite", (store) => store.put(value, key));
  }

  function storeBook(store, book, position, publish = false) {
    store.put(catalogRecord(book, position, true, publish), shelfKey(book.id));
    store.put(book.source, textKey(book.id));
    store.put(book.id, lastBookKey);
  }

  function migrateLatest() {
    return transact("readwrite", (store, finish) => {
      const remembered = store.get(lastBookKey);
      remembered.onsuccess = () => {
        if (remembered.result) {
          finish(remembered.result);
          return;
        }
        const legacy = store.get("latest");
        legacy.onsuccess = () => {
          const previous = legacy.result;
          if (!previous || typeof previous.text !== "string" || !previous.id) return;
          const position = store.get("position/" + previous.id);
          position.onsuccess = () => {
            const book = { id: previous.id, source: previous.text, format: "plain",
              title: previous.text.trim().split("\n", 1)[0]?.slice(0, 120) || "未命名", createdAt: Date.now() };
            const previousPosition = position.result || { offset: 0 };
            storeBook(store, book, { ...previousPosition, progressAt: previousPosition.offset ? book.createdAt : 0 });
            finish(book.id);
          };
        };
      };
    });
  }

  function getBook(id) {
    return transact("readonly", (store, finish) => {
      const meta = store.get(shelfKey(id));
      const source = store.get(textKey(id));
      source.onsuccess = () => finish(savedBook(meta.result, source.result));
    });
  }

  function mergeEntry(store, remote, local, cached = local?.cached || false) {
    const useRemote = matchesOrNewer(remote, local);
    store.put({
      id: remote.id, title: remote.title, format: remote.format, bytes: remote.bytes,
      createdAt: remote.createdAt,
      offset: useRemote ? remote.offset : local.offset, fontIndex: local?.fontIndex,
      progressAt: useRemote ? remote.progressAt : local.progressAt,
      cached, pendingUpload: false, pendingProgress: !useRemote && local.pendingProgress,
      published: Boolean(remote.published), archived: Boolean(remote.archived),
    }, shelfKey(remote.id));
  }

  return {
    async load() {
      const id = await get(lastBookKey) || await migrateLatest();
      return id ? getBook(id) : null;
    },
    getBook,
    rememberBook(id) { return put(lastBookKey, id); },
    listBooks() {
      return transact("readonly", (store, finish) => {
        const entries = store.getAll(IDBKeyRange.bound(shelfPrefix, shelfPrefix + "\uffff"));
        entries.onsuccess = () => finish(entries.result.sort((a, b) => b.createdAt - a.createdAt));
      });
    },
    saveBook(book, position, publish) {
      return transact("readwrite", (store) => storeBook(store, book, position, publish));
    },
    loadPublicShelf(archived) { return get(publicViewKey(archived)); },
    savePublicShelf(archived, books) { return put(publicViewKey(archived), books); },
    getPublicBody(id) { return get(publicBodyKey(id)); },
    cachePublicBody(book) { return put(publicBodyKey(book.id), book.text); },
    listPublicDownloads() {
      return transact("readonly", (store, finish) => {
        const keys = store.getAllKeys(IDBKeyRange.bound(publicBodyPrefix, publicBodyPrefix + "\uffff"));
        keys.onsuccess = () => finish(keys.result.map((key) => key.slice(publicBodyPrefix.length)));
      });
    },
    savePosition(id, position) {
      return transact("readwrite", (store) => {
        const request = store.get(shelfKey(id));
        request.onsuccess = () => {
          const record = request.result;
          if (!record || record.offset === position.offset) return;
          store.put({ ...record, offset: position.offset, fontIndex: position.fontIndex,
            progressAt: Math.max(Date.now(), record.progressAt + 1), pendingProgress: true }, shelfKey(id));
        };
      });
    },
    mergeRemote(records, acceptedUpload = false) {
      return transact("readwrite", (store) => {
        for (const remote of records) {
          const request = store.get(shelfKey(remote.id));
          request.onsuccess = () => {
            const local = request.result;
            if (!local?.pendingUpload || acceptedUpload) mergeEntry(store, remote, local);
          };
        }
      });
    },
    cacheRemote(remote) {
      return transact("readwrite", (store) => {
        const request = store.get(shelfKey(remote.id));
        request.onsuccess = () => {
          if (request.result?.pendingUpload) return;
          mergeEntry(store, remote, request.result, true);
          store.put(remote.text, textKey(remote.id));
        };
      });
    },
    loadTapMode() { return get("tap-mode"); },
    saveTapMode(mode) { return put("tap-mode", mode); },
    loadAppearance() { return get("appearance"); },
    saveAppearance(appearance) { return put("appearance", appearance); },
    loadCloud() { return get("cloud-connection"); },
    saveCloud(connection) { return put("cloud-connection", connection); },
  };
}
