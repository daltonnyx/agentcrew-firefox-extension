import * as Storage from './storage.js';
import { A2AClient } from './a2a-client.js';

function uuid() { return crypto.randomUUID(); }

function accumKey(convId, taskId, artifactId) {
  return `${convId}:${taskId || 'pending'}:${artifactId || 'default'}`;
}

export class ConversationManager {
  constructor() {
    this.client = null; this.streaming = null;
    this._artifactAccum = {}; this._buffers = {};
    this._pendingKey = {}; this._subGeneration = 0;
    this._persistenceOps = {};
  }

  async init() {
    const config = await Storage.getServerConfig();
    this.client = new A2AClient(config);
    this.streaming = null;
  }

  async startNewTask(convId, textParts, contextParts = []) {
    const conv = await Storage.getConversationById(convId);
    if (!conv) return null;
    const a2aContextParts = contextParts.map(({ contextType, contextPreview, ...part }) => part);
    const a2aParts = [...textParts.map(t => ({ text: t })), ...a2aContextParts];
    const msgId = uuid();
    const userMsg = Storage.makeMessage('user', [
      ...textParts.map(text => ({ kind: 'text', text })),
      ...contextParts.map(part => part.raw
        ? { kind: 'file', file: { filename: part.filename, mediaType: part.mediaType } }
        : { kind: 'context', text: part.text || '', contextType: part.contextType || 'context', preview: part.contextPreview || '' }
      )
    ], { contextId: conv.a2aContextId });
    conv.messages.push(userMsg);
    if (conv.title === 'New conversation' && a2aParts.length && a2aParts[0].text) conv.title = a2aParts[0].text.slice(0, 40);
    conv.currentTaskId = null; conv.currentTaskState = 'submitted'; conv.currentTaskContextId = conv.a2aContextId;
    await Storage.setConversationById(convId, conv);
    const pendingKey = `pending:${msgId}`;
    this._pendingKey[convId] = pendingKey;
    this._buffers[pendingKey] = [];
    this.streaming = { convId, agentName: conv.agentName, taskId: null, contextId: conv.a2aContextId, phase: 'working', startedAt: Date.now(), userMsgId: msgId, parts: a2aParts };
    await Storage.setActiveTask(convId, { ...this.streaming });
    return { msgId, contextId: conv.a2aContextId, taskId: null, parts: a2aParts };
  }

  async continueInputRequiredTask(convId, textParts, answeredQuestionMessageId) {
    const conv = await Storage.getConversationById(convId);
    if (!conv || !conv.currentTaskId) return null;
    let serverTask;
    try { serverTask = await this.client.getTask(conv.agentName, conv.currentTaskId); } catch { return null; }
    if (this.client.normalizeTaskState(serverTask?.status?.state) !== 'input-required') return null;
    const contextId = conv.a2aContextId; const taskId = conv.currentTaskId;
    const a2aParts = textParts.map(t => ({ text: t }));

    // The input-required status and this answer can arrive almost back-to-back.
    // Wait for the pause turn's thinking/response/question write before appending
    // the answer, otherwise concurrent storage read-modify-writes can lose messages.
    const persistenceKey = accumKey(convId, taskId, 'input-required');
    await this._persistenceOps[persistenceKey];
    const question = serverTask.status?.message?.parts
      ? this.client.parseQuestionFromParts(serverTask.status.message.parts, serverTask.status.message.messageId)
      : null;
    await this._persistQuestion(convId, taskId, question);

    const userMsg = Storage.makeMessage('user', [{ kind: 'text', text: textParts.join(' ') }], { taskId, contextId, answeredQuestionMessageId });
    await Storage.appendMessage(convId, userMsg);
    await Storage.updateTaskSnapshot(convId, { currentTaskState: 'submitted', currentTaskUpdatedAt: Date.now() });

    // The task ID is retained when answering an input-required task, but its next
    // assistant response is a new logical turn. Keep artifact source text so full
    // snapshots can be diffed, while starting fresh render/persistence segments.
    if (this._buffers[convId]) delete this._buffers[convId][taskId];
    this.streaming = { convId, agentName: conv.agentName, taskId, contextId, phase: 'working', startedAt: Date.now(), userMsgId: userMsg.id, parts: a2aParts, resumed: true };
    await Storage.setActiveTask(convId, { ...this.streaming });
    return { msgId: userMsg.id, contextId, taskId, parts: a2aParts };
  }

