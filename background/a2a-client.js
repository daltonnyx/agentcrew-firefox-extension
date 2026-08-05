import { SSEParser } from '../lib/sse-parser.js';

let _reqId = 0;
function nextReqId() {
  return String(++_reqId);
}

function uuid() {
  return crypto.randomUUID();
}

// Protobuf JSON rejects lone UTF-16 surrogates. Page text can contain them
// after DOM extraction/truncation, especially around emoji boundaries.
// Preserve valid surrogate pairs and replace only malformed code units.
function toWellFormedString(value) {
  const text = String(value);
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += text[i] + text[i + 1];
        i++;
      } else {
        result += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += '\uFFFD';
    } else {
      result += text[i];
    }
  }
  return result;
}

function serializeA2AJson(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'string' ? toWellFormedString(item) : item
  );
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

  async startEphemeralMessage(agentName, { messageParts, outputModes }) {
    let activeHandle = null;
    let taskId = null;
    let settled = false;
    let stopped = false;
    let recoveryAttempts = 0;
    let recoveryStartedAt = 0;
    let recoveryInFlight = false;
    let recoveryPending = false;
    let recoveryTimer = null;
    const RECOVERY_TIMEOUT_MS = 120000;
    const artifactTexts = new Map();
    const directTexts = [];
    let resolveResult;
    let rejectResult;
    let completionTimer = null;

    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const combinedText = () => [
      ...artifactTexts.values(),
      ...directTexts
    ].filter(Boolean).join('\n');

    const applyArtifact = (artifact, append = true) => {
      if (!artifact) return;
      const artifactId = artifact.artifactId || 'default';
      const text = this.extractTextFromParts(artifact.parts);
      if (!text) return;
      artifactTexts.set(
        artifactId,
        append ? (artifactTexts.get(artifactId) || '') + text : text
      );
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (completionTimer) clearTimeout(completionTimer);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      activeHandle?.abort();
      if (error) rejectResult(error);
      else {
        const text = combinedText();
        if (!text.trim()) rejectResult(new Error('Generation completed without generated content.'));
        else resolveResult(text);
      }
    };

    const finishCompleted = () => {
      if (settled || stopped) return;
      if (completionTimer) clearTimeout(completionTimer);
      // Some A2A servers emit COMPLETED immediately before the final artifact
      // event. Give that event a short turn to arrive before snapshot recovery.
      completionTimer = setTimeout(async () => {
        if (settled || stopped) return;
        if (taskId) {
          try {
            const task = await this.getTask(agentName, taskId);
            applyTask(task, false);
          } catch { /* accumulated stream output may still be complete */ }
        }
        finish();
      }, 100);
    };

    const applyStatus = (status) => {
      const state = this.normalizeTaskState(typeof status === 'string' ? status : status?.state);
      if (state === 'input-required') {
        finish(new Error('The agent needs more information before it can generate content.'));
      } else if (state === 'failed' || state === 'canceled') {
        finish(new Error(`Generation task ${state}.`));
      } else if (state === 'completed') {
        finishCompleted();
      }
    };

    const applyTask = (task, applyTaskStatus = true) => {
      if (!task) return;
      if (task.id) taskId = task.id;
      for (const artifact of task.artifacts || []) applyArtifact(artifact, false);
      if (task.status?.message?.parts) {
        const text = this.extractTextFromParts(task.status.message.parts);
        if (text) directTexts.push(text);
      }
      if (applyTaskStatus) applyStatus(task.status);
    };

    const scheduleRecovery = (delayMs = 500) => {
      if (settled || stopped || recoveryTimer || completionTimer) return;
      if (recoveryInFlight) {
        recoveryPending = true;
        return;
      }
      if (!recoveryStartedAt) recoveryStartedAt = Date.now();
      const elapsed = Date.now() - recoveryStartedAt;
      if (elapsed >= RECOVERY_TIMEOUT_MS) {
        finish(new Error('Timed out waiting for the generation task to complete.'));
        return;
      }
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        recover();
      }, Math.min(delayMs, RECOVERY_TIMEOUT_MS - elapsed));
    };

    const recover = async () => {
      if (settled || stopped || recoveryInFlight || completionTimer) return;
      if (!taskId) {
        if (combinedText()) finish();
        else finish(new Error('A2A stream closed before returning generated content.'));
        return;
      }
      if (!recoveryStartedAt) recoveryStartedAt = Date.now();
      if (Date.now() - recoveryStartedAt >= RECOVERY_TIMEOUT_MS) {
        finish(new Error('Timed out waiting for the generation task to complete.'));
        return;
      }

      recoveryInFlight = true;
      recoveryAttempts++;
      let retryDelay = null;
      try {
        const task = await this.getTask(agentName, taskId);
        applyTask(task);
        if (settled || stopped || completionTimer) return;
        activeHandle = await this.subscribeToTask(agentName, taskId, onRawEvent);
        recoveryAttempts = 0;
      } catch {
        retryDelay = Math.min(500 * recoveryAttempts, 3000);
      } finally {
        recoveryInFlight = false;
      }
      if (recoveryPending) {
        recoveryPending = false;
        retryDelay = retryDelay ?? Math.min(500 * Math.max(recoveryAttempts, 1), 3000);
      }
      if (retryDelay !== null) scheduleRecovery(retryDelay);
    };

    const onRawEvent = (event) => {
      if (settled || stopped) return;
      if (event.type === 'transport_closed' || event.type === 'error') {
        // A cleanly closed SSE connection is a transport event, not a failed
        // task. Reconcile on a bounded time window instead of exhausting a small
        // retry count while the server is still working.
        scheduleRecovery(Math.min(500 * Math.max(recoveryAttempts, 1), 3000));
        return;
      }

      let parsed;
      try { parsed = JSON.parse(event.data); } catch { return; }
      if (parsed.error) {
        finish(new Error(parsed.error.message || 'A2A request failed.'));
        return;
      }

      const response = parsed.result;
      if (!response) return;
      if (response.task) {
        applyTask(response.task);
      } else if (response.artifactUpdate) {
        if (response.artifactUpdate.taskId) taskId = response.artifactUpdate.taskId;
        applyArtifact(response.artifactUpdate.artifact, response.artifactUpdate.append !== false);
      } else if (response.statusUpdate) {
        if (response.statusUpdate.taskId) taskId = response.statusUpdate.taskId;
        applyStatus(response.statusUpdate.status);
      } else if (response.message) {
        if (response.message.taskId) taskId = response.message.taskId;
        const text = this.extractTextFromParts(response.message.parts);
        if (text) directTexts.push(text);
      }
    };

    try {
      activeHandle = await this.sendStreamingMessage(agentName, {
        messageParts,
        outputModes,
        onEvent: onRawEvent
      });
    } catch (error) {
      finish(error);
    }

    return {
      result,
      abort: () => {
        stopped = true;
        if (completionTimer) clearTimeout(completionTimer);
        if (recoveryTimer) clearTimeout(recoveryTimer);
        activeHandle?.abort();
        finish(new Error('Generation canceled.'));
      }
    };
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
      body: serializeA2AJson(body)
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
      body: serializeA2AJson({
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
      body: serializeA2AJson(body),
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