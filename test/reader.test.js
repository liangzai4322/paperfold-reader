import assert from "node:assert/strict";
import test from "node:test";
import { createPager, normalizeText } from "../docs/js/pagination.js";
import { foldGeometry } from "../docs/js/page-turn.js";

test("preserves the pasted text and normalizes pasted line endings", () => {
  assert.equal(normalizeText(" 中文\r\n\r\n  <script>字样</script>\r👩🏽‍💻 "), " 中文\n\n  <script>字样</script>\n👩🏽‍💻 ");
});

test("all consecutive pages reproduce the full text, going in either direction", () => {
  const text = "一章\n\n中文 English words 👩🏽‍💻，长数字 12345678901234567890。\n".repeat(1000);
  const fits = (start, end) => end - start <= 67;
  for (const direction of [1, -1]) {
    const pager = createPager(text, fits);
    const pages = [];
    let page = pager.at(direction === 1 ? 0 : text.length);
    while (page) {
      pages.push(page);
      assert.ok(page.end > page.start && fits(page.start, page.end));
      const next = pager.adjacent(page, direction);
      if (next) assert.equal(pager.adjacent(next, -direction), page);
      page = next;
    }
    if (direction === -1) pages.reverse();
    assert.equal(pages.map(({ start, end }) => text.slice(start, end)).join(""), text);
  }
});

test("resumes near the end without having to lay out the preceding pages", () => {
  const text = "风从窗边吹过。".repeat(62500);
  let measured = 0;
  const pager = createPager(text, (start, end) => {
    measured++;
    return end - start <= 350;
  });
  const offset = Math.floor(text.length * 0.9);
  const page = pager.at(offset);
  assert.equal(page.start, offset);
  assert.equal(pager.adjacent(page, -1).end, offset);
  assert.ok(measured < 30);
});

test("keeps graphemes together even when the box cannot hold a whole grapheme", () => {
  const grapheme = "👩🏽‍💻";
  const text = "甲" + grapheme + "乙";
  const pager = createPager(text, (start, end) => end - start <= 1);
  assert.deepEqual(pager.at(3), { start: 1, end: 1 + grapheme.length });
  assert.deepEqual(pager.adjacent(pager.at(text.length), -1), pager.at(3));
  const noFit = createPager("abc", () => false);
  assert.deepEqual(noFit.at(1), { start: 1, end: 2 });
});

test("a crease partitions the leaf and reflects the paper around the moving point", () => {
  const anchor = { x: 360, y: 640 };
  const drag = { x: 160, y: 536 };
  const { front, revealed, reverse } = foldGeometry(360, 640, anchor, drag);
  function area(points) {
    return Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0)) / 2;
  }
  assert.ok(Math.abs(area(front) + area(revealed) - 360 * 640) < 0.001);
  assert.ok(Math.abs(area(revealed) - area(reverse)) < 0.001);
  assert.ok(reverse.some((point) => Math.hypot(point.x - drag.x, point.y - drag.y) < 0.001));
});
