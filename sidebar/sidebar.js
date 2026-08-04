import { renderMarkdown } from '../lib/markdown-renderer.js';

let port = null;
let state = {};
let pendingContext = [];
let streamingMsgEl = null;
let streamText = '';
let streamArtifacts = new Map();
let convListOpen = false;
let pendingMessage = null;
let pendingQuestion = null;
let answerSubmitting = false;

// Explicit streaming state — not derived from DOM element
let streamingConvId = null;
let transportActive = false;
let taskActive = false;

const convToggleBtn = document.getElementById('convToggleBtn');
const closeConvListBtn = document.getElementById('closeConvListBtn');
const convListPanel = document.getElementById('convListPanel');
const overlay = document.getElementById('overlay');
const convList = document.getElementById('convList');
const agentSelect = document.getElementById('agentSelect');
const newChatBtn = document.getElementById('newChatBtn');
const refreshBtn = document.getElementById('refreshBtn');
const settingsBtn = document.getElementById('settingsBtn');
const statusBar = document.getElementById('statusBar');
const messageList = document.getElementById('messageList');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const contextBar = document.getElementById('contextBar');
const addPageInfo = document.getElementById('addPageInfo');
const addSelection = document.getElementById('addSelection');
const addReadable = document.getElementById('addReadable');
const addScreenshot = document.getElementById('addScreenshot');
const addScreenshotRegion = document.getElementById('addScreenshotRegion');

const ICONS = {
  send: 'send',
  stop: 'square',
  loading: 'loader',
  delete: 'trash-2',
  pending: 'clock',
  error: 'x-circle',
  success: 'check-circle',
  tool: 'tool',
  image: 'image',
  file: 'paperclip',
  selection: 'scissors',
  readable_text: 'book-open',
  page_info: 'file-text',
  screenshot: 'camera',
  screenshot_region: 'crop'
};

function iconHtml(name, className = 'icon') {
  return `<i data-feather="${name}" class="${className}" aria-hidden="true"></i>`;
}

function refreshIcons(root = document) {
  if (globalThis.feather) globalThis.feather.replace({ width: 16, height: 16 }, root);
}

function setButtonIcon(button, name, label) {
  button.innerHTML = iconHtml(name);
  if (label) {
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  refreshIcons(button);
}

refreshIcons();

function connect() {
  port = browser.runtime.connect({ name: 'sidebar-port' });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    statusBar.textContent = 'Disconnected';
    statusBar.className = 'status-bar error';
    setTimeout(connect, 2000);
  });
}

function handleMessage(msg) {
  const isConvStream = msg.type === 'stream_chunk' || msg.type === 'stream_end' ||
    msg.type === 'stream_error' || msg.type === 'input_required' ||
    msg.type === 'transport_closed' || msg.type === 'transport_status';
  if (isConvStream && msg.convId && msg.convId !== state.activeConversationId) {
    return;
  }

  switch (msg.type) {
    case 'STATE_SYNC':
      state = msg.data;
      renderAll();
      if (pendingMessage && state.activeConversationId) {
        const msgData = pendingMessage;
        pendingMessage = null;
        const userDiv = document.createElement('div');
        userDiv.className = 'message user';
        userDiv.textContent = msgData.parts.join(' ');
        messageList.appendChild(userDiv);
        messageList.scrollTop = messageList.scrollHeight;
        // Do NOT restore pendingContext — already embedded in contextParts
        setButtonIcon(sendBtn, ICONS.loading, 'Sending');
        sendBtn.disabled = true;
        port.postMessage({
          type: 'SEND_MESSAGE',
          data: { convId: state.activeConversationId, parts: msgData.parts, contextParts: msgData.contextParts }
        });
      }
      break;
    case 'AGENTS_LIST':
      renderAgents(msg.data);
      break;
    case 'stream_chunk':
      handleStreamChunk(msg.data, msg.append);
      break;
    case 'stream_end':
      handleStreamEnd(msg.data);
      break;
    case 'stream_error':
      handleStreamError(msg.data);
      break;
    case 'input_required':
      handleInputRequired(msg.data || null);
      break;
    case 'transport_closed':
      handleTransportClosed();
      break;
    case 'transport_status':
      handleTransportStatus(msg.data);
      break;
    case 'PAGE_CONTEXT':
      handlePageContext(msg.data);
      break;
    case 'SCREENSHOT_REGION_CAPTURED':
      cropScreenshotRegion(msg.data).catch(err => {
        statusBar.textContent = `Could not crop screenshot region: ${err.message}`;
        statusBar.className = 'status-bar error';
      }).finally(() => {
        addScreenshotRegion.disabled = Boolean(taskActive || pendingQuestion);
      });
      break;
    case 'SCREENSHOT_REGION_CANCELLED':
      statusBar.textContent = 'Screenshot selection cancelled';
      statusBar.className = 'status-bar';
      addScreenshotRegion.disabled = Boolean(taskActive || pendingQuestion);
      break;
    case 'CONTEXT_DATA':
      handleContextData(msg.data);
      break;
    case 'ERROR':
      statusBar.textContent = msg.data;
      statusBar.className = 'status-bar error';
      addScreenshot.disabled = Boolean(taskActive || pendingQuestion);
      addScreenshotRegion.disabled = Boolean(taskActive || pendingQuestion);
      break;
  }
}

