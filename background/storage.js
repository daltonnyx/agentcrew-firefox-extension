const STORAGE_KEY = 'agentcrew_state';

const DEFAULT_STATE = {
  serverConfig: { baseUrl: '', bearerToken: '', defaultAgent: null },
  conversations: {},
  conversationOrder: [],
  activeConversationId: null,
  lastSelectedAgent: null,
  activeTasks: {}
};

export const TaskState = {
  SUBMITTED: 'submitted', WORKING: 'working', INPUT_REQUIRED: 'input-required',
  COMPLETED: 'completed', FAILED: 'failed', CANCELED: 'canceled'
};

export function normalizeTaskState(raw) {
  if (!raw) return null;
  const m = { 'TASK_STATE_SUBMITTED': 'submitted', 'TASK_STATE_WORKING': 'working',
    'TASK_STATE_INPUT_REQUIRED': 'input-required', 'TASK_STATE_AUTH_REQUIRED': 'input-required',
    'TASK_STATE_COMPLETED': 'completed', 'TASK_STATE_REJECTED': 'failed',
    'TASK_STATE_FAILED': 'failed', 'TASK_STATE_CANCELED': 'canceled' };
  return m[raw] || raw;
}

export function extractTextFromParts(parts) {
  return (parts || []).filter(p => p.text).map(p => p.text).join('');
}

export function isTerminalState(s) {
  return s === TaskState.COMPLETED || s === TaskState.FAILED || s === TaskState.CANCELED;
}

export function makeConvTemplate(agentName) {
  const convId = uuid();
  return {
    id: convId, agentName,
    a2aContextId: `ctx_${uuid()}`,
    currentTaskId: null, currentTaskState: 'idle', currentTaskContextId: null,
    currentTaskUpdatedAt: null, currentTaskCompletedAt: null,
    messages: [], phase: 'idle',
    title: 'New conversation', createdAt: now(), updatedAt: now()
  };
}

export function makeMessage(role, parts, opts = {}) {
  return {
    id: uuid(), role, parts, timestamp: now(),
    taskId: opts.taskId || null, contextId: opts.contextId || null,
    artifactId: opts.artifactId || null, segmentId: opts.segmentId || null,
    segmentType: opts.segmentType || null, toolUses: opts.toolUses || null,
    question: opts.question || null, answeredQuestionMessageId: opts.answeredQuestionMessageId || null
  };
}

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

export async function getState() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const state = { ...DEFAULT_STATE, ...(result[STORAGE_KEY] || {}) };
  await _migrateIfNeeded(state);
  return state;
}

