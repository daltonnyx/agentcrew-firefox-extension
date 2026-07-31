export class ContextExtractor {
  static async getSelection(tabId) {
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: () => window.getSelection().toString()
      });
      const text = results[0]?.result;
      return text ? [{ text }] : [];
    } catch {
      return [];
    }
  }

  static async getPageInfo(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      return [{ text: `Page: ${tab.title}\nURL: ${tab.url}` }];
    } catch {
      return [];
    }
  }

  static async getReadableText(tabId) {
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: () => {
          const article = document.querySelector('article') || document.body;
          const clone = article.cloneNode(true);
          clone.querySelectorAll('script,style,nav,footer,header,aside').forEach(el => el.remove());
          return clone.innerText.slice(0, 15000);
        }
      });
      const text = results[0]?.result;
      return text ? [{ text: `Page content:\n${text}` }] : [];
    } catch {
      return [];
    }
  }

  static async getImage(imageUrl, filename, tabId) {
    if (!tabId) return [];
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: (url) => {
          return new Promise((resolve) => {
            // Try fetch first — works for same-origin / permissive CORS
            fetch(url)
              .then(r => r.blob())
              .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
              })
              .catch(() => {
                // Fallback: extract from DOM <img> via canvas
                const imgs = document.querySelectorAll('img');
                for (const img of imgs) {
                  if (img.src === url || img.currentSrc === url) {
                    try {
                      const c = document.createElement('canvas');
                      c.width = img.naturalWidth;
                      c.height = img.naturalHeight;
                      c.getContext('2d').drawImage(img, 0, 0);
                      resolve(c.toDataURL('image/png'));
                      return;
                    } catch { /* canvas taint — fall through */ }
                  }
                }
                // Last resort: fetch from background (will work if host permission granted)
                resolve(null);
              });
          });
        },
        args: [imageUrl]
      });

      const dataUrl = results[0]?.result;
      if (!dataUrl) return [];

      const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
      if (!match) return [];

      const mediaType = match[1];
      const base64 = match[2];
      return [{ raw: base64, filename: filename || 'image.png', mediaType }];
    } catch {
      return [];
    }
  }
}