function handleTransportClosed() {
  transportActive = false;
  if (streamingMsgEl) {
    streamingMsgEl.classList.remove('streaming');
  }
  statusBar.textContent = 'Reconnecting...';
  statusBar.className = 'status-bar';
  updateButtonState();
}

function handleTransportStatus(status) {
  if (status === 'connecting') {
    statusBar.textContent = 'Starting...';
    statusBar.className = 'status-bar connected';
  } else if (status === 'resubscribed') {
    transportActive = true;
    streamingConvId = state.activeConversationId;
    statusBar.textContent = 'Streaming...';
    statusBar.className = 'status-bar connected';
    if (!streamingMsgEl) {
      streamingMsgEl = document.createElement('div');
      streamingMsgEl.className = 'message assistant streaming';
      messageList.appendChild(streamingMsgEl);
      streamText = '';
    }
    updateButtonState();
  } else if (status === 'reconnecting') {
    transportActive = false;
    if (streamingMsgEl) {
      streamingMsgEl.classList.remove('streaming');
    }
    statusBar.textContent = 'Reconnecting...';
    statusBar.className = 'status-bar';
  } else if (status === 'checking') {
    statusBar.textContent = 'Checking task...';
    statusBar.className = 'status-bar';
  } else if (status === 'retry') {
    statusBar.textContent = 'Retrying...';
    statusBar.className = 'status-bar';
  } else if (status === 'failed') {
    transportActive = false;
    // Keep taskActive derived from storage — don't clear it
    statusBar.textContent = 'Reconnect failed';
    statusBar.className = 'status-bar error';
    if (streamingMsgEl) {
      streamingMsgEl.classList.remove('streaming');
    }
    streamingMsgEl = null;
    streamText = '';
    streamingConvId = null;
    updateButtonState();
  }
}

function updateTaskState() {
  const activeTasks = state.activeTasks || {};
  const activeId = state.activeConversationId;
  const convTask = activeId ? activeTasks[activeId] : null;
  taskActive = !!(convTask && convTask.phase !== 'terminal' && convTask.taskId);
  if (!taskActive) {
    transportActive = false;
  }
}

function updateButtonState() {
  const inputRequired = Boolean(pendingQuestion);
  const processing = answerSubmitting || transportActive || taskActive;
  chatInput.disabled = inputRequired || answerSubmitting;
  addPageInfo.disabled = inputRequired || answerSubmitting;
  addSelection.disabled = inputRequired || answerSubmitting;
  addReadable.disabled = inputRequired || answerSubmitting;
  addScreenshot.disabled = inputRequired || processing;
  addScreenshotRegion.disabled = inputRequired || processing;
  if (answerSubmitting) {
    setButtonIcon(sendBtn, ICONS.loading, 'Sending');
    sendBtn.disabled = true;
  } else if (inputRequired || processing) {
    setButtonIcon(sendBtn, ICONS.stop, 'Stop');
    sendBtn.disabled = false;
  } else {
    setButtonIcon(sendBtn, ICONS.send, 'Send');
    sendBtn.disabled = false;
  }
}

function clearStreamState() {
  streamingMsgEl = null;
  streamText = '';
  streamArtifacts = new Map();
  streamArtifactElements = new Map();
  streamingConvId = null;
  transportActive = false;
  updateButtonState();
}

function renderAll() {
  if (state.serverConfig?.baseUrl) {
    statusBar.textContent = 'Connected';
    statusBar.className = 'status-bar connected';
    port.postMessage({ type: 'FETCH_AGENTS', requestId: 'agents_' + Date.now() });
  } else {
    statusBar.textContent = 'Not configured — open Settings to set up';
    statusBar.className = 'status-bar error';
  }

  updateTaskState();
  renderConversationList();
  renderActiveConversation();
  restorePendingQuestion();
  updateButtonState();
}

