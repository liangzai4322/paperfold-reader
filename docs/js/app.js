import { createPager, normalizeText } from "./pagination.js";
import { bindPageTurn } from "./page-turn.js?v=4";
import { createBookStorage } from "./storage.js?v=7";
import { readingText, titleFrom } from "./markdown.js?v=7";
import { AUTO_DOWNLOAD_BYTES, cloudAddress, createCloudClient, syncLibrary } from "./cloud.js?v=8";

const byId = (id) => document.getElementById(id);
const entry = byId("entry");
const reader = byId("reader");
const field = byId("manuscript");
const importFormat = byId("import-format");
const formatStatus = byId("format-status");
const resume = byId("resume");
const shelf = byId("bookshelf");
const importer = byId("importer");
const bookList = byId("book-list");
const shelfEmpty = byId("shelf-empty");
const shelfTitle = byId("bookshelf-title");
const archiveToggle = byId("archive-toggle");
const publishBook = byId("publish-book");
const entryNote = byId("entry-note");
const cloudDialog = byId("cloud-dialog");
const cloudServer = byId("cloud-server");
const cloudKey = byId("cloud-key");
const cloudStatus = byId("cloud-status");
const cloudConnect = byId("cloud-connect");
const cloudDisconnect = byId("cloud-disconnect");
const stage = byId("paper");
const controls = byId("reader-controls");
const appearancePanel = byId("appearance");
const appearanceToggle = byId("appearance-toggle");
const fontChoice = byId("reading-font");
const themeChoices = [...document.querySelectorAll("[data-theme-choice]")];
const themeColor = document.querySelector('meta[name="theme-color"]');
const settingsToggle = byId("settings-toggle");
const fullscreen = byId("fullscreen");
const contentsDialog = byId("contents");
const contentsList = byId("contents-list");
const contentsToggle = byId("contents-toggle");
const title = byId("book-title");
const measure = byId("measure");
const pageText = byId("page-text");
const previewText = byId("preview-text");
const smaller = byId("smaller");
const larger = byId("larger");
const previous = byId("previous");
const next = byId("next");
const tapLeft = byId("tap-left");
const tapRight = byId("tap-right");
const singleMode = byId("tap-mode-single");
const doubleMode = byId("tap-mode-double");
const progress = byId("progress");
const percentage = byId("position-label");
const readerNote = byId("reader-note");
const storage = createBookStorage(globalThis.indexedDB);
const officialCloudUrl = "https://liangzai666.com";
const publicClient = ["https://liangzai4322.github.io", "https://appassets.androidplatform.net", officialCloudUrl]
  .includes(location.origin) ? createCloudClient({ url: officialCloudUrl }, { publicShelf: true }) : null;
const fontSizes = [16, 18, 21, 24, 28];
const defaultAppearance = { fontIndex: 1, typeface: "system", theme: "paper" };
const defaultPosition = { offset: 0, fontIndex: defaultAppearance.fontIndex };
const percentFormat = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

let saved;
let session;
let tapMode = "single";
let tapModeChosen = false;
let appearance = defaultAppearance;
let appearanceChanged = false;
let layoutFrame = 0;
let cancelWarmup = () => {};
let catalog = [];
let publicCatalog = [];
let publicDownloads = new Set();
let publicRequest = 0;
let showingArchive = false;
const downloads = new Map();
let cloud;
let syncJob;
let syncTimer;
let nextPullAt = 0;
let loadingBook = false;
let importing = false;
const boot = Promise.all([storage.load(), storage.loadAppearance(), storage.loadCloud(), storage.loadTapMode()]);

const turn = bindPageTurn(stage, {
  front: byId("front"),
  reverse: byId("reverse"),
  shadow: byId("fold-shadow"),
  text: pageText,
  preview(direction) {
    if (!session?.page) return null;
    const page = session.pager.adjacent(session.page, direction);
    if (page) previewText.textContent = session.book.text.slice(page.start, page.end);
    return page;
  },
  commit: showPage,
  tap(x) {
    const center = settingsToggle.getBoundingClientRect();
    if (x < center.left) return tapLeftAction();
    if (x >= center.right) return turnFromTap(1);
    setControls(controls.hidden);
  },
});