  async sendMessage(convId, textParts, contextParts = []) {
    const conv = await Storage.getConversationById(convId);
    if (!conv) return null;
    if (conv.currentTaskState === 'input-required') return this.continueInputRequiredTask(convId, textParts, null);
    return this.startNewTask(convId, textParts, contextParts);
  }

  async startStream(convId, onEvent) {
    if (!this.streaming || this.streaming.convId !== convId) return null;
    const { agentName, contextId, taskId } = this.streaming;
    const gen = ++this._subGeneration;
    const wrapped = (event) => {
      if (this._subGeneration !== gen) return;
      this._handleEvent(convId, this.streaming?.taskId, event, onEvent);
    };
    const parts = this.streaming.parts || [{ text: 'msg' }];
    return this.client.sendStreamingMessage(agentName, { messageParts: parts, contextId, taskId, onEvent: wrapped });
  }

  _handleEvent(convId, expectedTaskId, event, onEvent) {
    if (event.type === 'error') { onEvent({ convId, type: 'stream_error', data: event.data }); return; }
    if (event.type === 'transport_closed') { onEvent({ convId, type: 'transport_closed' }); return; }
    let parsed;
    try { parsed = JSON.parse(event.data); } catch { return; }
    const result = parsed.result;
    if (!result) return;
    const reportedTaskId = result.task?.id || this.streaming?.taskId;
    if (reportedTaskId && this.streaming && !this.streaming.taskId) {
      this.streaming.taskId = reportedTaskId;
      Storage.setActiveTask(this.streaming.convId, { ...this.streaming });
      // Persist task identity on the durable conversation as soon as the server
      // assigns it. This allows GetTask recovery even if activeTasks is later lost.
      Storage.updateTaskSnapshot(convId, {
        currentTaskId: reportedTaskId,
        currentTaskState: 'working',
        currentTaskContextId: this.streaming.contextId || null,
        currentTaskUpdatedAt: Date.now()
      });
    }
    const taskId = reportedTaskId || expectedTaskId;
    if (result.task) this._handleTaskSnapshot(convId, taskId, result.task, onEvent);
    else if (result.statusUpdate) this._applyStatus(convId, taskId, result.statusUpdate.status, onEvent);
    else if (result.artifactUpdate) this._handleArtifactUpdate(convId, taskId, result.artifactUpdate, onEvent);
    else if (result.message) this._handleDirectMessage(convId, taskId, result.message, onEvent);
  }

  _handleTaskSnapshot(convId, taskId, task, onEvent) {
    if (task.id && this.streaming) { this.streaming.taskId = task.id; Storage.setActiveTask(convId, { ...this.streaming }); }
    if (task.contextId && this.streaming) this.streaming.contextId = task.contextId;
    if (task.artifacts) { for (const a of task.artifacts) this._accumArtifact(convId, taskId, a, false, onEvent); }
    if (task.status) {
      this._applyStatus(convId, taskId, task.status, onEvent, false);
    }
  }

  async _persistBufferedAssistantTurn(convId, taskId) {
    const conv = await Storage.getConversationById(convId);
    if (!conv) return;
    const records = Object.values(this._buffers[convId]?.[taskId] || {})
      .filter(record => !record.segmentId?.startsWith('__state__:'));
    if (!records.length) return;

    const messages = records.map(record => Storage.makeMessage(
      'assistant',
      record.text ? [{ kind: 'text', text: record.text }] : [],
      {
        taskId,
        contextId: conv.a2aContextId,
        artifactId: record.artifactId,
        segmentId: record.segmentId,
        segmentType: record.segmentType,
        toolUses: record.toolUses,
        question: record.question
      }
    )).filter(message => message.parts.length || message.toolUses?.length || message.question);

    await Storage.appendAssistantMessagesForTask(convId, taskId, messages);
  }