function renderConversationList() {
  const conversations = state.conversationOrder
    ?.map(id => state.conversations?.[id])
    .filter(Boolean) || [];

  convList.innerHTML = '';

  for (const conv of conversations) {
    const item = document.createElement('div');
    item.className = 'conv-list-item';
    if (conv.id === state.activeConversationId) {
      item.classList.add('active');
    }

    const lastMsg = conv.messages?.[conv.messages.length - 1];
    const preview = lastMsg
      ? lastMsg.parts?.[0]?.text?.slice(0, 30) || ''
      : '';
    const time = conv.updatedAt
      ? new Date(conv.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    item.innerHTML = `
      <div class="conv-item-content">
        <div class="conv-item-title">${escHtml(conv.title || 'Conversation')}</div>
        <div class="conv-item-meta">${escHtml(conv.agentName)}${preview ? ' · ' + escHtml(preview) : ''}${time ? ' · ' + time : ''}</div>
      </div>
      <button class="conv-item-del" data-conv-id="${conv.id}" title="Delete" aria-label="Delete conversation">${iconHtml(ICONS.delete)}</button>
    `;
    refreshIcons(item);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.conv-item-del')) return;
      port.postMessage({ type: 'SWITCH_CONVERSATION', data: { convId: conv.id } });
      toggleConvList();
    });

    const delBtn = item.querySelector('.conv-item-del');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Delete this conversation?')) return;
      port.postMessage({ type: 'DELETE_CONVERSATION', data: { convId: conv.id } });
    });

    convList.appendChild(item);
  }

  if (!conversations.length) {
    convList.innerHTML = '<div style="padding: 16px; text-align: center; color: #888; font-size: 12px;">No conversations</div>';
  }
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderActiveConversation() {
  const activeId = state.activeConversationId;
  const conv = activeId ? state.conversations?.[activeId] : null;

  if (streamingConvId && streamingConvId !== activeId) {
    clearStreamState();
    messageList.innerHTML = '';
  }

  if (conv) {
    if (!streamingMsgEl) {
      renderMessages(conv.messages);
    }
    agentSelect.value = conv.agentName;
  } else {
    clearStreamState();
    messageList.innerHTML = '<div class="empty-conv">No conversation selected. Use New conversation to start one.</div>';
  }
}

function renderAgents(agents) {
  agentSelect.innerHTML = '';
  if (!agents || !agents.length) {
    agentSelect.innerHTML = '<option>No agents found</option>';
    return;
  }
  agents.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = a.name;
    agentSelect.appendChild(opt);
  });

  const lastAgent = state.lastSelectedAgent || state.serverConfig?.defaultAgent;
  if (lastAgent && agentSelect.querySelector(`option[value="${escAttr(lastAgent)}"]`)) {
    agentSelect.value = lastAgent;
  }

  const activeId = state.activeConversationId;
  const conv = activeId ? state.conversations?.[activeId] : null;
  if (conv) {
    agentSelect.value = conv.agentName;
  }
}

function escAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderToolUses(toolUses) {
  if (!toolUses?.length) return '';
  return toolUses.map(t => {
    const isPending = t.status === 'pending';
    const isError = t.status === 'error';
    const isSuccess = t.status === 'success';
    const icon = isPending ? ICONS.pending : isError ? ICONS.error : isSuccess ? ICONS.success : ICONS.tool;
    const inputHtml = t.input ? escHtml(JSON.stringify(t.input, null, 2)) : '';
    const resultHtml = t.result ? escHtml(JSON.stringify(t.result, null, 2)) : '';
    const errorHtml = t.error ? escHtml(t.error) : '';
    return `<details class="tool-use">
      <summary class="tool-use-summary ${t.status}">${iconHtml(icon, 'tool-status-icon')} <code>${escHtml(t.name)}</code></summary>
      <div class="tool-use-body">
        ${inputHtml ? `<div class="tool-use-section"><strong>Input:</strong><pre>${inputHtml}</pre></div>` : ''}
        ${resultHtml ? `<div class="tool-use-section"><strong>Result:</strong><pre>${resultHtml}</pre></div>` : ''}
        ${errorHtml ? `<div class="tool-use-section tool-use-error"><strong>Error:</strong><pre>${errorHtml}</pre></div>` : ''}
        ${isPending ? '<div class="tool-use-pending">Running...</div>' : ''}
      </div>
    </details>`;
  }).join('');
}

