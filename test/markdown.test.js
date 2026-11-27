import assert from "node:assert/strict";
import test from "node:test";
import { readingText, titleFrom } from "../docs/js/markdown.js";

test("automatically renders common Markdown into readable selectable text", () => {
  const source = "# 读书小记\n\n**开头**与 *斜体*。\n\n- 一条\n- [x] 已做\n\n> 引用";
  const book = readingText(source);
  assert.equal(book.format, "markdown");
  assert.equal(book.text, "读书小记\n\n开头与 斜体。\n\n• 一条\n☑ 已做\n\n引用");
  assert.equal(book.source, source);
  assert.equal(titleFrom(book.text), "读书小记");
});

test("keeps ordinary technical text as written and protects explicit plain imports", () => {
  const source = "snake_case，2 * 3，https://example.com/a_b，<b>原样</b>\r\n下一段";
  assert.deepEqual(readingText(source), { source: source.replace("\r\n", "\n"),
    text: source.replace("\r\n", "\n"), format: "plain" });
  assert.equal(readingText("# 原样", "plain").text, "# 原样");
});

test("preserves readable links, tables, list numbers and fenced code", () => {
  const source = "3. [文章](https://example.com)\n4. **备注**\n\n|甲|乙|\n|---|---|\n|一|二|\n\n~~~text\n## literal\n~~~";
  const readable = readingText(source, "markdown").text;
  assert.match(readable, /^3\. 文章\n4\. 备注/);
  assert.match(readable, /甲 │ 乙\n一 │ 二/);
  assert.ok(readable.endsWith("## literal"));
});

test("builds a hierarchical Markdown contents with exact offsets into the rendered text", () => {
  const source = [
    "# **起点**", "", "正文🌿。", "", "## 重复标题", "", "段落 🧭。",
    "", "~~~text", "### 代码示例", "~~~", "", "> ## 引用标题",
    "", "### 重复标题", "", "下一节", "------", "", "###### 小节",
  ].join("\n");
  const book = readingText(source);
  assert.equal(book.format, "markdown");
  assert.deepEqual(book.chapters.map(({ level, title }) => [level, title]), [
    [1, "起点"], [2, "重复标题"], [3, "重复标题"], [2, "下一节"], [6, "小节"],
  ]);
  assert.equal(book.chapters[0].offset, 0);
  assert.ok(book.chapters[2].offset > book.text.indexOf("代码示例"));
  for (const chapter of book.chapters) {
    assert.equal(book.text.slice(chapter.offset, chapter.offset + chapter.title.length), chapter.title);
  }
  assert.equal(readingText(source, "plain").chapters, undefined);
});
