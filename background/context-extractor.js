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

  static async _readFrameText(tabId, frameId) {
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: () => {
          const article = document.querySelector('article') || document.body;
          const clone = article.cloneNode(true);
          clone.querySelectorAll('script,style,nav,footer,header,aside').forEach(el => el.remove());
          return clone.innerText;
        }
      });
      return { ok: true, text: results[0]?.result || '' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  static async getReadableText(tabId, frameId = 0, label = 'Page content:') {
    const result = await ContextExtractor._readFrameText(tabId, frameId);
    return result.ok && result.text ? [{ text: `${label}\n${result.text}` }] : [];
  }

  static async readFrameTextDiagnostic(tabId, frameId, label) {
    const result = await ContextExtractor._readFrameText(tabId, frameId);
    if (!result.ok) return { ok: false, frameId, error: result.error };
    return { ok: true, parts: result.text ? [{ text: `${label}\n${result.text}` }] : [] };
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

  static async getEditableTarget(tabId, frameId = 0, targetElementId = null, strict = false) {
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (menuTargetElementId, executionFrameId) => {
          const isEditable = (el) => {
            if (!el || !(el instanceof Element) || !el.isConnected) return false;
            if (el.isContentEditable) return true;
            if (el.tagName === 'TEXTAREA') return true;
            if (el.tagName === 'INPUT') {
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              return !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'color', 'range'].includes(type);
            }
            return false;
          };
          const normalizeEditableHost = (candidate) => {
            if (!candidate || !(candidate instanceof Element)) return null;
            if (candidate.tagName === 'INPUT' || candidate.tagName === 'TEXTAREA') return candidate;
            // isContentEditable is inherited. Always mark the explicit editor
            // host, not a transient paragraph/DIV rendered inside it.
            const host = candidate.closest?.('[contenteditable]:not([contenteditable="false"])');
            if (host?.isContentEditable) return host;
            return candidate.isContentEditable ? candidate : null;
          };
          // Install a persistent tracker on first use so subsequent right-clicks
          // record the exact target instead of relying on focus heuristics.
          if (!window.__agentcrewFillTracker) {
            window.__agentcrewFillTracker = { target: null };
            document.addEventListener('contextmenu', (e) => {
              const target = normalizeEditableHost(e.target);
              if (isEditable(target)) window.__agentcrewFillTracker.target = target;
            }, true);
          }
          const tracker = window.__agentcrewFillTracker;
          let el = null;
          // Firefox exposes the exact context-menu target to extension scripts.
          // This is authoritative on the first invocation, before our tracker has
          // had a chance to observe a contextmenu event.
          if (menuTargetElementId && globalThis.browser?.menus?.getTargetElement) {
            try { el = browser.menus.getTargetElement(menuTargetElementId); } catch { /* use fallbacks */ }
          }
          el = normalizeEditableHost(el);
          if (!isEditable(el)) el = normalizeEditableHost(tracker?.target);
          if (!isEditable(el)) el = normalizeEditableHost(document.activeElement);
          if (!isEditable(el)) return null;
          // Give the exact element a DOM-visible marker. Unlike focus or an
          // isolated-world variable, this survives the a2a round-trip and lets a
          // later script deterministically find the original field.
          document.querySelectorAll('[data-agentcrew-fill-target]')
            .forEach(candidate => candidate.removeAttribute('data-agentcrew-fill-target'));
          const marker = crypto.randomUUID();
          el.setAttribute('data-agentcrew-fill-target', marker);
          tracker.target = el;
          tracker.marker = marker;
          const ariaLabel = el.getAttribute('aria-label') || '';
          const label = (el.closest('label')?.innerText || '').trim().slice(0, 120) ||
            ariaLabel || el.getAttribute('placeholder') || '';
          return {
            marker,
            frameId: executionFrameId,
            tag: el.tagName,
            editableType: el.isContentEditable ? 'contenteditable' : (el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text')),
            label,
            id: el.id || null,
            name: el.getAttribute('name') || null,
            role: el.getAttribute('role') || null,
            ariaLabel: ariaLabel || null,
            dataTid: el.getAttribute('data-tid') || el.getAttribute('data-testid') || el.getAttribute('data-automation-id') || null,
            placeholder: el.getAttribute('placeholder') || '',
            currentValue: (el.value !== undefined ? String(el.value) : (el.innerText || '')).slice(0, 5000),
            maxLength: el.getAttribute('maxlength') ? Number(el.getAttribute('maxlength')) : null
          };
        },
        args: [targetElementId, frameId]
      });
      const result = results[0]?.result;
      if (result) return result;
      return strict ? { ok: false, error: 'no-editable-target-found', frameId } : null;
    } catch (err) {
      if (strict) {
        return { ok: false, error: 'frame-injection-failed', frameId, message: String(err?.message || err) };
      }
      return null;
    }
  }

  static async fillEditableTarget(tabId, content, targetInfo) {
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [targetInfo?.frameId ?? 0] },
        world: 'MAIN',
        func: async (value, info) => {
          const isEditable = (el) => {
            if (!el || !(el instanceof Element) || !el.isConnected) return false;
            if (el.isContentEditable) return true;
            if (el.tagName === 'TEXTAREA') return true;
            if (el.tagName === 'INPUT') {
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              return !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'color', 'range'].includes(type);
            }
            return false;
          };
          const normalizeEditableHost = (candidate) => {
            if (!candidate || !(candidate instanceof Element)) return null;
            if (candidate.tagName === 'INPUT' || candidate.tagName === 'TEXTAREA') return candidate;
            const host = candidate.closest?.('[contenteditable]:not([contenteditable="false"])');
            if (host?.isContentEditable) return host;
            return candidate.isContentEditable ? candidate : null;
          };
          const editableType = candidate => candidate?.isContentEditable
            ? 'contenteditable'
            : (candidate?.tagName === 'TEXTAREA' ? 'textarea' : (candidate?.type || 'text'));
          const matchesInfo = (candidate) => {
            candidate = normalizeEditableHost(candidate);
            if (!info || !isEditable(candidate)) return false;
            if (info.tag && candidate.tagName !== info.tag) return false;
            if (info.editableType && editableType(candidate) !== info.editableType) return false;

            const identities = [
              [info.id, candidate.id],
              [info.name, candidate.getAttribute('name')],
              [info.dataTid, candidate.getAttribute('data-tid') || candidate.getAttribute('data-testid') || candidate.getAttribute('data-automation-id')],
              [info.ariaLabel, candidate.getAttribute('aria-label')],
              [info.placeholder, candidate.getAttribute('placeholder')]
            ].filter(([expected]) => Boolean(expected));
            if (identities.some(([expected, actual]) => expected !== actual)) return false;

            if (info.role && candidate.getAttribute('role') !== info.role) return false;
            // Never select an arbitrary contenteditable DIV. Require at least one
            // stable identity attribute, or a role+label pair for chat editors.
            return identities.length > 0 || Boolean(info.role && info.label);
          };
          const findTarget = () => {
            if (info?.marker) {
              const marked = document.querySelector(`[data-agentcrew-fill-target="${CSS.escape(info.marker)}"]`);
              const host = normalizeEditableHost(marked);
              if (isEditable(host)) return { element: host, resolvedBy: 'marker' };
            }
            if (info) {
              const candidates = document.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable="false"])');
              for (const candidate of candidates) {
                const host = normalizeEditableHost(candidate);
                if (matchesInfo(host)) {
                  if (info.marker) host.setAttribute('data-agentcrew-fill-target', info.marker);
                  return { element: host, resolvedBy: 'descriptor' };
                }
              }
            }
            const focused = normalizeEditableHost(document.activeElement);
            if (matchesInfo(focused)) {
              if (info?.marker) focused.setAttribute('data-agentcrew-fill-target', info.marker);
              return { element: focused, resolvedBy: 'focus-signature' };
            }
            return null;
          };
          const normalize = text => String(text).replace(/\r\n/g, '\n').trim();
          const readValue = el => el?.isContentEditable
            ? (el.innerText || el.textContent || '')
            : String(el?.value || '');
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

          let resolution = findTarget();
          if (!resolution) return {
            ok: false,
            error: 'no-matching-target-after-rerender',
            world: 'MAIN',
            resolvedBy: 'none',
            expectedTag: info?.tag || null,
            expectedRole: info?.role || null,
            expectedAriaLabel: info?.ariaLabel || null,
            expectedDataTid: info?.dataTid || null
          };
          let el = resolution.element;
          let resolvedBy = resolution.resolvedBy;

          const selectContents = target => {
            target.focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(target);
            selection.removeAllRanges();
            selection.addRange(range);
            return { selection, range };
          };
          const applyValue = async target => {
            target.focus();
            const previousValue = readValue(target);
            if (target.isContentEditable) {
              // Rich editors commonly intercept paste and update their internal
              // document model. Try that before mutating their managed DOM.
              try {
                selectContents(target);
                const clipboardData = new DataTransfer();
                clipboardData.setData('text/plain', value);
                const pasteEvent = new ClipboardEvent('paste', {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  clipboardData
                });
                target.dispatchEvent(pasteEvent);
                await wait(100);
                if (normalize(readValue(target)) === normalize(value)) return 'paste-event';
              } catch { /* continue with native editing command */ }

              try {
                selectContents(target);
                document.execCommand('insertText', false, value);
                await wait(80);
                if (normalize(readValue(target)) === normalize(value)) return 'execCommand-insertText';
              } catch { /* continue with beforeinput/range fallback */ }

              const { selection, range } = selectContents(target);
              let accepted = true;
              try {
                accepted = target.dispatchEvent(new InputEvent('beforeinput', {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  inputType: 'insertFromPaste',
                  data: value
                }));
              } catch { /* apply structured DOM fallback */ }
              if (accepted) {
                range.deleteContents();
                const textNode = document.createTextNode(value);
                range.insertNode(textNode);
                range.setStartAfter(textNode);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
              }
              try {
                target.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  cancelable: false,
                  composed: true,
                  inputType: 'insertFromPaste',
                  data: value
                }));
              } catch {
                target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              }
              await wait(100);
              return accepted ? 'beforeinput-range' : 'beforeinput-consumed';
            }

            const proto = target instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(target, value);
            else target.value = value;

            // React compares the DOM value with this tracker before invoking
            // onChange. Reset it to the previous value so the native input event
            // is observed as a real user-originated change.
            if (target._valueTracker?.setValue) {
              target._valueTracker.setValue(previousValue);
            }
            try {
              target.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                inputType: 'insertReplacementText',
                data: value
              }));
            } catch {
              target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
            }
            target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            return 'native-value-setter';
          };

          let insertionStrategy = await applyValue(el);
          await wait(50);

          // A framework may replace the node during its state update. Resolve the
          // live node again and retry once if the first value was reverted.
          resolution = findTarget();
          let liveEl = resolution?.element || el;
          if (resolution) resolvedBy = resolution.resolvedBy;
          if (normalize(readValue(liveEl)) !== normalize(value)) {
            insertionStrategy += ` -> ${await applyValue(liveEl)}`;
          }

          await wait(300);
          resolution = findTarget();
          if (resolution) {
            liveEl = resolution.element;
            resolvedBy = resolution.resolvedBy;
          }
          const actual = readValue(liveEl);
          const applied = normalize(actual) === normalize(value);
          return {
            ok: applied,
            error: applied ? null : 'value-not-applied-after-framework-update',
            world: 'MAIN',
            resolvedBy,
            insertionStrategy,
            tag: liveEl?.tagName || null,
            expectedLength: String(value).length,
            actualLength: String(actual).length,
            actualValue: String(actual).slice(0, 200)
          };
        },
        args: [content, targetInfo]
      });
      return results[0]?.result || { ok: false, error: 'no-result', world: 'MAIN' };
    } catch (err) {
      return { ok: false, error: err.message, world: 'MAIN' };
    }
  }

  static async showManualInsertAction(tabId, content, targetInfo) {
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [targetInfo?.frameId ?? 0] },
        // Persistent extension UI belongs in the isolated extension world. DOM
        // nodes and trusted click events remain shared with the page, while the
        // listener and clipboard access are not subject to page-world lifecycle.
        func: (value, info) => {
          const normalizeHost = candidate => {
            if (!candidate || !(candidate instanceof Element) || !candidate.isConnected) return null;
            const host = candidate.closest?.('[contenteditable]:not([contenteditable="false"])');
            return host?.isContentEditable ? host : (candidate.isContentEditable ? candidate : null);
          };
          const matchesInfo = candidate => {
            candidate = normalizeHost(candidate);
            if (!candidate || !info) return false;
            if (info.tag && candidate.tagName !== info.tag) return false;
            if (info.role && candidate.getAttribute('role') !== info.role) return false;
            const identities = [
              [info.id, candidate.id],
              [info.dataTid, candidate.getAttribute('data-tid') || candidate.getAttribute('data-testid') || candidate.getAttribute('data-automation-id')],
              [info.ariaLabel, candidate.getAttribute('aria-label')]
            ].filter(([expected]) => Boolean(expected));
            if (identities.some(([expected, actual]) => expected !== actual)) return false;
            return identities.length > 0 || Boolean(info.role && info.label);
          };
          const markerSelector = info?.marker
            ? `[data-agentcrew-fill-target="${CSS.escape(info.marker)}"]`
            : null;
          const resolveTarget = () => {
            const marked = markerSelector ? normalizeHost(document.querySelector(markerSelector)) : null;
            if (marked) return marked;
            for (const candidate of document.querySelectorAll('[contenteditable]:not([contenteditable="false"])')) {
              const host = normalizeHost(candidate);
              if (matchesInfo(host)) {
                if (info?.marker) host.setAttribute('data-agentcrew-fill-target', info.marker);
                return host;
              }
            }
            const focused = normalizeHost(document.activeElement);
            if (matchesInfo(focused)) {
              if (info?.marker) focused.setAttribute('data-agentcrew-fill-target', info.marker);
              return focused;
            }
            return null;
          };
          const target = resolveTarget();
          if (!target) {
            return {
              ok: false,
              error: 'manual-target-not-found',
              expectedTag: info?.tag || null,
              expectedRole: info?.role || null,
              expectedAriaLabel: info?.ariaLabel || null,
              expectedDataTid: info?.dataTid || null
            };
          }

          const overlayId = '__agentcrew-fill-indicator';
          let host = document.getElementById(overlayId);
          // A stale indicator from an older extension build may have a closed or
          // otherwise inaccessible shadow root. Recreate it instead of failing.
          if (host && !host.shadowRoot) {
            host.remove();
            host = null;
          }
          if (!host) {
            host = document.createElement('div');
            host.id = overlayId;
            host.attachShadow({ mode: 'open' });
            document.documentElement.appendChild(host);
          }
          const shadow = host.shadowRoot;
          shadow.innerHTML = `
            <style>
              :host { all: initial; }
              .panel {
                display:flex; align-items:center; gap:8px;
                padding:8px; border-radius:9px; background:#171717; color:#fff;
                box-shadow:0 5px 18px rgba(0,0,0,.32);
                font:600 12px/1.35 system-ui,sans-serif;
                max-width:min(420px,90vw);
              }
              button {
                appearance:none; border:0; border-radius:7px; padding:7px 10px;
                background:#2563eb; color:#fff; cursor:pointer;
                font:600 12px/1 system-ui,sans-serif; white-space:nowrap;
              }
              button:hover { background:#1d4ed8; }
              button:disabled { opacity:.65; cursor:wait; }
              .message { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
              .message.ok { color:#86efac; }
              .message.warn { color:#fde68a; }
              .message.error { color:#fca5a5; }
            </style>
            <div class="panel">
              <button type="button">Insert generated content</button>
              <span class="message">This editor requires a click to insert.</span>
            </div>`;

          const position = () => {
            const liveTarget = resolveTarget();
            if (!liveTarget?.isConnected) return false;
            const rect = liveTarget.getBoundingClientRect();
            const centerX = Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width / 2));
            const showAbove = rect.top >= 58;
            host.style.cssText = [
              'position:fixed',
              `left:${centerX}px`,
              `top:${showAbove ? Math.max(8, rect.top - 8) : Math.min(window.innerHeight - 8, rect.bottom + 8)}px`,
              `transform:${showAbove ? 'translate(-50%,-100%)' : 'translate(-50%,0)'}`,
              'z-index:2147483647',
              'pointer-events:auto'
            ].join(';');
            return true;
          };
          position();

          const button = shadow.querySelector('button');
          const message = shadow.querySelector('.message');
          const normalize = text => String(text).replace(/\r\n/g, '\n').trim();
          const readValue = editor => editor?.innerText || editor?.textContent || '';
          const selectContents = editor => {
            editor.focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            selection.removeAllRanges();
            selection.addRange(range);
          };
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

          button.addEventListener('click', async event => {
            if (!event.isTrusted) return;
            button.disabled = true;
            message.className = 'message';
            message.textContent = 'Inserting...';
            const editor = resolveTarget();
            if (!editor?.isConnected) {
              message.className = 'message error';
              message.textContent = 'The editor is no longer available.';
              button.disabled = false;
              return;
            }

            // This command now runs inside a genuine user click, which model-driven
            // editors may accept even though delayed synthetic events were rejected.
            try {
              selectContents(editor);
              document.execCommand('insertText', false, value);
              await wait(150);
              if (normalize(readValue(editor)) === normalize(value)) {
                message.className = 'message ok';
                message.textContent = 'Inserted';
                button.remove();
                setTimeout(() => host.remove(), 1800);
                return;
              }
            } catch { /* use clipboard fallback */ }

            // Clipboard writing is permitted from this trusted click on secure
            // pages. Keep the target selected so Ctrl/Cmd+V replaces its content.
            try {
              await navigator.clipboard.writeText(value);
              selectContents(editor);
              message.className = 'message warn';
              message.textContent = 'Copied. Press Ctrl/Cmd+V to insert.';
              button.textContent = 'Copy again';
            } catch {
              message.className = 'message error';
              message.textContent = 'Insert blocked. Copy the generated text manually.';
            }
            button.disabled = false;
          });

          return { ok: true, mode: 'trusted-click-isolated' };
        },
        args: [content, targetInfo]
      });
      if (!Array.isArray(results) || results.length === 0) {
        return {
          ok: false,
          error: 'manual-action-no-frame-result',
          frameId: targetInfo?.frameId ?? 0,
          resultCount: Array.isArray(results) ? results.length : null
        };
      }
      return results[0]?.result || {
        ok: false,
        error: 'manual-action-missing-result',
        frameId: targetInfo?.frameId ?? 0,
        resultCount: results.length,
        executionResult: results[0] || null
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  static async showFillIndicator(tabId, state, message, targetInfo) {
    try {
      await browser.scripting.executeScript({
        target: { tabId, frameIds: [targetInfo?.frameId ?? 0] },
        func: (kind, msg, info) => {
          const overlayId = '__agentcrew-fill-indicator';
          let target = null;
          if (info?.marker) {
            for (const candidate of document.querySelectorAll('[data-agentcrew-fill-target]')) {
              if (candidate.getAttribute('data-agentcrew-fill-target') === info.marker) {
                target = candidate;
                break;
              }
            }
          }
          if (!target || !target.isConnected) {
            const staleHost = document.getElementById(overlayId);
            if (staleHost) {
              if (staleHost.__agentcrewCleanup) staleHost.__agentcrewCleanup();
              staleHost.remove();
            }
            return;
          }

          let host = document.getElementById(overlayId);
          if (!host) {
            host = document.createElement('div');
            host.id = overlayId;
            const shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = `
              <style>
                :host { all: initial; }
                .pill {
                  display: flex; align-items: center; gap: 8px;
                  padding: 8px 12px; border-radius: 8px;
                  background: #171717; color: #fff;
                  font: 600 12px/1.35 system-ui, sans-serif;
                  box-shadow: 0 5px 18px rgba(0,0,0,.32);
                  max-width: min(480px, 90vw); white-space: nowrap;
                }
                .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
                .dot.working { background: #60a5fa; animation: pulse 1.1s ease-in-out infinite; }
                .dot.ok { background: #34d399; }
                .dot.error { background: #f87171; }
                .label { white-space: normal; max-height: 2.6em; overflow: hidden; }
                @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
              </style>
              <div class="pill"><div class="dot working"></div><div class="label"></div></div>`;
            document.documentElement.appendChild(host);
          }

          host.__agentcrewTarget = target;

          if (CSS.supports('anchor-name', '--agentcrew-fill') && CSS.supports('position-anchor', '--agentcrew-fill')) {
            const rect = target.getBoundingClientRect();
            const showAbove = rect.top >= 52;
            target.style.anchorName = '--agentcrew-fill';
            host.style.position = 'fixed';
            host.style.positionAnchor = '--agentcrew-fill';
            host.style.left = 'anchor(center)';
            host.style.top = showAbove ? 'auto' : 'anchor(bottom)';
            host.style.bottom = showAbove ? 'anchor(top)' : 'auto';
            host.style.transform = showAbove ? 'translate(-50%, -8px)' : 'translate(-50%, 8px)';
            host.style.zIndex = '2147483647';
            host.style.pointerEvents = 'none';
            if (!host.__agentcrewCleanup) {
              host.__agentcrewCleanup = () => {
                const el = host.__agentcrewTarget;
                if (el && el.style.anchorName === '--agentcrew-fill') el.style.anchorName = '';
              };
            }
          } else {
            const updatePosition = () => {
              const el = host.__agentcrewTarget;
              if (!el || !el.isConnected) return;
              const rect = el.getBoundingClientRect();
              const centerX = Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width / 2));
              const showAbove = rect.top >= 52;
              host.style.cssText = [
                'position:fixed',
                `left:${centerX}px`,
                `top:${showAbove ? Math.max(8, rect.top - 8) : Math.min(window.innerHeight - 8, rect.bottom + 8)}px`,
                `transform:${showAbove ? 'translate(-50%,-100%)' : 'translate(-50%,0)'}`,
                'z-index:2147483647',
                'pointer-events:none'
              ].join(';');
            };
            updatePosition();
            if (!host.__agentcrewCleanup) {
              const onViewportChange = () => updatePosition();
              host.__agentcrewCleanup = () => {
                window.removeEventListener('scroll', onViewportChange, { capture: true });
                window.removeEventListener('resize', onViewportChange);
              };
              window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
              window.addEventListener('resize', onViewportChange);
            }
          }

          const shadow = host.shadowRoot;
          const dot = shadow.querySelector('.dot');
          const label = shadow.querySelector('.label');
          dot.className = `dot ${kind}`;
          label.textContent = msg || '';
          if (host.__agentcrewRemoveTimer) clearTimeout(host.__agentcrewRemoveTimer);
          if (kind === 'ok' || kind === 'error') {
            host.__agentcrewRemoveTimer = setTimeout(() => {
              if (host.__agentcrewCleanup) host.__agentcrewCleanup();
              host.remove();
            }, 3500);
          }
        },
        args: [state, message, targetInfo]
      });
    } catch { /* page navigated or tab closed — safe to ignore */ }
  }
}