function parseQuestionAnswers(answerText, questionCount) {
  if (!answerText) return [];
  if (questionCount <= 1) return [answerText.trim()];

  const answers = Array(questionCount).fill('');
  for (const line of answerText.split(/\r?\n/)) {
    const match = /^q(\d+)\s*:\s*(.*)$/i.exec(line.trim());
    if (match && Number(match[1]) < questionCount) answers[Number(match[1])] = match[2];
  }
  return answers;
}

function renderQuestionBlock(question, answerText = null) {
  if (!question) return '';
  const questions = question.questions || [];
  const answers = parseQuestionAnswers(answerText, Math.max(questions.length, 1));
  const isAnswered = answers.some(Boolean);
  let html = `<div class="question-block${isAnswered ? ' answered' : ''}" data-question-message-id="${escAttr(question.messageId || '')}" data-question-count="${questions.length}">`;
  if (question.instruction) html += `<p class="question-instruction">${escHtml(question.instruction)}</p>`;
  questions.forEach((questionItem, index) => {
    html += `<div class="question-item" data-question-index="${index}">`;
    html += `<p class="question-text">${escHtml(questionItem.question || '')}</p>`;
    if (isAnswered) {
      html += `<div class="question-answered-text">${escHtml(answers[index] || '')}</div>`;
    } else {
      if (questionItem.guided_answers?.length) {
        html += '<div class="guided-answers">';
        questionItem.guided_answers.forEach(answer => {
          html += `<button type="button" class="guided-btn" data-answer="${escAttr(answer)}">${escHtml(answer)}</button>`;
        });
        html += '</div>';
      }
      if (question.allowCustomAnswer !== false) {
        html += `<textarea class="question-answer" data-question-index="${index}" placeholder="Type your answer..."></textarea>`;
      }
    }
    html += '</div>';
  });
  if (!questions.length && !isAnswered && question.allowCustomAnswer !== false) {
    html += '<textarea class="question-answer" data-question-index="0" placeholder="Type your answer..."></textarea>';
  }
  if (!isAnswered) html += '<button type="button" class="question-submit">Submit answer</button>';
  html += '</div>';
  return html;
}

function renderAssistantMessage(msg, answerText = null) {
  const text = msg.parts.map(part => part.text || '').join('');
  let html = '';
  if (msg.segmentType === 'thinking') {
    html += `<section class="thinking-block" aria-label="Agent process">
      <div class="thinking-heading"><span class="thinking-marker" aria-hidden="true"></span><span>Agent process</span></div>
      <div class="thinking-content">${renderMarkdown(text)}</div>
    </section>`;
  } else if (text) {
    html += `<div class="assistant-text">${renderMarkdown(text)}</div>`;
  }
  if (msg.toolUses?.length) html += renderToolUses(msg.toolUses);
  if (msg.question) html += renderQuestionBlock(msg.question, answerText);
  return html;
}

function findPendingQuestion() {
  const convId = state.activeConversationId;
  const conv = convId ? state.conversations?.[convId] : null;
  if (!conv || conv.currentTaskState !== 'input-required' || !conv.currentTaskId) return null;
  for (let i = (conv.messages || []).length - 1; i >= 0; i--) {
    const message = conv.messages[i];
    if (message.role === 'assistant' && message.taskId === conv.currentTaskId && message.question) {
      return message.question;
    }
  }
  return null;
}

function restorePendingQuestion() {
  pendingQuestion = findPendingQuestion();
}



function renderMessageParts(parts) {
  let html = '';
  for (const part of parts || []) {
    if (part.kind === 'file' && part.file) {
      const isImage = part.file.mediaType?.startsWith('image/');
      const icon = isImage ? ICONS.image : ICONS.file;
      const label = part.file.filename || (isImage ? 'Image' : 'File');
      html += `<span class="context-attachment${isImage ? ' context-image' : ''}"><span class="context-icon">${iconHtml(icon)}</span>${escHtml(label)}</span>`;
    } else if (part.kind === 'context') {
      const icon = ICONS[part.contextType] || ICONS.page_info;
      const label = part.preview || part.text || 'Attached context';
      html += `<span class="context-attachment context-chip-message"><span class="context-icon">${iconHtml(icon)}</span>${escHtml(label)}</span>`;
    } else if (part.kind === 'text' && part.text) {
      html += `<span class="msg-text">${escHtml(part.text)}</span>`;
    }
  }
  return html;
}

