import { createPager, normalizeText } from "./pagination.js";
import { bindPageTurn } from "./page-turn.js?v=4";
import { createBookStorage } from "./storage.js?v=3";

const byId = (id) => document.getElementById(id);
const entry = byId("entry");
const reader = byId("reader");
const field = byId("manuscript");
const resume = byId("resume");
const stage = byId("paper");
const controls = byId("reader-controls");
const settingsToggle = byId("settings-toggle");
const fullscreen = byId("fullscreen");
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
const fontSizes = [16, 18, 21, 24, 28];
const defaultPosition = { offset: 0, fontIndex: 1 };
const percentFormat = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

let saved;
let session;
let tapMode;
let layoutFrame = 0;
let cancelWarmup = () => {};

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
  byId("entry-note").textContent = "这台设备暂时无法保存文字和进度。";
  readerNote.textContent = "本机保存失败。保留当前页面可以继续阅读。";
  readerNote.hidden = false;
}

function setControls(open) {
  if (!open && controls.contains(document.activeElement)) settingsToggle.focus({ preventScroll: true });
  controls.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
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
  tapMode = mode === "single" ? "single" : "double";
  singleMode.setAttribute("aria-pressed", String(tapMode === "single"));
  doubleMode.setAttribute("aria-pressed", String(tapMode === "double"));
  updateTapActions();
}

function chooseTapMode(mode) {
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

function showPage(page) {
  const { book, fontIndex, persist } = session;
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
    const position = { offset: page.start, fontIndex };
    saved = { book, position };
    storage.savePosition(book.id, position).catch(storageFailed);
  }
  warmNextPage();
}

function fitsOnPage(text, start, end) {
  measure.textContent = text.slice(start, end);
  return measure.scrollHeight <= measure.clientHeight;
}

function reflow(anchor, force = false) {
  if (!session) return;
  const width = measure.clientWidth;
  const height = measure.clientHeight;
  if (!width || !height) return;
  const layout = [width, height, session.fontIndex].join("/");
  if (session.layout === layout && !force) return;
  cancelWarmup();
  turn.clear();
  const { text } = session.book;
  session.layout = layout;
  session.pager = createPager(text, (start, end) => fitsOnPage(text, start, end));
  showPage(session.pager.at(anchor));
}

function scheduleReflow() {
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    if (session) reflow(session.page?.start ?? session.initialOffset);
  });
}

function updateFont() {
  reader.style.setProperty("--reading-size", fontSizes[session.fontIndex] + "px");
  smaller.disabled = session.fontIndex === 0;
  larger.disabled = session.fontIndex === fontSizes.length - 1;
}

function openReader({ book, position = defaultPosition }, persist = true) {
  session = {
    book, persist,
    initialOffset: position.offset,
    fontIndex: fontSizes[position.fontIndex] ? position.fontIndex : defaultPosition.fontIndex,
  };
  title.textContent = book.text.slice(0, 300).trimStart().split("\n", 1)[0] || "长文";
  setControls(false);
  entry.hidden = true;
  reader.hidden = false;
  stage.setAttribute("aria-busy", "true");
  updateFont();
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
  field.focus({ preventScroll: true });
}

function changeFont(direction) {
  if (!session?.page) return;
  const fontIndex = session.fontIndex + direction;
  if (!fontSizes[fontIndex]) return;
  session.fontIndex = fontIndex;
  updateFont();
  reflow(session.page.start);
}

function seek(tenths) {
  if (!session?.page) return;
  const offset = Math.floor(session.book.text.length * tenths / 1000);
  reflow(offset, true);
}

field.addEventListener("input", () => field.setCustomValidity(""));
field.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain");
  if (!text || text.length < 32_768) return;
  event.preventDefault();
  // Large clipboard payloads can stall the browser's default edit command.
  field.setRangeText(normalizeText(text), field.selectionStart, field.selectionEnd, "end");
  field.setCustomValidity("");
});
byId("edit").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = normalizeText(field.value);
  if (!/\S/.test(text)) {
    field.setCustomValidity("请粘贴想读的文字。");
    field.reportValidity();
    return;
  }
  const id = globalThis.crypto?.randomUUID?.() ?? Date.now() + "-" + Math.random();
  const book = { id, text };
  saved = { book, position: defaultPosition };
  storage.saveBook(book, defaultPosition).catch(storageFailed);
  field.value = "";
  openReader(saved);
});

resume.addEventListener("click", () => { if (saved) openReader(saved); });
byId("back").addEventListener("click", openEditor);
smaller.addEventListener("click", () => changeFont(-1));
larger.addEventListener("click", () => changeFont(1));
previous.addEventListener("click", () => turn.shift(-1));
next.addEventListener("click", () => turn.shift(1));
tapLeft.addEventListener("click", tapLeftAction);
tapRight.addEventListener("click", () => turnFromTap(1));
singleMode.addEventListener("click", () => chooseTapMode("single"));
doubleMode.addEventListener("click", () => chooseTapMode("double"));
settingsToggle.addEventListener("click", () => setControls(controls.hidden));
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
  if (reader.hidden || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || turn.hasTextSelection()) return;
  if (event.target === progress && event.key !== "Escape") return;
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
      if (!controls.hidden) setControls(false);
      else if (reader.classList.contains("is-fullscreen")) leaveFullscreen();
      else return;
      break;
    default: return;
  }
  event.preventDefault();
});

const layoutObserver = new ResizeObserver(scheduleReflow);
layoutObserver.observe(measure);

storage.loadTapMode().then((mode) => {
  if (tapMode === undefined) setTapMode(mode);
}).catch(storageFailed);

storage.load().then((record) => {
  if (!record || saved) return;
  saved = record;
  resume.hidden = false;
  if (!session && !field.value) openReader(saved);
}).catch(storageFailed);

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