function storageFailed() {
  entryNote.textContent = "这台设备暂时无法保存文字和进度。";
  readerNote.textContent = "本机保存失败。保留当前页面可以继续阅读。";
  readerNote.hidden = false;
}

function hasShelf() {
  return Boolean(publicClient || catalog.length);
}

function managesPublicShelf() {
  return Boolean(publicClient && cloud?.url === officialCloudUrl);
}

function setShelfVisible(show) {
  shelf.hidden = !show;
  importer.hidden = show;
  byId("cancel-import").hidden = !hasShelf();
}

function renderShelf() {
  const visitor = publicClient && !cloud;
  const books = new Map();
  for (const book of catalog) {
    if (Boolean(book.archived) === showingArchive && !(visitor && book.published)) books.set(book.id, book);
  }
  if (visitor) {
    for (const book of publicCatalog) books.set(book.id, { ...book, cached: publicDownloads.has(book.id) });
  }
  const items = [...books.values()].sort((first, second) => second.createdAt - first.createdAt).map((book) => {
    const row = document.createElement("li");
    const open = document.createElement("button");
    open.className = "book-open";
    open.type = "button";
    open.dataset.bookId = book.id;
    const name = document.createElement("span");
    name.className = "book-name";
    name.textContent = book.title;
    const progress = document.createElement("span");
    progress.className = "book-progress";
    if (book.pendingPublication && cloud) progress.textContent = "待公开";
    else if (book.pendingUpload && cloud) progress.textContent = "待同步";
    else if (!book.cached && book.bytes > AUTO_DOWNLOAD_BYTES) progress.textContent = "下载并阅读";
    else if (book.offset) progress.textContent = "读过";
    open.append(name, progress);
    row.append(open);
    if (managesPublicShelf() && !book.pendingUpload) {
      const action = document.createElement("button");
      action.className = "quiet book-action";
      action.type = "button";
      action.dataset.shelfBook = book.id;
      action.dataset.shelfAction = !book.published ? "publish" : book.archived ? "restore" : "archive";
      action.textContent = { publish: "公开上架", restore: "恢复到书架", archive: "归档" }[action.dataset.shelfAction];
      action.setAttribute("aria-label", action.textContent + "《" + book.title + "》");
      row.append(action);
    }
    return row;
  });
  bookList.replaceChildren(...items);
  shelfTitle.textContent = showingArchive ? "归档" : "书架";
  archiveToggle.textContent = showingArchive ? "回书架" : "归档";
  archiveToggle.hidden = !(visitor || managesPublicShelf());
  publishBook.hidden = !managesPublicShelf();
  shelfEmpty.textContent = showingArchive ? "归档里还没有书。" : "书架上还没有书。";
  shelfEmpty.hidden = items.length > 0;
  byId("cancel-import").hidden = !hasShelf();
}

async function refreshShelf() {
  const firstBooks = !catalog.length;
  catalog = await storage.listBooks();
  renderShelf();
  if (!publicClient && firstBooks && catalog.length && !field.value && !entry.hidden) setShelfVisible(true);
}

function downloadBook(client, id, isPublic) {
  const key = (isPublic ? "public/" : cloud.url + "/") + id;
  if (downloads.has(key)) return downloads.get(key);
  const connection = cloud;
  const job = client.get(id).then(async (book) => {
    if (isPublic) {
      await storage.cachePublicBody(book);
      publicDownloads.add(id);
    } else if (connection === cloud) {
      await storage.cacheRemote(book);
    }
    return book;
  }).finally(() => downloads.delete(key));
  downloads.set(key, job);
  return job;
}