// The agent's periodic status check can re-emit the same question/artifact while the
// user is still typing an answer. Every re-render below rebuilds the DOM, which would
// otherwise discard in-progress answers. Capture draft text (and the focused field)
// before a rebuild and restore it afterwards.
function captureDraftAnswers(root) {
  const drafts = new Map();
  const focused = root.querySelector('.question-answer:focus');
  const focusedBlock = focused ? focused.closest('.question-block') : null;
  root.querySelectorAll('.question-block').forEach(block => {
    const values = [...block.querySelectorAll('.question-answer')].map(input => input.value);
    if (values.some(value => value.length)) {
      drafts.set(block.dataset.questionMessageId || '', values);
    }
  });
  return {
    drafts,
    focusedKey: focusedBlock ? (focusedBlock.dataset.questionMessageId || '') : null,
    focusedIndex: focusedBlock ? [...focusedBlock.querySelectorAll('.question-answer')].indexOf(focused) : null
  };
}

function restoreDraftAnswers(root, capture) {
  if (!capture) return;
  if (capture.drafts.size) {
    root.querySelectorAll('.question-block').forEach(block => {
      const values = capture.drafts.get(block.dataset.questionMessageId || '');
      if (!values) return;
      block.querySelectorAll('.question-answer').forEach((input, index) => {
        if (values[index] !== undefined && input.value !== values[index]) {
          input.value = values[index];
        }
      });
    });
  }
  if (capture.focusedKey !== null && capture.focusedIndex !== null) {
    const block = [...root.querySelectorAll('.question-block')]
      .find(b => (b.dataset.questionMessageId || '') === capture.focusedKey);
    const input = block ? block.querySelectorAll('.question-answer')[capture.focusedIndex] : null;
    if (input) input.focus();
  }
}