  async _persistQuestion(convId, taskId, question) {
    if (question) {
      const existing = await Storage.getMessagesForTask(convId, taskId);
      const duplicate = existing.some(message =>
        message.role === 'assistant' &&
        message.segmentType === 'question' &&
        message.question?.messageId === question.messageId
      );
      if (!duplicate) {
        await Storage.appendMessage(convId, Storage.makeMessage('assistant', [], {
          taskId,
          contextId: this.streaming?.contextId || null,
          segmentType: 'question',
          question
        }));
      }
    }
    await Storage.updateTaskSnapshot(convId, {
      currentTaskId: taskId,
      currentTaskState: 'input-required',
      currentTaskUpdatedAt: Date.now()
    });
  }

  _applyStatus(convId, taskId, status, onEvent, completesPendingTools = true) {
    // A standalone status notification is a subsequent stream chunk. It proves an
    // earlier tool call without an explicit completion payload has finished.
    // Snapshot status is excluded because it accompanies its own artifacts.
    if (completesPendingTools) this._completePendingTools(convId, taskId, onEvent);
    const state = typeof status === 'string' ? status : status?.state;
    const question = status?.message?.parts
      ? this.client.parseQuestionFromParts(status.message.parts, status.message.messageId)
      : null;
    const s = this.client.normalizeTaskState(state);
    if (s === 'completed' || s === 'failed' || s === 'canceled') {
      this._completePendingTools(convId, taskId, onEvent);
      if (this.streaming) this.streaming.phase = 'terminal';
      onEvent({ convId, taskId, type: 'stream_end', data: state });
      Storage.setActiveTask(convId, null);
    } else if (s === 'input-required') {
      if (this.streaming) this.streaming.phase = 'input_required';
      if (this.streaming) Storage.setActiveTask(convId, { ...this.streaming });
      // Serialize the pause turn's thinking/response/question writes. In particular,
      // do not write a previously-read full conversation after these appends: that
      // stale object would erase the assistant records that were just persisted.
      const persistenceKey = accumKey(convId, taskId, 'input-required');
      const previousPersistence = this._persistenceOps[persistenceKey] || Promise.resolve();
      const persistence = previousPersistence
        .then(() => this._persistBufferedAssistantTurn(convId, taskId))
        .then(() => this._persistQuestion(convId, taskId, question))
        .then(() => { if (this._buffers[convId]) delete this._buffers[convId][taskId]; });
      this._persistenceOps[persistenceKey] = persistence;
      persistence
        .then(() => {
          onEvent({ convId, taskId, type: 'input_required_persisted', data: question });
        })
        .catch(error => console.error('Failed to persist input-required turn:', error))
        .finally(() => {
          if (this._persistenceOps[persistenceKey] === persistence) delete this._persistenceOps[persistenceKey];
        });
      onEvent({ convId, taskId, type: 'input_required', data: question });
    } else { if (this.streaming) this.streaming.phase = 'working'; }
  }

  _handleArtifactUpdate(convId, taskId, update, onEvent) {
    // This update is the next stream chunk. Mark earlier unresolved tool calls done
    // before rendering the newly arriving segment (text, thinking, or another tool).
    this._completePendingTools(convId, taskId, onEvent);
    this._accumArtifact(convId, taskId, update.artifact, update.append !== false, onEvent);
  }

