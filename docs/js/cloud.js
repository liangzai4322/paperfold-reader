const apiPrefix = "/paperfold-api/v1";
export const AUTO_DOWNLOAD_BYTES = 64 * 1024;
const idPattern = /^[a-zA-Z0-9._-]{4,120}$/;
const formats = new Set(["plain", "markdown", "auto"]);

export class CloudError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function cloudAddress(value) {
  try {
    const address = new URL(value.trim());
    if (address.protocol === "https:" && !address.username && !address.password && !address.search && !address.hash
        && ["/", "/paperfold-api", "/paperfold-api/"].includes(address.pathname)) return address.origin;
  } catch {
    // The UI reports an invalid or incomplete address.
  }
  return "";
}

function validBook(book, publicShelf) {
  if (!book || typeof book.id !== "string" || !idPattern.test(book.id) || typeof book.title !== "string" || !formats.has(book.format)) return false;
  const numbers = publicShelf ? [book.bytes, book.createdAt] : [book.bytes, book.createdAt, book.offset, book.progressAt];
  return numbers.every((value) => Number.isSafeInteger(value) && value >= 0)
    && (!publicShelf || book.archived === 0 || book.archived === 1);
}

export function createCloudClient(connection, { publicShelf = false } = {}) {
  async function request(path, method = "GET", body) {
    const abort = new AbortController();
    const expiry = setTimeout(() => abort.abort(), 28000);
    try {
      const headers = connection.token ? { Authorization: "Bearer " + connection.token } : {};
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetch(connection.url + apiPrefix + path, {
        method, headers, signal: abort.signal, credentials: "omit", redirect: "error",
        body: body && JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new CloudError(response.status, data.error || "remote_error");
      return data;
    } finally {
      clearTimeout(expiry);
    }
  }

  async function record(path, method, body) {
    const book = await request(path, method, body);
    if (!validBook(book, publicShelf)) throw new CloudError(502, "invalid_response");
    return book;
  }

  const booksPath = publicShelf ? "/public/books" : "/books";
  const bookPath = (id) => booksPath + "/" + encodeURIComponent(id);
  return {
    async pair(pin) {
      const data = await request("/pair", "POST", { pin });
      if (typeof data.token !== "string" || data.token.length < 32 || data.token.length > 256) {
        throw new CloudError(502, "invalid_response");
      }
      return data.token;
    },
    async list(after = "", archived = false) {
      const query = new URLSearchParams();
      if (after) query.set("after", after);
      if (archived) query.set("archived", "1");
      const search = query.toString();
      const data = await request(booksPath + (search ? "?" + search : ""));
      if (!Array.isArray(data.books) || !data.books.every((book) => validBook(book, publicShelf))
          || (data.next !== null && (typeof data.next !== "string" || !idPattern.test(data.next) || data.next <= after))) {
        throw new CloudError(502, "invalid_response");
      }
      return data;
    },
    async get(id) {
      const book = await record(bookPath(id));
      if (book.id !== id || typeof book.text !== "string") throw new CloudError(502, "invalid_response");
      return book;
    },
    put(book, meta) {
      return record(bookPath(book.id), "PUT", {
        text: book.source, title: meta.title, format: meta.format, createdAt: meta.createdAt,
        publish: meta.pendingPublication || undefined,
      });
    },
    shelfAction(id, action) {
      return record(bookPath(id) + "/shelf", "PATCH", { action });
    },
    progress(meta) {
      return record(bookPath(meta.id) + "/progress", "PATCH", {
        offset: meta.offset, progressAt: meta.progressAt,
      });
    },
  };
}

export async function syncLibrary(storage, client, { pull }) {
  let deferred = 0;
  for (const meta of await storage.listBooks()) {
    if (!meta.pendingUpload) continue;
    const local = await storage.getBook(meta.id);
    if (!local) continue;
    try {
      let accepted = await client.put(local.book, meta);
      if (meta.pendingPublication && !accepted.published) accepted = await client.shelfAction(meta.id, "publish");
      await storage.mergeRemote([accepted], true);
    } catch (error) {
      if (![400, 409, 413].includes(error.status)) throw error;
      deferred++;
    }
  }
  for (const meta of await storage.listBooks()) {
    if (!meta.pendingProgress || meta.pendingUpload) continue;
    const accepted = await client.progress(meta);
    await storage.mergeRemote([accepted]);
  }
  if (pull) {
    let after = "";
    do {
      const page = await client.list(after);
      await storage.mergeRemote(page.books);
      after = page.next;
    } while (after);
  }
  return deferred;
}