async function cacheSmallBooks(books, client, isPublic, current) {
  let downloaded = false;
  for (const book of books) {
    if (document.hidden || !current()) break;
    if (book.bytes > AUTO_DOWNLOAD_BYTES || (isPublic ? publicDownloads.has(book.id) : book.cached)) continue;
    try {
      await downloadBook(client, book.id, isPublic);
      downloaded = true;
    } catch {
      break;
    }
  }
  if (downloaded && current() && !entry.hidden) {
    if (isPublic) renderShelf();
    else await refreshShelf();
  }
}

async function refreshPublicShelf() {
  if (!publicClient || cloud) return;
  const request = ++publicRequest;
  const archived = showingArchive;
  const isCurrent = () => request === publicRequest && !cloud && archived === showingArchive;
  try {
    const [cached, ids] = await Promise.all([storage.loadPublicShelf(archived), storage.listPublicDownloads()]);
    if (!isCurrent()) return;
    publicCatalog = cached || [];
    publicDownloads = new Set(ids);
    renderShelf();
    const books = [];
    let after = "";
    do {
      const page = await publicClient.list(after, archived);
      if (!isCurrent()) return;
      books.push(...page.books);
      after = page.next;
    } while (after);
    publicCatalog = books;
    renderShelf();
    await storage.savePublicShelf(archived, books);
    if (!isCurrent()) return;
    status("");
    await cacheSmallBooks(books, publicClient, true, isCurrent);
  } catch {
    if (isCurrent()) status("暂时无法刷新公开书架。已下载的书仍可阅读。");
  }
}

function status(message) {
  cloudStatus.textContent = message;
  entryNote.textContent = message;
}

function syncError(error) {
  if (error.code === "invalid_pairing_pin") return "配对码不正确。";
  if (error.code === "pairing_rate_limited") return "配对尝试过多，请稍后再试。";
  if (error.code === "pairing_disabled" || error.code === "not_found") return "请检查服务器地址和版本。";
  return [401, 403].includes(error.status)
    ? "同步密钥或访问权限不正确。"
    : "暂时无法同步。恢复连接后会重试。";
}

async function syncNow() {
  if (!cloud || syncJob) return syncJob;
  const client = createCloudClient(cloud);
  syncJob = (async () => {
    status("正在同步…");
    try {
      const pull = Date.now() >= nextPullAt;
      const deferred = await syncLibrary(storage, client, { pull });
      if (pull) nextPullAt = Date.now() + 30000;
      if (!entry.hidden) {
        await refreshShelf();
        if (pull) {
          const connection = cloud;
          const archived = showingArchive;
          const books = catalog.filter((book) => Boolean(book.archived) === archived);
          cacheSmallBooks(books, client, false, () => cloud === connection && showingArchive === archived).catch(storageFailed);
        }
      }
      status(deferred ? "部分文章等待同步，请检查文章大小或上传状态。" : "云端已同步");
    } catch (error) {
      status(syncError(error));
    } finally {
      syncJob = undefined;
    }
  })();
  return syncJob;
}

function refreshCloud() {
  if (!cloud) {
    refreshPublicShelf();
    return;
  }
  nextPullAt = 0;
  scheduleSync(0);
}

function scheduleSync(delay = 900) {
  clearTimeout(syncTimer);
  if (!cloud) return;
  syncTimer = setTimeout(() => {
    if (syncJob) scheduleSync();
    else syncNow();
  }, delay);
}

async function readBook(id) {
  if (loadingBook) return;
  loadingBook = true;
  try {
    const published = !cloud && publicCatalog.find((book) => book.id === id);
    if (published) {
      const body = await storage.getPublicBody(id);
      const source = body ?? (await downloadBook(publicClient, id, true)).text;
      openReader({ book: { ...published, source } }, false);
      return;
    }
    const client = cloud && createCloudClient(cloud);
    let record = await storage.getBook(id);
    if (!record && client) {
      await downloadBook(client, id, false);
      record = await storage.getBook(id);
    }
    if (!record) {
      status("这篇文章尚未下载。连接云端后再打开。");
      return;
    }
    await storage.rememberBook(id);
    saved = record;
    openReader(record);
    const item = catalog.find((book) => book.id === id);
    if (client && item?.published && !item.archived) {
      client.shelfAction(id, "read").catch(() => {});
    }
    scheduleSync();
  } catch (error) {
    if (error.code === "book_not_found") status("这本书现在无法打开，请刷新书架。");
    else status(syncError(error));
  } finally {
    loadingBook = false;
  }
}