function findQuestionBlock(messageId) {
  if (!messageId) return null;
  const escaped = String(messageId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return messageList.querySelector(`.question-block[data-question-message-id="${escaped}"]`);
}

function renderMessages(messages) {
  const draftState = captureDraftAnswers(messageList);
  messageList.innerHTML = '';
  if (!messages?.length) {
    messageList.innerHTML = '<div class="empty-conv">Start a conversation by typing below!</div>';
    return;
  }
  const answersByQuestionId = new Map();
  messages.forEach(message => {
    if (message.role === 'user' && message.answeredQuestionMessageId) {
      answersByQuestionId.set(message.answeredQuestionMessageId, message.parts.map(part => part.text || '').join(''));
    }
  });
  messages.forEach(msg => {
    // A linked answer is rendered directly beneath its corresponding question,
    // not again as a separate user bubble later in the transcript.
    if (msg.role === 'user' && msg.answeredQuestionMessageId) return;

    const div = document.createElement('div');
    div.className = `message ${msg.role}${msg.segmentType ? ` ${msg.segmentType}-message` : ''}`;
    if (msg.role === 'assistant') {
      const answerText = msg.question ? answersByQuestionId.get(msg.question.messageId) : null;
      div.innerHTML = renderAssistantMessage(msg, answerText);
    } else {
      div.innerHTML = renderMessageParts(msg.parts);
    }
    messageList.appendChild(div);
  });
  refreshIcons(messageList);
  restoreDraftAnswers(messageList, draftState);
  messageList.scrollTop = messageList.scrollHeight;
}

let streamArtifactElements = new Map();

function renderLiveArtifacts() {
  for (const [segmentId, record] of streamArtifacts) {
    const html = renderAssistantMessage({
      role: 'assistant',
      parts: record.text ? [{ kind: 'text', text: record.text }] : [],
      segmentType: record.segmentType,
      toolUses: record.toolUses,
      question: record.question
    });
    let el = streamArtifactElements.get(segmentId);

    // The agent's interval check can re-emit a question artifact after a state
    // refresh cleared the streaming maps. Reuse the block already shown in the
    // transcript instead of appending a duplicate question.
    if (!el && record.question?.messageId) {
      const existingBlock = findQuestionBlock(record.question.messageId);
      if (existingBlock) {
        el = existingBlock.closest('.message');
        if (el) streamArtifactElements.set(segmentId, el);
      }
    }

    if (!el) {
      el = document.createElement('div');
      el.className = `message assistant${record.segmentType ? ` ${record.segmentType}-message` : ''}`;
      messageList.appendChild(el);
      streamArtifactElements.set(segmentId, el);
      el.innerHTML = html;
    } else if (el.innerHTML !== html) {
      // Preserve any in-progress answer when a later chunk re-renders the block.
      const draftState = captureDraftAnswers(el);
      el.innerHTML = html;
      restoreDraftAnswers(el, draftState);
    }
  }
  refreshIcons(messageList);
  messageList.scrollTop = messageList.scrollHeight;
}

function handleStreamChunk(data, legacyAppend) {
  answerSubmitting = false;
  const payload = typeof data === 'string' ? { text: data, append: legacyAppend !== false } : (data || {});
  const artifactId = payload.artifactId || 'default';
  const segmentId = payload.segmentId || artifactId;
  const append = payload.append !== false;
  const previous = streamArtifacts.get(segmentId) || {
    text: '',
    toolUses: [],
    question: null,
    segmentType: artifactId.startsWith('thinking_') ? 'thinking' : 'text'
  };
  const text = payload.fullText ?? (append ? previous.text + (payload.text || '') : (payload.text || ''));
  const toolMap = new Map(previous.toolUses.map(tool => [tool.id || `${tool.name}:${JSON.stringify(tool.input || {})}`, tool]));
  for (const tool of payload.toolUses || []) {
    const id = tool.id || `${tool.name}:${JSON.stringify(tool.input || {})}`;
    toolMap.set(id, { ...toolMap.get(id), ...tool });
  }
  streamArtifacts.set(segmentId, {
    text,
    toolUses: [...toolMap.values()],
    question: payload.question || previous.question,
    segmentType: payload.segmentType || (artifactId.startsWith('thinking_') ? 'thinking' : previous.segmentType)
  });

  transportActive = true;
  streamingConvId = state.activeConversationId;
  statusBar.textContent = 'Streaming...';
  statusBar.className = 'status-bar connected';
  updateButtonState();
  renderLiveArtifacts();
}

function handleStreamEnd(endState) {
  clearStreamState();
  statusBar.textContent = 'Connected';
  statusBar.className = 'status-bar connected';
  port.postMessage({ type: 'STATE_SYNC' });
}

function handleStreamError(err) {
  answerSubmitting = false;
  statusBar.textContent = `Error: ${err}`;
  statusBar.className = 'status-bar error';
  if (streamingMsgEl) {
    streamingMsgEl.classList.remove('streaming');
    streamingMsgEl.innerHTML += `<br><em class="stream-error">[Error: ${err}]</em>`;
  }
  transportActive = false;
  streamingConvId = null;
  streamingMsgEl = null;
  streamText = '';
  updateButtonState();
}

function handleInputRequired(question) {
  answerSubmitting = false;
  transportActive = false;
  if (question) {
    // The agent's interval check can re-emit the same input-required status
    // repeatedly while the user is typing. Keep the question already on screen
    // (and its in-progress answer) instead of replacing it on every tick.
    if (!pendingQuestion || pendingQuestion.messageId !== question.messageId) {
      pendingQuestion = question;
    }
  } else {
    restorePendingQuestion();
  }
  statusBar.textContent = 'Agent needs your input';
  statusBar.className = 'status-bar';
  clearStreamState();
  updateButtonState();
}

function submitQuestionAnswer(questionBlock, directAnswer = null) {
  const convId = state.activeConversationId;
  if (!convId || !port) return;

  const answerInputs = [...questionBlock.querySelectorAll('.question-answer')];
  const questionCount = Number(questionBlock.dataset.questionCount || answerInputs.length || 1);
  const answers = answerInputs.map(input => input.value.trim());
  if (directAnswer !== null) answers[0] = directAnswer;
  if (!answers.some(Boolean)) {
    statusBar.textContent = 'Select or enter an answer first';
    statusBar.className = 'status-bar error';
    return;
  }

  const answer = questionCount > 1
    ? answers.map((value, index) => `q${index}: ${value}`).join('\n')
    : (answers[0] || directAnswer || '');
  if (!answer.trim()) return;

  questionBlock.querySelectorAll('button, textarea').forEach(element => { element.disabled = true; });
  statusBar.textContent = 'Sending answer...';
  statusBar.className = 'status-bar connected';
  port.postMessage({
    type: 'ANSWER_QUESTION',
    data: {
      convId,
      text: answer,
      answeredQuestionMessageId: questionBlock.dataset.questionMessageId || null
    }
  });
}

messageList.addEventListener('click', event => {
  const guidedButton = event.target.closest('.guided-btn');
  if (guidedButton) {
    const questionItem = guidedButton.closest('.question-item');
    const questionBlock = guidedButton.closest('.question-block');
    const answerInput = questionItem?.querySelector('.question-answer');
    questionItem?.querySelectorAll('.guided-btn').forEach(button => button.classList.toggle('selected', button === guidedButton));
    if (answerInput) {
      answerInput.value = guidedButton.dataset.answer || '';
      answerInput.focus();
    } else if (questionBlock) {
      submitQuestionAnswer(questionBlock, guidedButton.dataset.answer || '');
    }
    return;
  }

  const submitButton = event.target.closest('.question-submit');
  if (submitButton) {
    const questionBlock = submitButton.closest('.question-block');
    if (questionBlock) submitQuestionAnswer(questionBlock);
  }
});

function handleContextData(data) {
  if (!data || !data.parts?.length) return;
  pendingContext.push({ type: data.type || 'context', preview: data.preview || '', parts: data.parts });
  renderContextBar();
}

async function cropScreenshotRegion(data) {
  if (!data?.dataUrl || !data.region) throw new Error('Missing captured image or selection');

  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Unable to decode captured screenshot'));
    img.src = data.dataUrl;
  });

  const { region } = data;
  const scaleX = image.naturalWidth / region.viewportWidth;
  const scaleY = image.naturalHeight / region.viewportHeight;
  const sourceX = Math.max(0, Math.round(region.x * scaleX));
  const sourceY = Math.max(0, Math.round(region.y * scaleY));
  const sourceWidth = Math.min(image.naturalWidth - sourceX, Math.max(1, Math.round(region.width * scaleX)));
  const sourceHeight = Math.min(image.naturalHeight - sourceY, Math.max(1, Math.round(region.height * scaleY)));

  const canvas = document.createElement('canvas');
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);

  const croppedDataUrl = canvas.toDataURL('image/png');
  const match = /^data:(image\/png);base64,(.+)$/.exec(croppedDataUrl);
  if (!match) throw new Error('Unable to encode cropped screenshot');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  handlePageContext({
    type: 'screenshot_region',
    parts: [{ raw: match[2], filename: `screenshot-region-${stamp}.png`, mediaType: match[1] }]
  });
  statusBar.textContent = 'Screenshot region attached';
  statusBar.className = 'status-bar connected';
}

