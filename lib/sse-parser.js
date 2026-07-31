export class SSEParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
    this._eventType = '';
    this._dataLines = [];
  }

  feed(chunk) {
    this.buffer += chunk;

    while (true) {
      let idx = this.buffer.indexOf('\n');
      if (idx === -1) {
        if (this.buffer.endsWith('\r') && this.buffer.length > 0) {
          return;
        }
        break;
      }

      let line;
      if (idx > 0 && this.buffer[idx - 1] === '\r') {
        line = this.buffer.slice(0, idx - 1);
        this.buffer = this.buffer.slice(idx + 1);
      } else {
        line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
      }

      if (line.startsWith('event:')) {
        this._eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // Strip at most one leading space after "data:"
        const payload = line.slice(5);
        this._dataLines.push(payload.startsWith(' ') ? payload.slice(1) : payload);
      } else if (line === '') {
        this._dispatch();
      }
    }
  }

  _dispatch() {
    if (this._dataLines.length === 0) return;
    const data = this._dataLines.join('\n');
    this.onEvent({ type: this._eventType || 'message', data });
    this._eventType = '';
    this._dataLines = [];
  }

  finish() {
    if (this.buffer.length > 0) {
      let line = this.buffer;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith('event:')) {
        this._eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const payload = line.slice(5);
        this._dataLines.push(payload.startsWith(' ') ? payload.slice(1) : payload);
      }
      this.buffer = '';
    }
    this._dispatch();
  }

  reset() {
    this.buffer = '';
    this._eventType = '';
    this._dataLines = [];
  }
}