import { Lexer } from "./vendor/marked.js";
import { normalizeText } from "./pagination.js";

const blockClue = /^ {0,3}(?:#{1,6}[ \t]+\S|>\s*\S|[\x60~]{3,}|[-+*]\s+\S|\d{1,9}[.)]\s+\S|[-*_]{3,}\s*$|\|.+\||(?:=+|-+)\s*$)/m;
const inlineClue = /[*_~\x60]|\[[^\][\n]{1,256}\][([]/;
const markdownKinds = new Set(["heading", "blockquote", "list", "table", "hr", "strong", "em", "del", "codespan", "image"]);

function hasFormatting(tokens) {
  return tokens.some((token) => markdownKinds.has(token.type)
    || (token.type === "code" && /^[ \t]{0,3}[\x60~]{3}/.test(token.raw))
    || (token.type === "link" && token.raw.startsWith("["))
    || (token.tokens && hasFormatting(token.tokens)));
}

function inline(tokens, fallback = "") {
  if (!tokens) return fallback;
  return tokens.map((token) => {
    if (token.type === "br") return "\n";
    if (token.type === "checkbox") return "";
    if (token.tokens) return inline(token.tokens, token.text);
    return token.text ?? token.raw ?? "";
  }).join("");
}

function readableBlocks(tokens) {
  return tokens.map((token) => {
    switch (token.type) {
      case "space":
      case "def":
      case "hr":
      case "checkbox":
        return "";
      case "code":
        return token.text;
      case "blockquote":
        return readableBlocks(token.tokens);
      case "list":
        return token.items.map((item, index) => {
          const marker = item.task ? (item.checked ? "☑" : "☐")
            : token.ordered ? Number(token.start) + index + "." : "•";
          return marker + " " + readableBlocks(item.tokens).replace(/\n/g, "\n  ");
        }).join("\n");
      case "table":
        return [token.header, ...token.rows]
          .map((row) => row.map((cell) => inline(cell.tokens, cell.text)).join(" │ "))
          .join("\n");
      default:
        return inline(token.tokens, token.text ?? token.raw);
    }
  }).filter(Boolean).join("\n\n");
}

export function readingText(input, format = "auto") {
  const source = normalizeText(input);
  if (format === "plain" || (format === "auto" && !blockClue.test(source) && !inlineClue.test(source))) {
    return { source, text: source, format: "plain" };
  }
  try {
    const tokens = Lexer.lex(source, { gfm: true });
    if (format === "markdown" || hasFormatting(tokens)) {
      return { source, text: readableBlocks(tokens).trim() || source, format: "markdown" };
    }
  } catch {
    // Keep the source readable if the document exceeds the parser's nesting limit.
  }
  return { source, text: source, format: "plain" };
}

export function titleFrom(text) {
  return (text.trim().split("\n", 1)[0] || "未命名").trim().slice(0, 120);
}
