const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
const wordCharacter = /[A-Za-z0-9]/;

export function normalizeText(text) {
  return text.replace(/\r\n?/g, "\n");
}

function largestFit(limit, hint, fits) {
  let low = 0;
  let high = Math.min(limit, hint);
  while (fits(high)) {
    if (high === limit) return high;
    low = high;
    high = Math.min(limit, high * 2);
  }
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

function moveOffWord(text, offset, towardAnchor, anchor) {
  if (offset === anchor) return offset;
  let candidate = offset;
  while (wordCharacter.test(text.charAt(candidate - 1)) && wordCharacter.test(text.charAt(candidate))) {
    candidate += towardAnchor;
    if (candidate === anchor || Math.abs(candidate - offset) > 24) return offset;
  }
  return candidate;
}

export function createPager(text, fits) {
  const segments = segmenter?.segment(text);
  const byStart = new Map();
  const byEnd = new Map();
  let hint = 720;

  function boundary(offset, towardEnd = false) {
    if (offset <= 0 || offset >= text.length) return offset;
    const part = segments?.containing(offset);
    if (part) {
      return towardEnd && part.index !== offset ? part.index + part.segment.length : part.index;
    }
    const current = text.charCodeAt(offset);
    const previous = text.charCodeAt(offset - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
      return offset + (towardEnd ? 1 : -1);
    }
    return offset;
  }

  function cut(anchor, direction) {
    const forward = direction === 1;
    const available = forward ? text.length - anchor : anchor;
    const length = largestFit(available, hint, (size) => forward
      ? fits(anchor, anchor + size)
      : fits(anchor - size, anchor));
    let edge = boundary(moveOffWord(text, anchor + direction * length, -direction, anchor), !forward);
    if (edge === anchor) {
      // A single grapheme can exceed the page box at extreme zoom.
      edge = boundary(anchor + direction, forward);
    }
    const page = forward ? { start: anchor, end: edge } : { start: edge, end: anchor };
    byStart.set(page.start, page);
    byEnd.set(page.end, page);
    hint = Math.max(32, page.end - page.start + 32);
    return page;
  }

  return {
    at(offset) {
      if (!text.length) return null;
      const anchor = boundary(Math.min(text.length, Math.max(0, Math.floor(offset) || 0)));
      if (anchor === text.length) return byEnd.get(anchor) ?? cut(anchor, -1);
      return byStart.get(anchor) ?? cut(anchor, 1);
    },
    adjacent(page, direction) {
      if (direction === 1 && page.end < text.length) {
        return byStart.get(page.end) ?? cut(page.end, 1);
      }
      if (direction === -1 && page.start > 0) {
        return byEnd.get(page.start) ?? cut(page.start, -1);
      }
      return null;
    },
  };
}
