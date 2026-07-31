import './marked.min.js';

const marked = globalThis.marked;

marked.setOptions({
  gfm: true,
  breaks: false
});

export function renderMarkdown(text) {
  if (!text) return '';
  const html = marked.parse(text, { async: false });
  return `<div class="md">${html}</div>`;
}