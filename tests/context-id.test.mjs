// Minimal deterministic validation for the A2A contextId maintenance fix.
// Usage: node tests/context-id.test.mjs
// Mocks browser.storage.local with an in-memory map; no external deps.
const STORAGE_KEY = 'agentcrew_state';

let passCount = 0;
let failCount = 0;

function assert(condition, label) {
  if (condition) { passCount++; console.log(`  PASS: ${label}`); }
  else { failCount++; console.error(`  FAIL: ${label}`); }
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---- Shared in-memory browser mock used by the default module instance ----
const sharedStore = {};
function installBrowserMock(store, hooks = {}) {
  globalThis.browser = {
    storage: {
      local: {
        async get(key) { return { [key]: store[key] }; },
        async set(obj) {
          if (hooks.onSet) await hooks.onSet(obj);
          Object.assign(store, obj);
        }
      }
    }
  };
}
installBrowserMock(sharedStore);

// Default (query-less) storage module is the one ConversationManager imports.
const Storage = await import('../background/storage.js');
const { ConversationManager } = await import('../background/conversation-manager.js');

// Helper: a brand-new storage module instance (unique URL) so the module-level
// "already migrated" flag is fresh for each migration scenario.
let migrationCounter = 0;
async function freshStorageModule(seed) {
  const store = { [STORAGE_KEY]: JSON.parse(JSON.stringify(seed)) };
  installBrowserMock(store);
  migrationCounter++;
  const mod = await import(`../background/storage.js?m=${Date.now()}_${migrationCounter}`);
  const state = await mod.getState();
  return { mod, store, state };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 25));

// =========================================================================
// Legacy record send: a migrated conversation sends a valid contextId.
// MUST run first: it relies on the default module's migration flag still
// being false so the seeded legacy record is repaired before sending.
// =========================================================================
console.log('\n[Flow] migrated legacy conversation sends a valid contextId');
{
  sharedStore[STORAGE_KEY] = {
    serverConfig: { baseUrl: '', bearerToken: '', defaultAgent: 'agent' },
    conversations: {
      'uuid-legacy': {
        id: 'uuid-legacy', agentName: 'agent', contextId: 'ctx_legacy_c',
        messages: [], phase: 'idle', title: 'Legacy', createdAt: 1, updatedAt: 2
      }
    },
    conversationOrder: ['uuid-legacy'],
    activeConversationId: 'uuid-legacy',
    activeTasks: {}
  };
  installBrowserMock(sharedStore);
  const mgr = new ConversationManager();
  await mgr.init(); // triggers migration inside getState
  const conv = await Storage.getConversationById('uuid-legacy');
  assertEqual(conv.a2aContextId, 'ctx_legacy_c', 'legacy record repaired before send');

  const sent = [];
  mgr.client.sendStreamingMessage = async (agentName, opts) => {
    sent.push({ contextId: opts.contextId });
    return { abort() {} };
  };
  await mgr.sendMessage('uuid-legacy', ['hello legacy']);
  await mgr.startStream('uuid-legacy', () => {});
  assertEqual(sent[0].contextId, 'ctx_legacy_c', 'migrated legacy conversation sends persisted contextId');
  assert(sent[0].contextId !== undefined && sent[0].contextId !== null && sent[0].contextId !== '',
    'payload contextId is not empty');
}