function setControls(open) {
  if (!open && contentsDialog.open) contentsDialog.close();
  if (!open && controls.contains(document.activeElement)) settingsToggle.focus({ preventScroll: true });
  if (!open) setAppearancePanel(false);
  controls.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
}

function setAppearancePanel(open) {
  appearancePanel.hidden = !open;
  appearanceToggle.setAttribute("aria-expanded", String(open));
}

function openContents() {
  const { chapters, page, initialOffset } = session;
  const position = page?.start ?? initialOffset;
  const rootLevel = chapters.reduce((level, chapter) => Math.min(level, chapter.level), 6);
  const items = document.createDocumentFragment();
  let current;
  for (const [index, chapter] of chapters.entries()) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet";
    button.dataset.chapter = String(index);
    button.textContent = chapter.title;
    button.style.setProperty("--chapter-indent", chapter.level - rootLevel);
    if (chapter.offset <= position && (chapters[index + 1]?.offset ?? Infinity) > position) {
      button.setAttribute("aria-current", "location");
      current = button;
    }
    item.append(button);
    items.append(item);
  }
  contentsList.replaceChildren(items);
  contentsDialog.showModal();
  if (current) current.scrollIntoView({ block: "nearest" });
}

function setFullscreen(active) {
  reader.classList.toggle("is-fullscreen", active);
  fullscreen.textContent = active ? "退出全屏" : "全屏";
  scheduleReflow();
}

function leaveFullscreen() {
  if (document.fullscreenElement === document.documentElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    setFullscreen(false);
  }
}

function warmNextPage() {
  cancelWarmup();
  const { pager, page } = session;
  const warm = () => pager.adjacent(page, 1);
  if ("requestIdleCallback" in window) {
    const handle = requestIdleCallback(warm, { timeout: 140 });
    cancelWarmup = () => cancelIdleCallback(handle);
  } else {
    const handle = setTimeout(warm, 30);
    cancelWarmup = () => clearTimeout(handle);
  }
}

function displayProgress(tenths) {
  const label = tenths === 1000 ? "末页" : percentFormat.format(tenths / 1000);
  percentage.textContent = label;
  progress.style.setProperty("--progress-fill", (tenths / 10) + "%");
  progress.setAttribute("aria-valuetext", label);
}

function updateTapActions() {
  const single = tapMode === "single";
  tapLeft.setAttribute("aria-label", single ? "下一页" : "上一页");
  tapLeft.setAttribute("aria-disabled", String(single ? next.disabled : previous.disabled));
  tapRight.setAttribute("aria-disabled", String(next.disabled));
}

function setTapMode(mode) {
  tapMode = mode === "double" ? "double" : "single";
  singleMode.setAttribute("aria-pressed", String(tapMode === "single"));
  doubleMode.setAttribute("aria-pressed", String(tapMode === "double"));
  updateTapActions();
}

function chooseTapMode(mode) {
  tapModeChosen = true;
  setTapMode(mode);
  storage.saveTapMode(tapMode).catch(storageFailed);
}

function turnFromTap(direction) {
  if ((direction === 1 ? next : previous).disabled) return;
  setControls(false);
  turn.shift(direction);
}

function tapLeftAction() {
  turnFromTap(tapMode === "single" ? 1 : -1);
}