  _completePendingTools(convId, taskId, onEvent) {
    const taskBuffers = this._buffers[convId]?.[taskId];
    if (!taskBuffers) return;

    for (const record of Object.values(taskBuffers)) {
      if (record.segmentType !== 'tool' || !record.toolUses?.length) continue;
      const completedTools = record.toolUses.map(tool =>
        tool.status === 'pending' ? { ...tool, status: 'success' } : tool
      );
      if (completedTools.every((tool, index) => tool === record.toolUses[index])) continue;

      record.toolUses = completedTools;
      onEvent({
        convId,
        taskId,
        type: 'stream_chunk',
        data: {
          text: '',
          fullText: '',
          append: false,
          artifactId: record.artifactId,
          segmentId: record.segmentId,
          segmentType: 'tool',
          toolUses: record.toolUses,
          question: null
        }
      });
    }
  }

  _accumArtifact(convId, taskId, artifact, append, onEvent) {
    const text = this.client.extractTextFromParts(artifact.parts);
    const toolUses = this.client.normalizeToolUses(artifact.metadata || {});
    const question = this.client.parseQuestionFromParts(artifact.parts, artifact.messageId);
    if (!text && !toolUses.length && !question) return;

    const artifactId = artifact.artifactId || 'default';
    const isThinking = artifactId.startsWith('thinking_');
    const accumId = accumKey(convId, taskId, artifactId);
    const previousText = this._artifactAccum[accumId] || '';
    const delta = append ? text : (text.startsWith(previousText) ? text.slice(previousText.length) : text);
    this._artifactAccum[accumId] = append ? previousText + text : text;

    if (!this._buffers[convId]) this._buffers[convId] = {};
    if (!this._buffers[convId][taskId]) this._buffers[convId][taskId] = {};
    const taskBuffers = this._buffers[convId][taskId];
    // Timeline state is shared by every artifact in the task. Tool calls commonly
    // arrive in a different artifact from thinking, so artifact-local state alone
    // cannot split the thinking that resumes after a tool call.
    const timelineStateId = '__state__:timeline';
    const timelineState = taskBuffers[timelineStateId] || { toolBoundary: 0 };
    const stateId = `__state__:${artifactId}`;
    const artifactState = taskBuffers[stateId] || {
      nextTextIndex: 0,
      textSegmentId: null,
      textToolBoundary: -1,
      toolSegments: {}
    };

    const makeRecord = (segmentId, segmentType) => {
      const record = taskBuffers[segmentId] || {
        artifactId,
        segmentId,
        text: '',
        toolUses: [],
        question: null,
        segmentType
      };
      taskBuffers[segmentId] = record;
      return record;
    };

    if (text || question) {
      // Start a fresh text/thinking record after every newly observed tool call,
      // including tools emitted by a different artifact. This preserves the visible
      // process order as thinking -> tool -> thinking instead of merging both thoughts.
      if (!artifactState.textSegmentId || artifactState.textToolBoundary !== timelineState.toolBoundary) {
        artifactState.nextTextIndex += 1;
        artifactState.textSegmentId = `${artifactId}:text:${artifactState.nextTextIndex}`;
        artifactState.textToolBoundary = timelineState.toolBoundary;
      }
      const segmentType = isThinking ? 'thinking' : question ? 'question' : 'text';
      const record = makeRecord(artifactState.textSegmentId, segmentType);
      record.segmentType = segmentType;
      // `delta` is already relative to the source artifact history. Always append
      // it to this logical response turn so a resumed task never replays earlier text.
      record.text += delta;
      record.question = question || record.question;
      onEvent({
        convId,
        taskId,
        type: 'stream_chunk',
        data: {
          text: delta,
          fullText: record.text,
          append,
          artifactId,
          segmentId: record.segmentId,
          segmentType: record.segmentType,
          toolUses: record.toolUses,
          question: record.question
        }
      });
    }

    if (toolUses.length) {
      const toolKey = toolUses.map(tool => tool.id || `${tool.name}:${JSON.stringify(tool.input || {})}`).sort().join('|');
      let toolSegmentId = artifactState.toolSegments[toolKey];
      if (!toolSegmentId) {
        toolSegmentId = `${artifactId}:tool:${Object.keys(artifactState.toolSegments).length + 1}`;
        artifactState.toolSegments[toolKey] = toolSegmentId;
        timelineState.toolBoundary += 1;
      }
      const record = makeRecord(toolSegmentId, 'tool');
      const toolsById = new Map(record.toolUses.map(tool => [tool.id || `${tool.name}:${JSON.stringify(tool.input || {})}`, tool]));
      for (const tool of toolUses) {
        const id = tool.id || `${tool.name}:${JSON.stringify(tool.input || {})}`;
        toolsById.set(id, { ...toolsById.get(id), ...tool });
      }
      record.toolUses = [...toolsById.values()];
      onEvent({
        convId,
        taskId,
        type: 'stream_chunk',
        data: {
          text: '',
          fullText: '',
          append: false,
          artifactId,
          segmentId: record.segmentId,
          segmentType: 'tool',
          toolUses: record.toolUses,
          question: null
        }
      });
    }

    taskBuffers[stateId] = artifactState;
    taskBuffers[timelineStateId] = timelineState;
  }

