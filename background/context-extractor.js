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

  static async selectScreenshotRegion(tabId) {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => new Promise((resolve) => {
        const existing = document.getElementById('__agentcrew-region-selector');
        if (existing) existing.remove();

        const host = document.createElement('div');
        host.id = '__agentcrew-region-selector';
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;user-select:none;touch-action:none;';
        const shadow = host.attachShadow({ mode: 'closed' });
        shadow.innerHTML = `
          <style>
            :host { all: initial; }
            .surface { position: fixed; inset: 0; cursor: crosshair; background: rgba(0,0,0,.38); }
            .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 9px 14px;
              border-radius: 8px; background: #171717; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.3);
              font: 600 13px/1.35 system-ui, sans-serif; white-space: nowrap; pointer-events: none; }
            .selection { position: fixed; display: none; border: 2px solid #fff; border-radius: 2px;
              background: transparent; box-shadow: 0 0 0 9999px rgba(0,0,0,.38), 0 0 0 1px rgba(0,0,0,.5);
              pointer-events: none; }
            .size { position: absolute; right: 0; bottom: -28px; padding: 4px 7px; border-radius: 4px;
              background: #171717; color: #fff; font: 500 11px/1 system-ui, sans-serif; white-space: nowrap; }
          </style>
          <div class="surface" role="application" aria-label="Screenshot area selector">
            <div class="hint">Drag to select an area · Esc to cancel</div>
            <div class="selection"><span class="size"></span></div>
          </div>`;

        const surface = shadow.querySelector('.surface');
        const selection = shadow.querySelector('.selection');
        const size = shadow.querySelector('.size');
        let startX = 0;
        let startY = 0;
        let drawing = false;

        const cleanup = (result) => {
          window.removeEventListener('keydown', onKeyDown, true);
          host.remove();
          resolve(result);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cleanup(null);
          }
        };
        const updateSelection = (x, y) => {
          const left = Math.min(startX, x);
          const top = Math.min(startY, y);
          const width = Math.abs(x - startX);
          const height = Math.abs(y - startY);
          selection.style.cssText = `display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
          size.textContent = `${Math.round(width)} × ${Math.round(height)}`;
          return { left, top, width, height };
        };

        surface.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drawing = true;
          startX = event.clientX;
          startY = event.clientY;
          surface.setPointerCapture(event.pointerId);
          updateSelection(startX, startY);
        });
        surface.addEventListener('pointermove', (event) => {
          if (drawing) updateSelection(event.clientX, event.clientY);
        });
        surface.addEventListener('pointerup', (event) => {
          if (!drawing) return;
          event.preventDefault();
          drawing = false;
          const rect = updateSelection(event.clientX, event.clientY);
          if (rect.width < 4 || rect.height < 4) {
            cleanup(null);
            return;
          }
          cleanup({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
          });
        });
        surface.addEventListener('contextmenu', (event) => event.preventDefault());
        window.addEventListener('keydown', onKeyDown, true);
        document.documentElement.appendChild(host);
        host.focus();
      })
    });
    return results[0]?.result || null;
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