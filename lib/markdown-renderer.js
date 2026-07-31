import './marked.min.js';

const marked = globalThis.marked;

marked.setOptions({
  gfm: true,
  breaks: false
});

/**
 * Render markdown text to safe HTML.
 * Uses the marked parser with GFM enabled (tables, strikethrough, autolinks, etc.).
 */
export function renderMarkdown(text) {
  if (!text) return '';
  const html = marked.parse(text, { async: false });
  // Wrap with paragraph for inline compatibility
  return `<div class="md">${html}</div>`;
}