  _handleDirectMessage(convId, taskId, message, onEvent) {
    this._completePendingTools(convId, taskId, onEvent);
    const text = this.client.extractTextFromParts(message.parts);
    const question = this.client.parseQuestionFromParts(message.parts, message.messageId);
    if (!text && !question) return;
    onEvent({ convId, taskId, type: 'assistant_segment', data: { segmentType: question ? 'question' : 'text', text, question } });
  }

  async finalizeTask(convId, taskId, state) {
    if (!Storage.isTerminalState(Storage.normalizeTaskState(state))) return;
    const conv = await Storage.getConversationById(convId);
    if (!conv) return;
    const records = Object.values(this._buffers[convId]?.[taskId] || {}).filter(record => !record.segmentId?.startsWith('__state__:'));
    const messages = records.map(record => {
      const parts = record.text ? [{ kind: 'text', text: record.text }] : [];
      return Storage.makeMessage('assistant', parts, {
        taskId,
        contextId: conv.a2aContextId,
        artifactId: record.artifactId,
        segmentId: record.segmentId,
        segmentType: record.segmentType,
        toolUses: record.toolUses,
        question: record.question
      });
    });
    await Storage.appendAssistantMessagesForTask(convId, taskId, messages.filter(message => message.parts.length || message.toolUses?.length || message.question));
    await Storage.updateTaskSnapshot(convId, { currentTaskId: null, currentTaskState: 'idle', currentTaskContextId: null, currentTaskCompletedAt: Date.now() });
    await Storage.clearActiveTask(convId);
    delete this._buffers[convId]?.[taskId];
    if (this.streaming?.convId === convId) this.streaming = null;
  }