function showPage(page, trackProgress = true) {
  const { book, persist } = session;
  session.page = page;
  pageText.textContent = book.text.slice(page.start, page.end);
  const last = page.end === book.text.length;
  const tenths = last ? 1000 : Math.min(999, Math.floor(1000 * page.start / book.text.length));
  previous.disabled = page.start === 0;
  next.disabled = last;
  updateTapActions();
  progress.disabled = page.start === 0 && last;
  progress.value = String(tenths);
  displayProgress(tenths);
  stage.setAttribute("aria-busy", "false");
  if (persist) {
    const position = { offset: page.start, fontIndex: appearance.fontIndex };
    saved = { book, position };
    if (trackProgress) storage.savePosition(book.id, position).then(() => scheduleSync()).catch(storageFailed);
  }
  warmNextPage();
}

function fitsOnPage(text, start, end) {
  measure.textContent = text.slice(start, end);
  return measure.scrollHeight <= measure.clientHeight;
}

function reflow(anchor, { force = false, trackProgress = false } = {}) {
  if (!session) return;
  const width = measure.clientWidth;
  const height = measure.clientHeight;
  if (!width || !height) return;
  const layout = [width, height, appearance.fontIndex, appearance.typeface].join("/");
  if (session.layout === layout && !force) return;
  cancelWarmup();
  turn.clear();
  const { text } = session.book;
  session.layout = layout;
  session.pager = createPager(text, (start, end) => fitsOnPage(text, start, end));
  showPage(session.pager.at(anchor), trackProgress);
}

function scheduleReflow() {
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    if (session) reflow(session.page?.start ?? session.initialOffset);
  });
}

function applyAppearance() {
  const { fontIndex, typeface, theme } = appearance;
  const root = document.documentElement;
  if (reader.hidden) delete root.dataset.readerTheme;
  else root.dataset.readerTheme = theme;
  themeColor.content = getComputedStyle(root).getPropertyValue("--desk").trim();
  reader.dataset.typeface = typeface;
  reader.style.setProperty("--reading-size", fontSizes[fontIndex] + "px");
  fontChoice.value = typeface;
  smaller.disabled = fontIndex === 0;
  larger.disabled = fontIndex === fontSizes.length - 1;
  for (const option of themeChoices) {
    option.setAttribute("aria-pressed", String(option.dataset.themeChoice === theme));
  }
}

function changeAppearance(changes) {
  appearance = { ...appearance, ...changes };
  appearanceChanged = true;
  applyAppearance();
  storage.saveAppearance(appearance).catch(storageFailed);
  if (session?.page) reflow(session.page.start);
}

function restoredAppearance(record, position) {
  const fontIndex = record?.fontIndex ?? position?.fontIndex;
  return {
    fontIndex: Number.isInteger(fontIndex) && fontSizes[fontIndex] ? fontIndex : defaultAppearance.fontIndex,
    typeface: [...fontChoice.options].some((option) => option.value === record?.typeface)
      ? record.typeface : defaultAppearance.typeface,
    theme: themeChoices.some((option) => option.dataset.themeChoice === record?.theme)
      ? record.theme : defaultAppearance.theme,
  };
}

