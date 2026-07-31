import * as Storage from './storage.js';
import { ConversationManager } from './conversation-manager.js';
import { ContextExtractor } from './context-extractor.js';
import { createContextMenus } from '../context-menus.js';

const mgr = new ConversationManager();
let sidebarPort = null;
let streamHandle = null;

let _transportConvId = null;
let _retryTimer = null;
let _retryCount = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;
let _retryConvId = null;

async function init() {
  await mgr.init();
  createContextMenus();
}

function abortLocalTransport() {
  clearRetryTimer();
  mgr.invalidateTransport();
  if (streamHandle) {
    streamHandle.abort();
    streamHandle = null;
    _transportConvId = null;
  }
}

function clearRetryTimer() {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  _retryConvId = null;
}

function resetRetryState() {
  clearRetryTimer();
  _retryCount = 0;
}

async function tryResubscribe(convId) {
  if (!convId) return;
  const task = await Storage.getActiveTask(convId);
  if (!task || task.phase === 'terminal' || !task.taskId) return;
  try {
    abortLocalTransport();
    streamHandle = await mgr.resubscribe(convId, (event) => {
      onStreamEvent(convId, event);
    });
    if (streamHandle) {
      _transportConvId = convId;
      _retryCount = 0;
      broadcast({ convId, type: 'transport_status', data: 'resubscribed' });
    }
  } catch (err) {
    console.error('Resubscribe failed:', err.message);
    broadcast({ convId, type: 'transport_status', data: 'retry' });
    scheduleRetry(convId);
  }
}

function scheduleRetry(convId) {
  if (_retryCount >= MAX_RETRIES) {
    console.warn('Max retry attempts reached for conv:', convId);
    broadcast({ convId, type: 'transport_status', data: 'failed' });
    return;
  }
  _retryCount++;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    if (convId === _retryConvId) {
      tryResubscribe(convId);
    }
  }, RETRY_DELAY_MS * _retryCount);
  _retryConvId = convId;
}

async function onStreamEvent(convId, event) {
  if (event.type === 'stream_end') {
    const taskId = event.taskId;
    await mgr.finalizeTask(convId, taskId, event.data);
    _transportConvId = null; resetRetryState();
  } else if (event.type === 'transport_closed') {
    _transportConvId = null;
    const task = await Storage.getActiveTask(convId);
    if (task && task.phase !== 'terminal' && task.taskId) {
      broadcast({ convId, type: 'transport_status', data: 'reconnecting' });
      scheduleRetry(convId);
    }
  } else if (event.type === 'stream_error') {
    const task = await Storage.getActiveTask(convId);
    if (task && task.phase !== 'terminal' && task.taskId) {
      broadcast({ convId, type: 'transport_status', data: 'reconnecting' });
      scheduleRetry(convId);
    }
  }
  broadcast(event);
}

function broadcast(event) {
  if (sidebarPort) {
    sidebarPort.postMessage(event);
  }
}

function handleMessage(msg, port) {
  switch (msg.type) {
    case 'FETCH_AGENTS':
      fetchAgents(msg.requestId).then(result => {
        port.postMessage({ type: 'AGENTS_LIST', data: result, requestId: msg.requestId });
      }).catch(err => {
        port.postMessage({ type: 'ERROR', data: err.message, requestId: msg.requestId });
      });
      break;

    case 'SEND_MESSAGE':
      handleSendMessage(msg, port);
      break;

    case 'ANSWER_QUESTION':
      handleAnswerQuestion(msg, port);
      break;

    case 'CANCEL_TASK':
      handleCancelTask(msg, port);
      break;

    case 'GET_PAGE_CONTEXT':
      handleGetPageContext(msg, port);
      break;

    case 'CAPTURE_SCREENSHOT':
      handleCaptureScreenshot(msg, port);
      break;

    case 'STATE_SYNC':
      handleStateSync(port);
      break;

    case 'DELETE_CONVERSATION':
      handleDeleteConversation(msg, port);
      break;

    case 'NEW_CONVERSATION':
      handleNewConversation(msg, port);
      break;

    case 'SWITCH_CONVERSATION':
      handleSwitchConversation(msg, port);
      break;

    case 'SET_LAST_AGENT':
      handleSetLastAgent(msg, port);
      break;
  }
}

async function fetchAgents(requestId) {
  const config = await Storage.getServerConfig();
  if (!config.baseUrl) throw new Error('Server URL not configured');
  mgr.client = new (await import('./a2a-client.js')).A2AClient(config);
  return mgr.client.fetchAgents();
}

