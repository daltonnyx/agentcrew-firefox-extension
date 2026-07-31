import { SSEParser } from '../lib/sse-parser.js';

let _reqId = 0;
function nextReqId() {
  return String(++_reqId);
}

function uuid() {
  return crypto.randomUUID();
}

export class A2AClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.bearerToken = config.bearerToken || '';
  }

  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', 'A2A-Version': '1.0', ...extra };
    if (this.bearerToken) {
      h['Authorization'] = `Bearer ${this.bearerToken}`;
    }
    return h;
  }

  async fetchAgents() {
    const res = await fetch(`${this.baseUrl}/agents`, {
      headers: this._headers()
    });
    if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
    return res.json();
  }

  async fetchAgentCard(agentName) {
    const res = await fetch(
      `${this.baseUrl}/${agentName}/.well-known/agent-card.json`,
      { headers: this._headers() }
    );
    if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.status}`);
    return res.json();
  }

  async sendStreamingMessage(agentName, { messageParts, contextId, taskId, outputModes, onEvent }) {
    const id = nextReqId();
    const msgId = `msg_${uuid()}`;

    const params = {
      message: {
        messageId: msgId,
        role: 'ROLE_USER',
        parts: messageParts
      },
      configuration: {
        acceptedOutputModes: outputModes || ['text/plain', 'application/json'],
        returnImmediately: true
      }
    };

    if (contextId) {
      params.message.contextId = contextId;
    }

    if (taskId) {
      params.message.taskId = taskId;
    }

    const body = {
      jsonrpc: '2.0',
      id,
      method: 'SendStreamingMessage',
      params
    };

    return this._streamRequest(agentName, body, onEvent);
  }

  async subscribeToTask(agentName, taskId, onEvent) {
    const id = nextReqId();
    const body = {
      jsonrpc: '2.0',
      id,
      method: 'SubscribeToTask',
      params: { id: taskId }
    };

    return this._streamRequest(agentName, body, onEvent);
  }

  async getTask(agentName, taskId) {
    const id = nextReqId();
    const body = {
      jsonrpc: '2.0',
      id,
      method: 'GetTask',
      params: { id: taskId }
    };
    const res = await fetch(`${this.baseUrl}/${agentName}/`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GetTask HTTP ${res.status}: ${text}`);
    }
    const json = await res.json();
    if (json.error) {
      const err = new Error(`GetTask failed: ${json.error.message || JSON.stringify(json.error)}`);
      err.code = json.error.code;
      err.data = json.error.data;
      throw err;
    }
    return json.result;
  }

  async cancelTask(agentName, taskId) {
    const id = nextReqId();
    const res = await fetch(`${this.baseUrl}/${agentName}/`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'CancelTask',
        params: { id: taskId }
      })
    });
    if (!res.ok) throw new Error(`CancelTask failed: ${res.status}`);
    return res.json();
  }

  normalizeTaskState(raw) {
    if (!raw) return null;
    const m = { 'TASK_STATE_SUBMITTED': 'submitted', 'TASK_STATE_WORKING': 'working',
      'TASK_STATE_INPUT_REQUIRED': 'input-required', 'TASK_STATE_AUTH_REQUIRED': 'input-required',
      'TASK_STATE_COMPLETED': 'completed', 'TASK_STATE_REJECTED': 'failed',
      'TASK_STATE_FAILED': 'failed', 'TASK_STATE_CANCELED': 'canceled' };
    return m[raw] || raw;
  }

  extractTextFromParts(parts) {
    return (parts || []).filter(p => p.text).map(p => p.text).join('');
  }

  normalizeToolUses(metadata) {
    const raw = metadata?.tool_uses || [];
    return raw.map(t => {
      const input = t.input ?? t.arguments ?? {};
      const rawStatus = String(t.status || '').toLowerCase();
      const status = t.error ? 'error'
        : t.result !== undefined ? 'success'
        : ['success', 'succeeded', 'completed', 'complete', 'done'].includes(rawStatus) ? 'success'
        : ['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(rawStatus) ? 'error'
        : 'pending';
      return {
        id: t.id || `${t.name || 'tool'}:${JSON.stringify(input)}`,
        name: t.name || 'tool',
        input,
        result: t.result,
        status,
        error: t.error,
        timestamp: t.timestamp
      };
    }).filter(t => t.name !== 'ask');
  }

  parseQuestionFromParts(parts, messageId) {
    if (!parts) return null;
    for (const part of parts) {
      if (part.data?.type === 'ask') {
        const d = part.data;
        return {
          messageId: messageId || part.messageId || null,
          questions: d.questions || (d.question ? [{ question: d.question, guided_answers: d.guided_answers || [] }] : []),
          instruction: d.instruction || null,
          allowCustomAnswer: d.allowCustomAnswer !== false
        };
      }
    }
    return null;
  }

  materializeTaskSnapshot(task) {
    const state = this.normalizeTaskState(task.status?.state);
    const chunks = [];
    const artifacts = task.artifacts || [];
    for (const artifact of artifacts) {
      const text = this.extractTextFromParts(artifact.parts);
      const toolUses = this.normalizeToolUses(artifact.metadata || {});
      const question = this.parseQuestionFromParts(artifact.parts, artifact.messageId);
      chunks.push({
        text, artifactId: artifact.artifactId, append: artifact.append !== false,
        toolUses, question, questionMessageId: artifact.messageId || null,
        segmentType: question ? 'question' : artifact.artifactId?.startsWith('thinking_') ? 'thinking' : toolUses.length ? 'tool' : 'text',
        status: state
      });
    }
    // Also extract from status.message
    if (task.status?.message?.parts) {
      const question = this.parseQuestionFromParts(task.status.message.parts, task.status.message.messageId);
      if (question) {
        chunks.push({
          text: '', artifactId: 'status_msg', append: true,
          toolUses: [], question, questionMessageId: task.status.message.messageId,
          segmentType: 'question', status: state
        });
      }
    }
    return {
      taskId: task.id, contextId: task.contextId,
      state,
      terminal: state === 'completed' || state === 'failed' || state === 'canceled',
      chunks
    };
  }

  prepopulateArtifactsFromTask(task) {
    // No-op in client layer; manager handles accumulator seeding
  }

  async _streamRequest(agentName, body, onEvent) {
    const controller = new AbortController();

    const res = await fetch(`${this.baseUrl}/${agentName}/`, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stream request failed (${res.status}): ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser(onEvent);

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        // Flush decoder tail and emit any pending SSE event
        parser.feed(decoder.decode());
        parser.finish();
        // Neutral transport end — do NOT claim task completion
        onEvent({ type: 'transport_closed', data: null });
      } catch (e) {
        if (e.name !== 'AbortError') {
          onEvent({ type: 'error', data: e.message });
        }
        // AbortError — local abort (user closed sidebar, switched conv).
        // No event emitted. Background knows transport stopped.
      }
    })();

    return { controller, abort: () => controller.abort() };
  }
}