function openReader({ book, position = defaultPosition }, persist = true, rendered = null) {
  rendered ??= readingText(book.source ?? book.text, book.format || "plain");
  session = {
    book: { ...book, text: rendered.text }, persist,
    initialOffset: position.offset, chapters: rendered.chapters ?? [],
  };
  contentsToggle.hidden = !session.chapters.length;
  title.textContent = book.title || titleFrom(rendered.text);
  setControls(false);
  entry.hidden = true;
  reader.hidden = false;
  stage.setAttribute("aria-busy", "true");
  applyAppearance();
  scheduleReflow();
  stage.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function openEditor() {
  turn.clear();
  cancelWarmup();
  leaveFullscreen();
  session = undefined;
  pageText.textContent = "";
  previewText.textContent = "";
  measure.textContent = "";
  resume.hidden = !saved;
  reader.hidden = true;
  entry.hidden = false;
  applyAppearance();
  setShelfVisible(hasShelf());
  refreshShelf().catch(storageFailed);
  refreshCloud();
}

function changeFont(direction) {
  if (!session?.page) return;
  const fontIndex = appearance.fontIndex + direction;
  if (!fontSizes[fontIndex]) return;
  changeAppearance({ fontIndex });
}

function seek(tenths) {
  if (!session?.page) return;
  const offset = Math.floor(session.book.text.length * tenths / 1000);
  reflow(offset, { force: true, trackProgress: true });
}

function clearFormatStatus() {
  field.setCustomValidity("");
  formatStatus.textContent = "";
}

field.addEventListener("input", clearFormatStatus);
importFormat.addEventListener("change", () => { formatStatus.textContent = ""; });
byId("detect-format").addEventListener("click", () => {
  if (!field.value.trim()) {
    formatStatus.textContent = "请先粘贴正文。";
    field.focus();
    return;
  }
  const { format } = readingText(field.value, "auto");
  importFormat.value = format;
  formatStatus.textContent = format === "markdown" ? "已识别 Markdown" : "已选纯文本";
});
field.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain");
  if (!text || text.length < 32_768) return;
  event.preventDefault();
  // Large clipboard payloads can stall the browser's default edit command.
  field.setRangeText(normalizeText(text), field.selectionStart, field.selectionEnd, "end");
  clearFormatStatus();
});
byId("edit").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (importing) return;
  const text = normalizeText(field.value);
  const format = importFormat.value;
  const publish = event.submitter === publishBook && managesPublicShelf();
  if (!/\S/.test(text)) {
    field.setCustomValidity("请粘贴想读的文字。");
    field.reportValidity();
    return;
  }
  importing = true;
  field.readOnly = true;
  if (event.submitter) event.submitter.disabled = true;
  try {
    await boot.catch(() => {});
    const id = globalThis.crypto?.randomUUID?.() ?? Date.now() + "-" + Math.random();
    const rendered = readingText(text, format);
    const book = { id, source: rendered.source, format: rendered.format,
      title: titleFrom(rendered.text), createdAt: Date.now() };
    const position = { offset: 0, fontIndex: appearance.fontIndex };
    try {
      await storage.saveBook(book, position, publish);
      field.value = "";
      importFormat.value = "plain";
      formatStatus.textContent = "";
      saved = { book, position };
      refreshShelf().catch(storageFailed);
      scheduleSync();
      openReader(saved, true, rendered);
    } catch {
      storageFailed();
      openReader({ book, position }, false, rendered);
    }
  } finally {
    importing = false;
    field.readOnly = false;
    if (event.submitter) event.submitter.disabled = false;
  }
});

resume.addEventListener("click", () => { if (saved) readBook(saved.book.id); });
byId("new-book").addEventListener("click", () => {
  setShelfVisible(false);
  field.focus();
});
byId("cancel-import").addEventListener("click", () => setShelfVisible(true));
archiveToggle.addEventListener("click", () => {
  showingArchive = !showingArchive;
  publicCatalog = [];
  renderShelf();
  refreshCloud();
});
bookList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-book-id], [data-shelf-action]");
  if (!button) return;
  if (button.dataset.bookId) {
    readBook(button.dataset.bookId);
    return;
  }
  if (!managesPublicShelf()) return;
  button.disabled = true;
  const action = button.dataset.shelfAction;
  try {
    if (action === "publish" && !window.confirm("这本书的标题和正文将公开。确定上架？")) return;
    const book = await createCloudClient(cloud).shelfAction(button.dataset.shelfBook, action);
    await storage.mergeRemote([book]);
    await refreshShelf();
  } catch (error) {
    status(syncError(error));
  } finally {
    button.disabled = false;
  }
});