function handlePageContext(data) {
  const isImage = data.type === 'screenshot' || data.type === 'screenshot_region' || data.parts?.some(part => part.mediaType?.startsWith('image/'));
  const preview = isImage
    ? (data.parts?.[0]?.filename || 'Screenshot')
    : data.parts.map(part => part.text || '').join('').slice(0, 50);
  pendingContext.push({ type: data.type, preview, parts: data.parts });
  renderContextBar();
}

function renderContextBar() {
  contextBar.innerHTML = '';
  pendingContext.forEach((ctx, i) => {
    const chip = document.createElement('div');
    chip.className = 'context-chip';
    const icon = ICONS[ctx.type] || ICONS.readable_text;
    chip.innerHTML = `${iconHtml(icon)} <span>${escHtml(ctx.preview)}</span> <button type="button" class="remove" data-idx="${i}" aria-label="Remove attachment">${iconHtml('x')}</button>`;
    contextBar.appendChild(chip);
  });
  refreshIcons(contextBar);
  contextBar.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingContext.splice(parseInt(btn.dataset.idx), 1);
      renderContextBar();
    });
  });
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && !pendingContext.length) return;

  const activeId = state.activeConversationId;
  if (!activeId) {
    const agent = agentSelect.value;
    if (!agent) return;
    pendingMessage = { parts: text ? [text] : ['See attached context'], contextParts: [], pendingCtx: pendingContext.slice() };
    for (const ctx of pendingContext) {
      for (const p of ctx.parts) {
        pendingMessage.contextParts.push(p);
      }
    }
    const userDiv = document.createElement('div');
    userDiv.className = 'message user';
    userDiv.innerHTML = renderMessageParts(pendingMessage.parts.map(t => ({ kind: 'text', text: t })).concat(
      pendingMessage.contextParts.map(p => p.text
        ? { kind: 'text', text: p.text }
        : { kind: 'file', file: { filename: p.filename, mediaType: p.mediaType, _raw: p.raw } }
      )
    ).filter(Boolean));
    messageList.appendChild(userDiv);
    refreshIcons(userDiv);
    messageList.scrollTop = messageList.scrollHeight;

    chatInput.value = '';
    chatInput.style.height = 'auto';
    pendingContext = [];
    renderContextBar();
    sendBtn.disabled = true;
    setButtonIcon(sendBtn, ICONS.loading, 'Sending');
    port.postMessage({ type: 'NEW_CONVERSATION', data: { agentName: agent } });
    return;
  }

  const conv = state.conversations?.[activeId];
  if (!conv) return;

  const parts = text ? [text] : ['See attached context'];
  const contextParts = [];
  for (const ctx of pendingContext) {
    for (const p of ctx.parts) {
      contextParts.push(p);
    }
  }

  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.innerHTML = renderMessageParts(parts.map(t => ({ kind: 'text', text: t })).concat(
    contextParts.map(p => p.text
      ? { kind: 'text', text: p.text }
      : { kind: 'file', file: { filename: p.filename, mediaType: p.mediaType, _raw: p.raw } }
    )
  ));
  messageList.appendChild(userDiv);
  refreshIcons(userDiv);
  messageList.scrollTop = messageList.scrollHeight;

  port.postMessage({
    type: 'SEND_MESSAGE',
    data: { convId: activeId, parts, contextParts }
  });

  chatInput.value = '';
  chatInput.style.height = 'auto';
  pendingContext = [];
  renderContextBar();
  sendBtn.disabled = true;
  setButtonIcon(sendBtn, ICONS.loading, 'Sending');
}


