const storeName = "reading";
const bookKey = "latest";
const tapModeKey = "tap-mode";

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

  function positionKey(id) {
    return "position/" + id;
  }

  return {
    load() {
      return transact("readonly", (store, finish) => {
        const latest = store.get(bookKey);
        latest.onsuccess = () => {
          const book = latest.result;
          if (!book) return;
          const position = store.get(positionKey(book.id));
          position.onsuccess = () => finish({ book, position: position.result });
        };
      });
    },
    saveBook(book, position) {
      return transact("readwrite", (store) => {
        store.put(book, bookKey);
        store.put(position, positionKey(book.id));
      });
    },
    savePosition(id, position) {
      return transact("readwrite", (store) => store.put(position, positionKey(id)));
    },
    loadTapMode() {
      return transact("readonly", (store, finish) => {
        const request = store.get(tapModeKey);
        request.onsuccess = () => finish(request.result);
      });
    },
    saveTapMode(mode) {
      return transact("readwrite", (store) => store.put(mode, tapModeKey));
    },
  };
}