byId("cloud-toggle").addEventListener("click", () => {
  cloudServer.value = cloud?.url || (publicClient ? officialCloudUrl : "");
  cloudKey.value = "";
  cloudDisconnect.hidden = !cloud;
  cloudDialog.showModal();
});
byId("cloud-close").addEventListener("click", () => cloudDialog.close());
cloudServer.addEventListener("input", () => cloudServer.setCustomValidity(""));
cloudKey.addEventListener("input", () => cloudKey.setCustomValidity(""));
byId("cloud-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = cloudAddress(cloudServer.value);
  if (!url) {
    cloudServer.setCustomValidity("请填写 HTTPS 服务器地址。");
    cloudServer.reportValidity();
    return;
  }
  const value = cloudKey.value.trim();
  const pairing = /^[0-9]{6}$/.test(value);
  if (!pairing && value.length < 32) {
    cloudKey.setCustomValidity("请输入六位配对码或完整同步密钥。");
    cloudKey.reportValidity();
    return;
  }
  cloudConnect.disabled = cloudDisconnect.disabled = true;
  try {
    if (syncJob) await syncJob;
    const candidate = { url, token: pairing ? await createCloudClient({ url }).pair(value) : value };
    await createCloudClient(candidate).list();
    await storage.saveCloud(candidate);
    cloud = candidate;
    showingArchive = false;
    publicCatalog = [];
    nextPullAt = 0;
    cloudDisconnect.hidden = false;
    await syncNow();
  } catch (error) {
    cloudStatus.textContent = syncError(error);
  } finally {
    cloudConnect.disabled = cloudDisconnect.disabled = false;
  }
});
cloudDisconnect.addEventListener("click", async () => {
  cloudConnect.disabled = cloudDisconnect.disabled = true;
  try {
    if (syncJob) await syncJob;
    await storage.saveCloud(null);
    cloud = null;
    showingArchive = false;
    cloudKey.value = "";
    cloudDisconnect.hidden = true;
    status("");
    await refreshShelf();
    refreshPublicShelf();
  } catch {
    storageFailed();
  } finally {
    cloudConnect.disabled = cloudDisconnect.disabled = false;
  }
});
window.addEventListener("online", refreshCloud);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshCloud();
});

byId("back").addEventListener("click", openEditor);
smaller.addEventListener("click", () => changeFont(-1));
larger.addEventListener("click", () => changeFont(1));
appearanceToggle.addEventListener("click", () => setAppearancePanel(appearancePanel.hidden));
fontChoice.addEventListener("change", () => changeAppearance({ typeface: fontChoice.value }));
for (const option of themeChoices) {
  option.addEventListener("click", () => changeAppearance({ theme: option.dataset.themeChoice }));
}
previous.addEventListener("click", () => turn.shift(-1));
next.addEventListener("click", () => turn.shift(1));
tapLeft.addEventListener("click", tapLeftAction);
tapRight.addEventListener("click", () => turnFromTap(1));
singleMode.addEventListener("click", () => chooseTapMode("single"));
doubleMode.addEventListener("click", () => chooseTapMode("double"));
settingsToggle.addEventListener("click", () => setControls(controls.hidden));
contentsToggle.addEventListener("click", openContents);
contentsList.addEventListener("click", (event) => {
  const choice = event.target.closest("[data-chapter]");
  const chapter = choice && session?.chapters[Number(choice.dataset.chapter)];
  if (!chapter) return;
  setControls(false);
  reflow(chapter.offset, { force: true, trackProgress: true });
  stage.focus({ preventScroll: true });
});
fullscreen.addEventListener("click", () => {
  setControls(false);
  if (reader.classList.contains("is-fullscreen")) {
    leaveFullscreen();
    return;
  }
  setFullscreen(true);
  if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
});
document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === document.documentElement;
  if (active && reader.hidden) leaveFullscreen();
  else setFullscreen(active);
});
progress.addEventListener("input", () => displayProgress(Number(progress.value)));
progress.addEventListener("change", () => seek(Number(progress.value)));
byId("sample").addEventListener("click", () => {
  openReader({ book: { id: "sample", text: sample } }, false);
});