async function handleSendMessage(msg, port) {
  try {
    const { convId, parts, contextParts } = msg.data;
    if (!convId) { port.postMessage({ type: 'stream_error', convId, data: 'No conversation selected' }); return; }
    const conv = await Storage.getConversationById(convId);
    if (!conv) { port.postMessage({ type: 'stream_error', convId, data: 'Conversation not found' }); return; }
    abortLocalTransport();
    const result = await mgr.sendMessage(convId, parts, contextParts || []);
    if (!result) { port.postMessage({ type: 'stream_error', convId, data: 'Failed to send message' }); return; }
    streamHandle = await mgr.startStream(convId, (event) => { onStreamEvent(convId, event); });
    if (streamHandle) _transportConvId = convId;
  } catch (err) { port.postMessage({ type: 'stream_error', convId: msg.data?.convId, data: err.message }); }
}

async function handleAnswerQuestion(msg, port) {
  try {
    const { convId, text, answeredQuestionMessageId } = msg.data;
    if (!convId || !text) { port.postMessage({ type: 'stream_error', convId, data: 'Invalid answer' }); return; }
    abortLocalTransport();
    const result = await mgr.continueInputRequiredTask(convId, [text], answeredQuestionMessageId);
    if (!result) { port.postMessage({ type: 'stream_error', convId, data: 'Task no longer input-required' }); return; }

    // The question and answer have been persisted before streaming resumes. Push
    // the updated transcript immediately instead of waiting for a terminal task sync.
    port.postMessage({ type: 'STATE_SYNC', data: await Storage.getState() });

    streamHandle = await mgr.startStream(convId, (event) => { onStreamEvent(convId, event); });
    if (streamHandle) _transportConvId = convId;
  } catch (err) { port.postMessage({ type: 'stream_error', convId: msg.data?.convId, data: err.message }); }
}

async function handleCancelTask(msg, port) {
  const convId = msg.data?.convId;
  const resultConvId = await mgr.cancelCurrentTask(convId);
  if (resultConvId) {
    abortLocalTransport();
    await mgr.finalizeTask(resultConvId, null, 'TASK_STATE_CANCELED');
    if (port) port.postMessage({ convId: resultConvId, type: 'stream_end', data: 'TASK_STATE_CANCELED' });
    resetRetryState();
  } else if (port) { port.postMessage({ convId, type: 'stream_error', data: 'Cancel failed' }); }
}

async function handleDeleteConversation(msg, port) {
  const { convId } = msg.data;
  const task = await Storage.getActiveTask(convId);
  if (task && task.taskId && task.phase !== 'terminal') {
    broadcast({ convId, type: 'stream_error', data: 'Cancel task before deleting conversation' });
    return;
  }
  if (convId === _transportConvId) {
    abortLocalTransport();
  }
  await Storage.deleteConversation(convId);
  await Storage.clearActiveTask(convId);
  resetRetryState();
  if (sidebarPort) {
    const state = await Storage.getState();
    sidebarPort.postMessage({ type: 'STATE_SYNC', data: state });
  }
}

async function handleNewConversation(msg, port) {
  const { agentName } = msg.data;
  const convId = await Storage.createConversation(agentName);
  await Storage.setLastSelectedAgent(agentName);
  const state = await Storage.getState();
  port.postMessage({ type: 'STATE_SYNC', data: state });
}

async function handleSwitchConversation(msg, port) {
  const { convId } = msg.data;
  abortLocalTransport();
  await Storage.setActiveConversationId(convId);
  const state = await Storage.getState();
  port.postMessage({ type: 'STATE_SYNC', data: state });
  const task = await Storage.getActiveTask(convId);
  const conv = await Storage.getConversationById(convId);
  const hasRecoverableTask = Boolean(
    (task && task.phase !== 'terminal' && task.taskId) ||
    (conv?.currentTaskId && conv.currentTaskState !== 'idle')
  );
  if (hasRecoverableTask) {
    broadcast({ convId, type: 'transport_status', data: 'checking' });
    const result = await mgr.reconcileTaskSnapshot(convId);
    if (result.state === 'alive') {
      tryResubscribe(convId);
    } else if (result.state === 'terminal' || result.state === 'input_required') {
      const fresh = await Storage.getState(); broadcast({ type: 'STATE_SYNC', data: fresh });
      if (result.state === 'input_required') {
        broadcast({ convId, taskId: result.taskId, type: 'input_required', data: result.question || null });
      }
    } else if (result.state === 'pending') {
      broadcast({ convId, type: 'transport_status', data: 'reconnecting' }); tryResubscribe(convId);
    } else { broadcast({ convId, type: 'transport_status', data: 'failed' }); }
  }
}

