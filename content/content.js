// ORPHANED FILE: Not injected via manifest. Available as reference or alternative
// to the inline browser.scripting.executeScript() in context-extractor.js.
// To use, add "content_scripts" to manifest.json.
(() => {
  if (window.__agentcrewContentScript) return;
  window.__agentcrewContentScript = true;

  function getSelection() {
    return window.getSelection().toString();
  }

  function getPageInfo() {
    return { title: document.title, url: window.location.href };
  }

  function getReadableText() {
    const article = document.querySelector('article') || document.body;
    const clone = article.cloneNode(true);
    clone.querySelectorAll('script,style,nav,footer,header,aside').forEach(el => el.remove());
    return clone.innerText.slice(0, 15000);
  }

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_SELECTION') {
      sendResponse(getSelection());
    } else if (msg.type === 'GET_PAGE_INFO') {
      sendResponse(getPageInfo());
    } else if (msg.type === 'GET_READABLE') {
      sendResponse(getReadableText());
    }
  });
})();