document.addEventListener("keydown", (event) => {
  if (reader.hidden || contentsDialog.open || event.altKey || event.ctrlKey || event.metaKey
      || event.shiftKey || turn.hasTextSelection()) return;
  if ((event.target === progress || event.target === fontChoice) && event.key !== "Escape") return;
  switch (event.key) {
    case "ArrowLeft": turn.shift(-1); break;
    case "ArrowRight": turn.shift(1); break;
    case "Home": seek(0); break;
    case "End": seek(1000); break;
    case "Enter":
      if (event.target !== stage) return;
      setControls(controls.hidden);
      break;
    case "Escape":
      if (!appearancePanel.hidden) {
        setAppearancePanel(false);
        appearanceToggle.focus();
      } else if (!controls.hidden) setControls(false);
      else if (reader.classList.contains("is-fullscreen")) leaveFullscreen();
      else return;
      break;
    default: return;
  }
  event.preventDefault();
});

const layoutObserver = new ResizeObserver(scheduleReflow);
layoutObserver.observe(measure);

document.fonts?.addEventListener("loadingdone", () => {
  if (session?.page) reflow(session.page.start, { force: true });
});

if (location.origin === "https://appassets.androidplatform.net") {
  for (const updateLink of document.querySelectorAll("[data-native-update]")) updateLink.hidden = false;
}

boot.then(async ([record, storedAppearance, connection, mode]) => {
  if (!tapModeChosen) setTapMode(mode);
  if (!appearanceChanged) {
    appearance = restoredAppearance(storedAppearance, record?.position);
    applyAppearance();
    if (session) scheduleReflow();
  }
  if (record && !saved) {
    saved = record;
    resume.hidden = false;
  }
  if (connection?.url && connection?.token) cloud = connection;
  await refreshShelf();
  if (publicClient && !field.value && !entry.hidden) setShelfVisible(true);
  refreshCloud();
}).catch(storageFailed);

setInterval(() => { if (!document.hidden) syncNow(); }, 30000);

const sample = [
  "窗边的下午",
  "停雨的时候，图书馆的窗台先亮了起来。我把垫在窗缝里的纸抽出来，风便从院子那棵树底下一路吹进来。对面有人把书合上，隔着一张长桌，我听见了纸页落下的声音。",
  "我常在靠窗的位置读书。那里的椅子比别处矮一点，桌沿也被磨得发白。坐下时只要把左边的手肘搭在桌边，眼前的书就有一点自然的斜度，像是有人替我扶着。",
  "管理员下午会来一趟，把没有归还到书架上的书叠齐。他不急着问是谁借的，只把夹在里面的借书单压平。借书单上有几行很浅的字迹，名字已经看不清了，日期却还在。",
  "有时夹在书里的东西比书更容易记住。一片槐树叶，一张已经褪色的车票，还有人写到一半的购物单。购物单上列了葱、面包和一只新的灯泡，最后一行是空着的。",
  "这天我读的是一本关于潮汐的书。它写到有一整年，作者住在一间能看见码头的房子里。每天涨潮前半个钟头，系船的绳索先松下来。等到绳子重新拉紧，他才记下那天的水位。",
  "我第一次读到这里时，总想知道第二天到底出了什么事。再读一遍，倒是留意到他每天坐的是同一把椅子。潮水从不会在同一个时刻到来，他却有大把的时间坐在那里等待。",
  "窗外有人沿着院墙慢慢走过去，手上拎着一把没收好的伞。伞尖擦过墙下一丛草，抖落几滴水。等他走远，另一扇窗里传来一声轻轻的咳嗽。",
  "天色渐暗，我把书向灯下移了一点。纸页的左边亮了，右边陷进一小块阴影。翻到下一页的时候，我扶住页角停了一下，看见桌面上有一道浅浅的光正随着纸张移动。",
  "我决定把剩下的几页留到明天。有些书等着人给出答案，有些书只要在桌上多放一晚。离开的时候，我把书签往里面推了半寸，记下读到的那一行。",
  "走到门外才发现，院子里的水已经退到石阶以下。青石还是湿的，一小块天光留在最浅的地方，随着风轻轻晃了一下。",
].join("\n\n");