// =========================================================================
// Flow test: server-returned contextId is adopted and reused every send
// =========================================================================
console.log('\n[Flow] canonical contextId adopted and reused across tasks');
{
  sharedStore[STORAGE_KEY] = undefined;
  installBrowserMock(sharedStore);
  const mgr = new ConversationManager();
  await mgr.init();

  const sent = [];
  let capturedOnEvent = null;
  const noop = () => {};
  mgr.client.sendStreamingMessage = async (agentName, opts) => {
    sent.push({ contextId: opts.contextId, taskId: opts.taskId });
    capturedOnEvent = opts.onEvent;
    return { abort() {} };
  };
  mgr.client.getTask = async () => null;

  const convId = await Storage.createConversation('agent');

  // First message uses the locally generated context id.
  const first = await mgr.sendMessage(convId, ['first message']);
  await mgr.startStream(convId, noop);
  assertEqual(sent.length, 1, 'one stream started');
  assert(Boolean(first.contextId) && first.contextId.startsWith('ctx_'), `first send carries local ctx_ id (${first.contextId})`);
  assertEqual(sent[0].contextId, first.contextId, 'request payload contextId matches local id');

  // Server snapshot returns a canonical contextId.
  capturedOnEvent({
    type: 'event',
    data: JSON.stringify({
      result: {
        task: { id: 'task-1', contextId: 'ctx_canonical', status: { state: 'TASK_STATE_WORKING' }, artifacts: [] }
      }
    })
  });
  await tick();

  assertEqual(mgr.streaming.contextId, 'ctx_canonical', 'streaming contextId adopted synchronously');
  const activeAfterAdopt = await Storage.getActiveTask(convId);
  assertEqual(activeAfterAdopt.contextId, 'ctx_canonical', 'activeTasks contextId aligned');
  const convAfterAdopt = await Storage.getConversationById(convId);
  assertEqual(convAfterAdopt.a2aContextId, 'ctx_canonical', 'conversation a2aContextId persisted');
  assertEqual(convAfterAdopt.currentTaskContextId, 'ctx_canonical', 'currentTaskContextId persisted while active');
  assertEqual(convAfterAdopt.currentTaskId, 'task-1', 'currentTaskId persisted');

  // Terminal completion, then a completed-task send must reuse canonical id.
  capturedOnEvent({
    type: 'event',
    data: JSON.stringify({
      result: { statusUpdate: { taskId: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } } }
    })
  });
  await mgr.finalizeTask(convId, 'task-1', 'TASK_STATE_COMPLETED');
  const convAfterFinalize = await Storage.getConversationById(convId);
  assertEqual(convAfterFinalize.currentTaskState, 'idle', 'task finalized to idle');
  assertEqual(convAfterFinalize.a2aContextId, 'ctx_canonical', 'canonical id survives finalization');

  await mgr.sendMessage(convId, ['second message']);
  await mgr.startStream(convId, noop);
  assertEqual(sent[1].contextId, 'ctx_canonical', 'second task reuses canonical contextId');

  // Switch-away/switch-back and reload (new manager = background restart).
  await Storage.setActiveConversationId(null);
  await Storage.setActiveConversationId(convId);
  const mgr2 = new ConversationManager();
  await mgr2.init();
  const sent2 = [];
  mgr2.client.sendStreamingMessage = async (agentName, opts) => {
    sent2.push({ contextId: opts.contextId, taskId: opts.taskId });
    return { abort() {} };
  };
  await mgr2.sendMessage(convId, ['third message']);
  await mgr2.startStream(convId, noop);
  assertEqual(sent2[0].contextId, 'ctx_canonical', 'reloaded state still reuses canonical contextId');

  // Stored user message metadata: the pre-adoption message keeps its local id
  // (historical records are not rewritten); later messages use the canonical id.
  const convFinal = await Storage.getConversationById(convId);
  const userContextIds = convFinal.messages.filter(m => m.role === 'user').map(m => m.contextId);
  assertEqual(userContextIds[0], first.contextId, 'first user message keeps its original local contextId');
  assert(userContextIds.slice(1).every(c => c === 'ctx_canonical'),
    `subsequent user messages carry canonical contextId (${userContextIds.slice(1).join(', ')})`);

  // A new conversation gets a distinct id.
  const convId2 = await Storage.createConversation('agent');
  await mgr2.sendMessage(convId2, ['other conversation']);
  await mgr2.startStream(convId2, noop);
  assert(Boolean(sent2[1]?.contextId) && sent2[1].contextId !== 'ctx_canonical' && sent2[1].contextId.startsWith('ctx_'),
    `new conversation has a different ctx_ id (${sent2[1]?.contextId})`);
}