export async function setState(partial) {
  const current = await getState();
  const next = { ...current, ...partial };
  await browser.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

let _migrated = false;

async function _migrateIfNeeded(state) {
  if (_migrated) return;
  let dirty = false;

  // Migration 1: old activeTask to activeTasks[convId]
  if (state.activeTask?.convId) {
    const task = state.activeTask;
    if (!state.activeTasks) state.activeTasks = {};
    if (!state.activeTasks[task.convId]) {
      state.activeTasks[task.convId] = task;
    }
    delete state.activeTask;
    dirty = true;
  }
  if (!state.activeTasks) {
    state.activeTasks = {};
    dirty = true;
  }

  // Migration 2: old agentName-keyed conversations to UUID-keyed
  if (!state.conversationOrder?.length) {
    const oldConvs = state.conversations || {};
    const keys = Object.keys(oldConvs);
    if (keys.length && keys[0]?.length <= 60) {
      const newConvs = {};
      const order = [];
      for (const agentName of keys) {
        const old = oldConvs[agentName];
        if (!old) continue;
        const convId = uuid();
        newConvs[convId] = {
          id: convId,
          agentName,
          a2aContextId: old.a2aContextId || old.contextId || `ctx_${uuid()}`,
          currentTaskId: old.currentTaskId || null,
          messages: old.messages || [],
          phase: old.phase || 'idle',
          title: old.title || (old.messages?.[0]?.parts?.[0]?.text?.slice(0, 40) || 'Conversation'),
          createdAt: old.createdAt || now(),
          updatedAt: old.updatedAt || now()
        };
        order.push(convId);
      }
      order.sort((a, b) => (newConvs[b].updatedAt || 0) - (newConvs[a].updatedAt || 0));
      state.conversations = newConvs;
      state.conversationOrder = order;
      state.activeConversationId = order[0] || null;
      state.lastSelectedAgent = state.serverConfig?.defaultAgent || keys[0] || null;
      dirty = true;
    }
  }

  // Migration 3: every conversation must carry a2aContextId. Repairs records
  // that only have the legacy contextId field, and UUID-keyed states that were
  // never migrated (they lack a2aContextId entirely). Prefer an existing
  // a2aContextId, then legacy contextId, otherwise generate ctx_<uuid>; drop
  // the legacy contextId field while preserving all other conversation data.
  const convs = state.conversations || {};
  for (const convId of Object.keys(convs)) {
    const conv = convs[convId];
    if (!conv || typeof conv !== 'object') continue;
    if (!conv.a2aContextId) {
      conv.a2aContextId = conv.contextId || `ctx_${uuid()}`;
      dirty = true;
    }
    if (conv.contextId !== undefined) {
      delete conv.contextId;
      dirty = true;
    }
  }

  if (dirty) {
    await browser.storage.local.set({ [STORAGE_KEY]: state });
  }
  _migrated = true;
}

export async function getConversationById(convId) {
  const state = await getState();
  return state.conversations[convId] || null;
}

export async function setConversationById(convId, conversation) {
  const state = await getState();
  state.conversations[convId] = conversation;
  await setState(state);
}

export async function getConversationOrder() {
  const state = await getState();
  return state.conversationOrder || [];
}

export async function getActiveConversationId() {
  const state = await getState();
  return state.activeConversationId;
}

export async function setActiveConversationId(convId) {
  const state = await getState();
  state.activeConversationId = convId;
  await setState(state);
}

export async function getLastSelectedAgent() {
  const state = await getState();
  return state.lastSelectedAgent;
}

export async function setLastSelectedAgent(agentName) {
  const state = await getState();
  state.lastSelectedAgent = agentName;
  await setState(state);
}

export async function createConversation(agentName) {
  const state = await getState();
  const conv = makeConvTemplate(agentName);
  const convId = conv.id;
  state.conversations[convId] = conv;
  state.conversationOrder.unshift(convId);
  state.activeConversationId = convId;
  state.lastSelectedAgent = agentName;
  await setState(state);
  return convId;
}

export async function deleteConversation(convId) {
  const state = await getState();
  delete state.conversations[convId];
  state.conversationOrder = state.conversationOrder.filter(id => id !== convId);
  if (state.activeConversationId === convId) {
    state.activeConversationId = state.conversationOrder[0] || null;
  }
  await setState(state);
}

export async function getAllConversations() {
  const state = await getState();
  const order = state.conversationOrder || [];
  return order.map(id => state.conversations[id]).filter(Boolean);
}

export async function updateConversationMeta(convId, updates) {
  const state = await getState();
  const conv = state.conversations[convId];
  if (!conv) return;
  Object.assign(conv, updates, { updatedAt: now() });
  await setState(state);
}

export async function appendMessage(convId, message) {
  const state = await getState();
  const conv = state.conversations[convId];
  if (!conv) return;
  conv.messages.push(message);
  conv.updatedAt = now();
  await setState(state);
}

export async function patchMessage(convId, messageId, updates) {
  const state = await getState();
  const conv = state.conversations[convId];
  if (!conv) return;
  const msg = conv.messages.find(m => m.id === messageId);
  if (msg) Object.assign(msg, updates, { timestamp: now() });
  await setState(state);
}

export async function updateTaskSnapshot(convId, updates) {
  const state = await getState();
  const conv = state.conversations[convId];
  if (!conv) return;
  Object.assign(conv, updates, { updatedAt: now() });
  await setState(state);
}

export async function replaceAssistantMessagesForTask(convId, taskId, replacements) {
  const state = await getState();
  const conv = state.conversations[convId];
  if (!conv) return;
  const keep = conv.messages.filter(m => m.taskId !== taskId || m.role !== 'assistant');
  conv.messages = keep.concat(replacements);
  conv.messages.sort((a, b) => a.timestamp - b.timestamp);
  conv.updatedAt = now();
  await setState(state);
}

function assistantMessageSignature(message) {
  const text = (message.parts || []).map(part => part.text || '').join('');
  const questionId = message.question?.messageId || '';
  const questionBody = questionId ? '' : JSON.stringify(message.question || null);
  return JSON.stringify([
    message.artifactId || '',
    message.segmentType || '',
    text,
    message.toolUses || null,
    questionId,
    questionBody
  ]);
}

// GetTask snapshots may include artifacts from several input/answer rounds. Merge
// unseen records rather than replacing task messages, which would erase earlier
// thinking, assistant responses, questions, and their linked user answers.
export async function mergeAssistantMessagesForTask(convId, taskId, snapshots) {
  const state = await getState();
  const conv = state.conversations[convId];
  if (!conv || !snapshots?.length) return;

  const existing = new Set(conv.messages
    .filter(message => message.taskId === taskId && message.role === 'assistant')
    .map(assistantMessageSignature));
  const additions = [];
  for (const snapshot of snapshots) {
    const signature = assistantMessageSignature(snapshot);
    if (existing.has(signature)) continue;
    existing.add(signature);
    additions.push(snapshot);
  }
  if (!additions.length) return;
  conv.messages.push(...additions);
  conv.updatedAt = now();
  await setState(state);
}

// A task can pause for input and resume several times. Append only the assistant
// records produced by the current logical turn so earlier questions and responses
// remain part of the conversation history.
export async function appendAssistantMessagesForTask(convId, taskId, additions) {
  const state = await getState();
  const conv = state.conversations[convId];
  if (!conv || !additions?.length) return;

  const existing = new Set(conv.messages
    .filter(message => message.taskId === taskId && message.role === 'assistant')
    .map(assistantMessageSignature));
  const pending = [];
  for (const addition of additions) {
    const signature = assistantMessageSignature(addition);
    if (existing.has(signature)) continue;
    existing.add(signature);
    pending.push(addition);
  }
  if (!pending.length) return;
  conv.messages.push(...pending);
  conv.updatedAt = now();
  await setState(state);
}

export async function getMessagesForTask(convId, taskId) {
  const conv = await getConversationById(convId);
  if (!conv) return [];
  return conv.messages.filter(m => m.taskId === taskId);
}

export async function getLatestQuestionForTask(convId, taskId) {
  const conv = await getConversationById(convId);
  if (!conv) return null;
  return conv.messages.filter(m => m.taskId === taskId && m.segmentType === 'question').pop() || null;
}

export async function getServerConfig() {
  const state = await getState();
  return state.serverConfig;
}

export async function setServerConfig(config) {
  const state = await getState();
  state.serverConfig = { ...state.serverConfig, ...config };
  await setState(state);
}

export async function getActiveTask(convId) {
  const state = await getState();
  return state.activeTasks?.[convId] || null;
}

export async function setActiveTask(convId, task) {
  const state = await getState();
  if (task) {
    state.activeTasks[convId] = task;
  } else {
    delete state.activeTasks[convId];
  }
  await setState(state);
}

export async function clearActiveTask(convId) {
  const state = await getState();
  delete state.activeTasks[convId];
  await setState(state);
}

export async function getActiveTasks() {
  const state = await getState();
  return { ...(state.activeTasks || {}) };
}

export async function clearAllActiveTasks() {
  const state = await getState();
  state.activeTasks = {};
  await setState(state);
}
