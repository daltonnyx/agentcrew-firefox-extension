// Extracts generated content from an agent's assistant response.
// The agent is instructed to wrap its output in a fenced code block
// labeled `content`, e.g.:
//
//   Here is the generated text:
//   ```content
//   ...
//   ```
//
// Precedence: last ```content``` block -> the only fenced block ->
// raw text when no code fences are present at all.

export function parseContentBlock(text) {
  if (!text) return '';
  const normalized = String(text);

  // 1. Any fenced block explicitly labeled `content` (or `text`); last match wins.
  const labeled = [...normalized.matchAll(/```(?:content|text)\s*\r?\n([\s\S]*?)\r?\n?```/gi)];
  if (labeled.length) {
    const block = labeled[labeled.length - 1][1];
    if (block.trim()) return normalizeBlock(block);
  }

  // 2. Exactly one fenced block (any label) — accept it as the payload.
  const all = [...normalized.matchAll(/```[^\n`]*\r?\n?([\s\S]*?)\r?\n?```/gi)];
  if (all.length === 1 && all[0][1].trim()) return normalizeBlock(all[0][1]);

  // 3. No code fences at all — treat the trimmed response as the content.
  if (!normalized.includes('```')) {
    return normalized.trim();
  }

  // Multiple unlabeled blocks — ambiguous, refuse rather than guess wrong.
  return '';
}

function normalizeBlock(block) {
  return block.replace(/\r\n/g, '\n').trim();
}