// =========================================================================
// Reconcile path: server-returned contextId promoted during recovery
// =========================================================================
console.log('\n[Flow] reconcile promotes server-returned contextId durably');
{
  sharedStore[STORAGE_KEY] = undefined;
  installBrowserMock(sharedStore);
  const mgr = new ConversationManager();
  await mgr.init();

  const convId = await Storage.createConversation('agent');
  // Fake a pre-existing in-flight task whose stored record has a stale id.
  await Storage.setActiveTask(convId, {
    convId, agentName: 'agent', taskId: 'task-2', contextId: 'ctx_stale',
    phase: 'working', startedAt: Date.now()
  });
  mgr.client.getTask = async () => ({
    id: 'task-2',
    contextId: 'ctx_canonical2',
    status: { state: 'TASK_STATE_WORKING' },
    artifacts: [{ artifactId: 'a1', parts: [{ text: 'progress' }] }]
  });
  const result = await mgr.reconcileTaskSnapshot(convId, () => {});
  await tick();
  assertEqual(result.state, 'alive', 'reconcile reports task alive');
  assertEqual(mgr.streaming.contextId, 'ctx_canonical2', 'streaming restored with canonical id');
  const active = await Storage.getActiveTask(convId);
  assertEqual(active.contextId, 'ctx_canonical2', 'activeTasks contextId promoted');
  const conv = await Storage.getConversationById(convId);
  assertEqual(conv.a2aContextId, 'ctx_canonical2', 'conversation a2aContextId promoted during recovery');
  assertEqual(conv.currentTaskContextId, 'ctx_canonical2', 'currentTaskContextId promoted during recovery');

  // A subsequent new send must reuse the promoted id.
  const sent = [];
  mgr.client.sendStreamingMessage = async (agentName, opts) => {
    sent.push({ contextId: opts.contextId });
    return { abort() {} };
  };
  await mgr.sendMessage(convId, ['after recovery']);
  await mgr.startStream(convId, () => {});
  assertEqual(sent[0].contextId, 'ctx_canonical2', 'next send reuses promoted canonical id');
}