async function handleSetLastAgent(msg, port) {
  const { agentName } = msg.data;
  await Storage.setLastSelectedAgent(agentName);
}

async function handleGetPageContext(msg, port) {
  const { tabId, type } = msg.data;
  let parts = [];
  switch (type) {
    case 'selection':
      parts = await ContextExtractor.getSelection(tabId);
      break;
    case 'page_info':
      parts = await ContextExtractor.getPageInfo(tabId);
      break;
    case 'readable':
      parts = await ContextExtractor.getReadableText(tabId);
      break;
  }
  port.postMessage({ type: 'PAGE_CONTEXT', data: { type, parts }, requestId: msg.requestId });
}

async function handleCaptureScreenshot(msg, port) {
  const requestId = msg.requestId;
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(undefined, { format: 'png' });
    const match = /^data:(image\/png);base64,(.+)$/.exec(dataUrl || '');
    if (!match) throw new Error('Unable to encode screenshot');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    port.postMessage({
      type: 'PAGE_CONTEXT',
      data: {
        type: 'screenshot',
        parts: [{ raw: match[2], filename: `screenshot-${stamp}.png`, mediaType: match[1] }]
      },
      requestId
    });
  } catch (err) {
    port.postMessage({
      type: 'ERROR',
      data: `Could not capture screenshot: ${err.message}`,
      requestId
    });
  }
}

async function handleStateSync(port) {
  const state = await Storage.getState();
  port.postMessage({ type: 'STATE_SYNC', data: state });
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidebar-port') {
    sidebarPort = port;
    const doConnect = async () => {
      const state = await Storage.getState();
      const activeId = state.activeConversationId;
      if (activeId) {
        const task = await Storage.getActiveTask(activeId);
        const conv = state.conversations?.[activeId];
        const hasRecoverableTask = Boolean(
          (task && task.phase !== 'terminal' && task.taskId) ||
          (conv?.currentTaskId && conv.currentTaskState !== 'idle')
        );
        if (hasRecoverableTask) {
          broadcast({ convId: activeId, type: 'transport_status', data: 'checking' });
          const result = await mgr.reconcileTaskSnapshot(activeId);
          if (result.state === 'alive') { await tryResubscribe(activeId); }
          else if (result.state === 'terminal' || result.state === 'input_required') {
            const f = await Storage.getState(); broadcast({ type: 'STATE_SYNC', data: f });
            if (result.state === 'input_required') {
              broadcast({ convId: activeId, taskId: result.taskId, type: 'input_required', data: result.question || null });
            }
          } else if (result.state === 'pending') {
            broadcast({ convId: activeId, type: 'transport_status', data: 'reconnecting' }); await tryResubscribe(activeId);
          } else { broadcast({ convId: activeId, type: 'transport_status', data: 'failed' }); }
        }
      }
    };
    port.onDisconnect.addListener(() => {
      resetRetryState();
      abortLocalTransport();
      sidebarPort = null;
    });
    port.onMessage.addListener((msg) => {
      handleMessage(msg, port);
    });
    handleStateSync(port);
    doConnect();
  }
});

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

browser.commands.onCommand.addListener((command) => {
  if (command === 'toggle-sidebar') {
    browser.sidebarAction.toggle();
  }
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const state = await Storage.getState();
    let agentName = state.lastSelectedAgent || state.serverConfig.defaultAgent;
    if (!agentName) return;

    let convId = state.activeConversationId;
    const conv = convId ? await Storage.getConversationById(convId) : null;
    if (!conv || conv.agentName !== agentName) {
      convId = await Storage.createConversation(agentName);
      broadcast({ type: 'STATE_SYNC', data: await Storage.getState() });
    }

    if (info.menuItemId === 'agentcrew-selection' && info.selectionText) {
      broadcast({
        convId,
        type: 'CONTEXT_DATA',
        data: {
          type: 'selection',
          preview: info.selectionText.slice(0, 50),
          parts: [{ text: `Selected text:\n${info.selectionText}` }]
        }
      });
    } else if (info.menuItemId === 'agentcrew-image' && info.srcUrl) {
      // Stage image as context — extract from the tab's DOM (no CORS)
      const parts = await ContextExtractor.getImage(info.srcUrl, null, tab?.id);
      if (parts.length) {
        broadcast({
          convId,
          type: 'CONTEXT_DATA',
          data: {
            type: 'image',
            preview: parts[0]?.filename || 'image.png',
            parts
          }
        });
      }
    }
  } catch (err) {
    console.error('Context menu action failed:', err.message);
  }
});

init();