  async reconcileTaskSnapshot(convId, onEvent) {
    const conv = await Storage.getConversationById(convId);
    if (!conv) return { state: 'none' };

    // activeTasks is transport bookkeeping and can be lost when the background
    // context restarts. The conversation snapshot is the durable recovery source.
    const storedActiveTask = await Storage.getActiveTask(convId);
    const taskId = storedActiveTask?.taskId || conv.currentTaskId;
    const agentName = storedActiveTask?.agentName || conv.agentName;
    if (!taskId || !agentName) return { state: 'none' };
    const activeTask = {
      ...storedActiveTask,
      convId,
      taskId,
      agentName,
      contextId: storedActiveTask?.contextId || conv.currentTaskContextId || conv.a2aContextId
    };

    let serverTask;
    try { serverTask = await this.client.getTask(agentName, taskId); } catch (err) {
      if (err.code === -32001) { await Storage.clearActiveTask(convId); return { state: 'not_found' }; }
      return { state: 'pending', taskId, error: err.message };
    }
    const snapshot = this.client.materializeTaskSnapshot(serverTask);
    if (!snapshot) return { state: 'not_found' };

    const snapshotMessages = snapshot.chunks.map(chunk => Storage.makeMessage('assistant',
      chunk.text ? [{ kind: 'text', text: chunk.text }] : [],
      { taskId: snapshot.taskId, contextId: snapshot.contextId, segmentType: chunk.segmentType, toolUses: chunk.toolUses, question: chunk.question, questionMessageId: chunk.questionMessageId }
    )).filter(message => message.parts.length || message.toolUses?.length || message.question);

    // GetTask returns a current task snapshot, not a complete replacement for the
    // locally persisted conversation. Merge its unseen artifacts before handling
    // status so recovery cannot drop earlier thinking/response/question rounds.
    await Storage.mergeAssistantMessagesForTask(convId, snapshot.taskId, snapshotMessages);
    if (snapshot.state === 'input-required') {
      const question = this.client.parseQuestionFromParts(
        serverTask.status?.message?.parts,
        serverTask.status?.message?.messageId
      );
      this.streaming = {
        convId,
        agentName: activeTask.agentName,
        taskId: snapshot.taskId,
        contextId: snapshot.contextId || activeTask.contextId,
        phase: 'input_required',
        startedAt: activeTask.startedAt || Date.now()
      };
      await this._persistQuestion(convId, snapshot.taskId, question);
      await Storage.setActiveTask(convId, { ...this.streaming });
      if (onEvent) onEvent({ convId, taskId: snapshot.taskId, type: 'input_required', data: question });
      return { state: 'input_required', taskId: snapshot.taskId, question };
    }

    if (snapshot.terminal) {
      await Storage.updateTaskSnapshot(convId, { currentTaskId: null, currentTaskState: 'idle', currentTaskCompletedAt: Date.now() });
      await Storage.clearActiveTask(convId);
      if (onEvent) onEvent({ convId, taskId: snapshot.taskId, type: 'stream_end', data: snapshot.state });
      return { state: 'terminal' };
    }
    if (serverTask.artifacts) {
      for (const artifact of serverTask.artifacts) {
        const aId = artifact.artifactId || 'default';
        this._artifactAccum[accumKey(convId, snapshot.taskId, aId)] = this.client.extractTextFromParts(artifact.parts);
      }
    }
    if (!this._buffers[convId]) this._buffers[convId] = {};
    if (!this._buffers[convId][snapshot.taskId]) this._buffers[convId][snapshot.taskId] = {};
    this.streaming = { convId, agentName: activeTask.agentName, taskId: snapshot.taskId, contextId: snapshot.contextId || activeTask.contextId, phase: 'working', startedAt: Date.now() };
    await Storage.setActiveTask(convId, { ...this.streaming });
    return { state: 'alive', taskId: snapshot.taskId };
  }

  async resubscribe(convId, onEvent) {
    const task = await Storage.getActiveTask(convId);
    if (!task || !task.taskId) return null;
    const rc = await this.reconcileTaskSnapshot(convId);
    if (rc.state !== 'alive') return null;
    const gen = ++this._subGeneration;
    return this.client.subscribeToTask(task.agentName, task.taskId, (event) => {
      if (this._subGeneration !== gen) return;
      if (event.type === 'error' && event.data?.toLowerCase?.().includes('terminal')) {
        this.reconcileTaskSnapshot(convId, onEvent).then(r => { if (r.state === 'terminal' && onEvent) onEvent({ convId, type: 'stream_end', data: 'TASK_STATE_COMPLETED' }); });
        return;
      }
      this._handleEvent(convId, task.taskId, event, onEvent);
    });
  }

  async cancelCurrentTask(optConvId) {
    let convId = optConvId || this.streaming?.convId;
    let agentName = this.streaming?.agentName; let taskId = this.streaming?.taskId;
    if (!taskId || !agentName || (optConvId && this.streaming?.convId !== optConvId)) {
      const t = await Storage.getActiveTask(convId);
      if (!t || !t.taskId) return null;
      agentName = t.agentName; taskId = t.taskId;
    }
    try { await this.client.cancelTask(agentName, taskId); } catch { return null; }
    this.streaming = null; await Storage.clearActiveTask(convId); return convId;
  }

  invalidateTransport() { this._subGeneration++; this.streaming = null; }
}