// =========================================================================
// Migration tests (fresh module per scenario)
// =========================================================================
console.log('\n[Migration] legacy agent-name-keyed state is normalized to a2aContextId');
{
  const legacyConv = {
    agentName: 'agent1',
    contextId: 'ctx_legacy_a',
    currentTaskId: null,
    messages: [{ id: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hello' }] }],
    phase: 'idle', title: 'Legacy', createdAt: 1, updatedAt: 2
  };
  const { mod: S, store, state } = await freshStorageModule({
    serverConfig: { baseUrl: '', bearerToken: '', defaultAgent: 'agent1' },
    conversations: { agent1: legacyConv },
    activeTasks: {}
  });
  const convId = state.conversationOrder[0];
  const conv = state.conversations[convId];
  assert(Boolean(conv), 'migrated conversation exists');
  assertEqual(conv.a2aContextId, 'ctx_legacy_a', 'legacy contextId promoted to a2aContextId');
  assert(conv.contextId === undefined, 'legacy contextId field removed');
  assertEqual(conv.agentName, 'agent1', 'agentName preserved');
  assertEqual(conv.messages[0].parts[0].text, 'hello', 'messages preserved');
  assertEqual(conv.title, 'Legacy', 'title preserved');
  // Migration is idempotent: a second getState must not rewrite the fields.
  const again = await S.getState();
  assertEqual(again.conversations[convId].a2aContextId, 'ctx_legacy_a', 'idempotent across getState calls');
}

console.log('\n[Migration] UUID-keyed record with legacy contextId is repaired');
{
  const { state } = await freshStorageModule({
    conversations: {
      'uuid-1': { id: 'uuid-1', agentName: 'a', contextId: 'ctx_legacy_b', messages: [], phase: 'idle', title: 'B' }
    },
    conversationOrder: ['uuid-1'],
    activeConversationId: 'uuid-1',
    activeTasks: {}
  });
  assertEqual(state.conversations['uuid-1'].a2aContextId, 'ctx_legacy_b', 'a2aContextId adopted from contextId');
  assert(state.conversations['uuid-1'].contextId === undefined, 'legacy contextId removed');
}

console.log('\n[Migration] UUID-keyed record with no context at all gets a generated ctx_ id');
{
  const { state } = await freshStorageModule({
    conversations: {
      'uuid-2': { id: 'uuid-2', agentName: 'a', messages: [], phase: 'idle', title: 'C' }
    },
    conversationOrder: ['uuid-2'],
    activeConversationId: 'uuid-2',
    activeTasks: {}
  });
  const id = state.conversations['uuid-2'].a2aContextId;
  assert(typeof id === 'string' && id.startsWith('ctx_'), `generated ctx_ id (got ${id})`);
}

console.log('\n[Migration] existing a2aContextId is preserved and legacy contextId dropped');
{
  const { state } = await freshStorageModule({
    conversations: {
      'uuid-3': {
        id: 'uuid-3', agentName: 'a', a2aContextId: 'ctx_keep', contextId: 'ctx_old',
        messages: [], phase: 'idle', title: 'D'
      }
    },
    conversationOrder: ['uuid-3'],
    activeConversationId: 'uuid-3',
    activeTasks: {}
  });
  assertEqual(state.conversations['uuid-3'].a2aContextId, 'ctx_keep', 'existing a2aContextId kept');
  assert(state.conversations['uuid-3'].contextId === undefined, 'legacy contextId dropped');
}

// =========================================================================
// Adversarial: first task snapshot can never leave stale locally generated
// IDs in any storage write (canonical context is mirrored before identity
// writes; identity writes are serialized per conversation).
// =========================================================================
console.log('\n[Adversarial] first task snapshot cannot leave stale IDs');
{
  sharedStore[STORAGE_KEY] = undefined;
  const opLog = [];
  let hookConvId = null;
  installBrowserMock(sharedStore, {
    onSet(obj) {
      const state = obj[STORAGE_KEY];
      const active = hookConvId ? state?.activeTasks?.[hookConvId] : null;
      const conv = hookConvId ? state?.conversations?.[hookConvId] : null;
      opLog.push({
        activeTaskId: active?.taskId ?? null,
        activeContextId: active?.contextId ?? null,
        convA2a: conv?.a2aContextId ?? null
      });
    }
  });
  const mgr = new ConversationManager();
  await mgr.init();
  let capturedOnEvent = null;
  mgr.client.sendStreamingMessage = async (agentName, opts) => {
    capturedOnEvent = opts.onEvent;
    return { abort() {} };
  };
  const convId = await Storage.createConversation('agent');
  hookConvId = convId;
  const first = await mgr.sendMessage(convId, ['first']);
  await mgr.startStream(convId, () => {});
  // A full snapshot reporting BOTH task id and canonical context id.
  capturedOnEvent({
    type: 'event',
    data: JSON.stringify({
      result: { task: { id: 'task-a', contextId: 'ctx_canon_a', status: { state: 'TASK_STATE_WORKING' }, artifacts: [] } }
    })
  });
  // Deterministic wait on the serialized chain (no sleeps/ticks).
  if (mgr._contextPersist[convId]) await mgr._contextPersist[convId];
  const active = await Storage.getActiveTask(convId);
  const conv = await Storage.getConversationById(convId);
  assertEqual(active?.taskId, 'task-a', 'activeTask task id persisted');
  assertEqual(active?.contextId, 'ctx_canon_a', 'activeTask carries canonical contextId');
  assertEqual(conv.a2aContextId, 'ctx_canon_a', 'conversation a2aContextId canonical');
  // No write payload that carries the assigned task id may contain the stale
  // locally generated id.
  const staleWrites = opLog.filter(entry => entry.activeTaskId === 'task-a' && entry.activeContextId === first.contextId);
  assertEqual(staleWrites.length, 0, 'no task-identity write ever carried the stale local id');
  const taskWrites = opLog.filter(entry => entry.activeTaskId === 'task-a');
  assert(taskWrites.length > 0 && taskWrites.every(entry => entry.activeContextId === 'ctx_canon_a'),
    `every task-identity active-task write carried the canonical id (${taskWrites.length} writes)`);
}

// =========================================================================
// Adversarial: terminal reconcile followed immediately by a new user send
// must use the canonical contextId — no sleep/tick between them.
// =========================================================================
console.log('\n[Adversarial] terminal reconcile then immediate send uses canonical');
{
  sharedStore[STORAGE_KEY] = undefined;
  installBrowserMock(sharedStore);
  const mgr = new ConversationManager();
  await mgr.init();
  const convId = await Storage.createConversation('agent');
  // Pre-existing in-flight task with a stale context id (post-restart state).
  await Storage.setActiveTask(convId, {
    convId, agentName: 'agent', taskId: 'task-t', contextId: 'ctx_stale_t',
    phase: 'working', startedAt: Date.now()
  });
  mgr.client.getTask = async () => ({
    id: 'task-t',
    contextId: 'ctx_terminal',
    status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: []
  });
  const rc = await mgr.reconcileTaskSnapshot(convId, () => {});
  assertEqual(rc.state, 'terminal', 'reconcile reports terminal');
  assertEqual(await Storage.getActiveTask(convId), null, 'no active task after terminal reconcile');
  // Immediately (no tick/sleep) send a new message in the same conversation.
  const sent = [];
  mgr.client.sendStreamingMessage = async (agentName, opts) => {
    sent.push(opts.contextId);
    return { abort() {} };
  };
  await mgr.sendMessage(convId, ['after terminal reconcile']);
  await mgr.startStream(convId, () => {});
  assertEqual(sent[0], 'ctx_terminal', 'immediate send uses canonical id persisted by reconcile');
  const conv = await Storage.getConversationById(convId);
  assertEqual(conv.a2aContextId, 'ctx_terminal', 'conversation a2aContextId canonical after reconcile');
}

// =========================================================================
// Adversarial: immediate terminal finalization (snapshot + completed back to
// back, then finalize immediately) cannot resurrect activeTasks nor regress
// a2aContextId. Identity/context writes are awaited before clearing.
// =========================================================================
console.log('\n[Adversarial] terminal finalize cannot resurrect activeTasks or regress a2aContextId');
{
  sharedStore[STORAGE_KEY] = undefined;
  const opLog = [];
  let hookConvId = null;
  installBrowserMock(sharedStore, {
    onSet(obj) {
      const state = obj[STORAGE_KEY];
      const active = hookConvId ? state?.activeTasks?.[hookConvId] : null;
      const conv = hookConvId ? state?.conversations?.[hookConvId] : null;
      opLog.push({
        hasActiveTask: Boolean(active && active.taskId),
        activeContextId: active?.contextId ?? null,
        convTaskState: conv?.currentTaskState ?? null
      });
    }
  });
  const mgr = new ConversationManager();
  await mgr.init();
  let capturedOnEvent = null;
  mgr.client.sendStreamingMessage = async (agentName, opts) => {
    capturedOnEvent = opts.onEvent;
    return { abort() {} };
  };
  mgr.client.getTask = async () => null;
  const convId = await Storage.createConversation('agent');
  hookConvId = convId;
  await mgr.sendMessage(convId, ['first']);
  await mgr.startStream(convId, () => {});
  // Snapshot assigns task id + canonical context, immediately followed by a
  // terminal status update, immediately finalized.
  capturedOnEvent({
    type: 'event',
    data: JSON.stringify({
      result: { task: { id: 'task-f', contextId: 'ctx_canon_f', status: { state: 'TASK_STATE_WORKING' }, artifacts: [] } }
    })
  });
  capturedOnEvent({
    type: 'event',
    data: JSON.stringify({
      result: { statusUpdate: { taskId: 'task-f', status: { state: 'TASK_STATE_COMPLETED' } } }
    })
  });
  await mgr.finalizeTask(convId, 'task-f', 'TASK_STATE_COMPLETED');
  assertEqual(await Storage.getActiveTask(convId), null, 'activeTasks not resurrected after finalize');
  const conv = await Storage.getConversationById(convId);
  assertEqual(conv.a2aContextId, 'ctx_canon_f', 'a2aContextId not regressed by finalize');
  assertEqual(conv.currentTaskState, 'idle', 'conversation reset to idle');
  // Ordering: no active-task write may land after the conversation was
  // cleared (all identity/context writes are serialized before the clear).
  // 'idle' first appears at conversation creation, so compare against the
  // LAST idle write, which is finalize's clearing updateTaskSnapshot.
  const activeWrites = opLog.map((entry, index) => ({ ...entry, index })).filter(entry => entry.hasActiveTask);
  const lastActiveIndex = activeWrites.length ? activeWrites[activeWrites.length - 1].index : -1;
  const idleIndexes = opLog.map((entry, index) => (entry.convTaskState === 'idle' ? index : -1)).filter(index => index >= 0);
  const lastIdleIndex = idleIndexes.length ? idleIndexes[idleIndexes.length - 1] : -1;
  assert(lastActiveIndex === -1 || lastActiveIndex < lastIdleIndex,
    'no active-task write occurred after the conversation was cleared');
}

console.log(`\nRESULT: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);