function getActiveTab() {
  return browser.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]);
}

function toggleConvList() {
  convListOpen = !convListOpen;
  convListPanel.classList.toggle('hidden', !convListOpen);
  overlay.classList.toggle('hidden', !convListOpen);
}

convToggleBtn.addEventListener('click', () => {
  toggleConvList();
});

closeConvListBtn.addEventListener('click', () => {
  toggleConvList();
});

overlay.addEventListener('click', () => {
  toggleConvList();
});

newChatBtn.addEventListener('click', () => {
  const agent = agentSelect.value;
  if (!agent) return;
  port.postMessage({ type: 'NEW_CONVERSATION', data: { agentName: agent } });
});

refreshBtn.addEventListener('click', () => {
  port.postMessage({ type: 'FETCH_AGENTS', requestId: 'agents_' + Date.now() });
});

settingsBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});

agentSelect.addEventListener('change', () => {
  const agent = agentSelect.value;
  if (agent) {
    port.postMessage({ type: 'SET_LAST_AGENT', data: { agentName: agent } });
  }
});

sendBtn.addEventListener('click', () => {
  if (transportActive || taskActive) {
    port.postMessage({ type: 'CANCEL_TASK', data: { convId: state.activeConversationId } });
    sendBtn.disabled = true;
    setButtonIcon(sendBtn, ICONS.send, 'Send');
    transportActive = false;
    taskActive = false;
  } else {
    sendMessage();
  }
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!transportActive && !taskActive) {
      sendMessage();
    }
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  const maxH = 120;
  const newH = Math.min(chatInput.scrollHeight, maxH);
  chatInput.style.height = newH + 'px';
});

addPageInfo.addEventListener('click', async () => {
  const tab = await getActiveTab();
  port.postMessage({ type: 'GET_PAGE_CONTEXT', data: { tabId: tab.id, type: 'page_info' } });
});

addSelection.addEventListener('click', async () => {
  const tab = await getActiveTab();
  port.postMessage({ type: 'GET_PAGE_CONTEXT', data: { tabId: tab.id, type: 'selection' } });
});

addReadable.addEventListener('click', async () => {
  const tab = await getActiveTab();
  port.postMessage({ type: 'GET_PAGE_CONTEXT', data: { tabId: tab.id, type: 'readable' } });
});

async function requestScreenshotPermission() {
  const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
  if (!granted) {
    statusBar.textContent = 'Screenshot permission was not granted';
    statusBar.className = 'status-bar error';
  }
  return granted;
}

addScreenshot.addEventListener('click', async () => {
  if (taskActive || pendingQuestion || !port) return;

  addScreenshot.disabled = true;
  try {
    if (!await requestScreenshotPermission()) return;
    port.postMessage({ type: 'CAPTURE_SCREENSHOT' });
  } catch (err) {
    statusBar.textContent = `Could not request screenshot permission: ${err.message}`;
    statusBar.className = 'status-bar error';
  } finally {
    addScreenshot.disabled = Boolean(taskActive || pendingQuestion);
  }
});

addScreenshotRegion.addEventListener('click', async () => {
  if (taskActive || pendingQuestion || !port) return;

  addScreenshotRegion.disabled = true;
  try {
    if (!await requestScreenshotPermission()) {
      addScreenshotRegion.disabled = Boolean(taskActive || pendingQuestion);
      return;
    }
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active tab');
    statusBar.textContent = 'Drag on the page to select a screenshot area';
    statusBar.className = 'status-bar';
    port.postMessage({
      type: 'SELECT_SCREENSHOT_REGION',
      data: { tabId: tab.id },
      requestId: 'screenshot_region_' + Date.now()
    });
  } catch (err) {
    statusBar.textContent = `Could not start screenshot selection: ${err.message}`;
    statusBar.className = 'status-bar error';
    addScreenshotRegion.disabled = Boolean(taskActive || pendingQuestion);
  }
});

connect();
