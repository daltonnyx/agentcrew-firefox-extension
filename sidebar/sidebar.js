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
let questionWizard = { step: 0, answers: [], useCustom: [], selectedAnswers: [] };
let questionSubmitting = false;
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
const questionPrompt = document.getElementById('questionPrompt');
const contextBar = document.getElementById('contextBar');
const addPageInfo = document.getElementById('addPageInfo');
const addSelection = document.getElementById('addSelection');
const addReadable = document.getElementById('addReadable');
const addScreenshot = document.getElementById('addScreenshot');

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
        // Re-add optimistic user bubble for the new conversation
        const userDiv = document.createElement('div');
        userDiv.className = 'message user';
        userDiv.textContent = msgData.parts.join(' ');
        messageList.appendChild(userDiv);
        messageList.scrollTop = messageList.scrollHeight;
        // Do NOT restore pendingContext — already embedded in contextParts
        sendBtn.textContent = '…';
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
    case 'CONTEXT_DATA':
      handleContextData(msg.data);
      break;
    case 'ERROR':
      statusBar.textContent = msg.data;
      statusBar.className = 'status-bar error';
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
  if (answerSubmitting) {
    sendBtn.textContent = '…';
    sendBtn.disabled = true;
  } else if (inputRequired || processing) {
    sendBtn.textContent = '⏹';
    sendBtn.disabled = false;
  } else {
    sendBtn.textContent = '▶';
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
    statusBar.textContent = 'Not configured - click ⚙ to set up';
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
      <button class="conv-item-del" data-conv-id="${conv.id}" title="Delete">🗑</button>
    `;

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

  // If switching conversations, clear old streaming state
  if (streamingConvId && streamingConvId !== activeId) {
    clearStreamState();
    messageList.innerHTML = '';
  }

  if (conv) {
    // Only render persisted messages if we don't have a streaming element already
    if (!streamingMsgEl) {
      renderMessages(conv.messages);
    }
    agentSelect.value = conv.agentName;
  } else {
    clearStreamState();
    messageList.innerHTML = '<div class="empty-conv">No conversation selected. Click ＋ to start a new one.</div>';
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
    const icon = isPending ? '⏳' : isError ? '❌' : isSuccess ? '✅' : '🔧';
    const inputHtml = t.input ? escHtml(JSON.stringify(t.input, null, 2)) : '';
    const resultHtml = t.result ? escHtml(JSON.stringify(t.result, null, 2)) : '';
    const errorHtml = t.error ? escHtml(t.error) : '';
    return `<details class="tool-use">
      <summary class="tool-use-summary ${t.status}">${icon} <code>${escHtml(t.name)}</code>${isSuccess ? ' ✓' : isError ? ' ✗' : ''}</summary>
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
    html += `<details class="thinking-block"><summary>Thinking</summary><div class="thinking-content">${renderMarkdown(text)}</div></details>`;
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
  const question = findPendingQuestion();
  if (!question) {
    pendingQuestion = null;
    questionSubmitting = false;
    questionPrompt.innerHTML = '';
    questionPrompt.classList.add('hidden');
    return;
  }
  if (!pendingQuestion || pendingQuestion.messageId !== question.messageId) {
    pendingQuestion = question;
    const count = Math.max(question.questions?.length || 0, 1);
    questionWizard = { step: 0, answers: Array(count).fill(''), useCustom: Array(count).fill(false), selectedAnswers: Array.from({ length: count }, () => new Set()) };
    questionSubmitting = false;
  }
  renderQuestionPrompt();
}

function questionItems(question) {
  const questions = question?.questions || [];
  return questions.length ? questions : [{ question: 'Please provide the requested information.', guided_answers: [] }];
}

function renderQuestionPrompt() {
  if (!pendingQuestion) return;
  const questions = questionItems(pendingQuestion);
  const step = Math.min(questionWizard.step, questions.length - 1);
  questionWizard.step = step;
  const current = questions[step];
  const guided = current.guided_answers || [];
  const selected = questionWizard.selectedAnswers[step] || new Set();
  const usingCustom = Boolean(questionWizard.useCustom[step]) || !guided.length;
  const answer = questionWizard.answers[step] || '';
  const isLast = step === questions.length - 1;
  const canAdvance = Boolean(answer.trim());
  const allAnswered = questionWizard.answers.every(value => value.trim());

  let html = '<div class="question-prompt-card">';
  html += '<div class="question-prompt-heading"><span class="question-prompt-icon">?</span><div><strong>Agent needs your input</strong><span>Answer to continue this task</span></div></div>';
  if (pendingQuestion.instruction) html += `<p class="question-prompt-instruction">${escHtml(pendingQuestion.instruction)}</p>`;
  if (questions.length > 1) {
    html += `<div class="question-progress"><span style="width:${((step + 1) / questions.length) * 100}%"></span></div>`;
    html += `<div class="question-step-label">Question ${step + 1} of ${questions.length}</div>`;
  }
  html += `<p class="question-prompt-text">${escHtml(current.question || '')}</p>`;
  if (guided.length) {
    html += '<div class="guided-answers question-prompt-answers">';
    guided.forEach((option, index) => {
      const selectedClass = selected.has(option) ? ' selected' : '';
      html += `<button type="button" class="guided-btn${selectedClass}" data-question-action="guided" data-answer="${escAttr(option)}">${escHtml(option)}</button>`;
    });
    html += '</div>';
    html += `<button type="button" class="question-custom-toggle${usingCustom ? ' selected' : ''}" data-question-action="custom">${usingCustom ? 'Use guided answer' : 'Write a custom answer'}</button>`;
  }
  if (usingCustom) {
    html += `<textarea class="question-prompt-input" data-question-action="input" placeholder="Type your answer…">${escHtml(answer)}</textarea>`;
  }
  html += '<div class="question-prompt-actions">';
  if (step > 0) html += '<button type="button" class="question-nav-btn" data-question-action="back">Back</button>';
  html += '<span></span>';
  if (isLast) {
    html += `<button type="button" class="question-submit" data-question-action="submit" ${(!allAnswered || questionSubmitting) ? 'disabled' : ''}>${questionSubmitting ? 'Sending…' : 'Submit answer'}</button>`;
  } else {
    html += `<button type="button" class="question-submit" data-question-action="next" ${(!canAdvance || questionSubmitting) ? 'disabled' : ''}>Next</button>`;
  }
  html += '</div></div>';
  questionPrompt.innerHTML = html;
  questionPrompt.classList.remove('hidden');
}

function submitPendingQuestion() {
  const convId = state.activeConversationId;
  if (!convId || !pendingQuestion || !port) return;
  const questions = questionItems(pendingQuestion);
  if (questionWizard.answers.length !== questions.length || questionWizard.answers.some(answer => !answer.trim())) return;
  const text = questions.length === 1
    ? questionWizard.answers[0]
    : questionWizard.answers.map((answer, index) => `q${index}: ${answer}`).join('\n');
  const answeredQuestionMessageId = pendingQuestion.messageId || null;

  // Close immediately on submit, but retain a dedicated processing state until the
  // server starts the next turn or reports an error.
  pendingQuestion = null;
  questionSubmitting = false;
  answerSubmitting = true;
  questionPrompt.innerHTML = '';
  questionPrompt.classList.add('hidden');
  updateButtonState();

  statusBar.textContent = 'Sending answer…';
  statusBar.className = 'status-bar connected';
  port.postMessage({
    type: 'ANSWER_QUESTION',
    data: { convId, text, answeredQuestionMessageId }
  });
}

questionPrompt.addEventListener('click', event => {
  const button = event.target.closest('[data-question-action]');
  if (!button || !pendingQuestion || questionSubmitting) return;
  const questions = questionItems(pendingQuestion);
  const step = questionWizard.step;
  const action = button.dataset.questionAction;
  if (action === 'guided') {
    const answer = button.dataset.answer || '';
    const selected = new Set(questionWizard.selectedAnswers[step]);
    selected.has(answer) ? selected.delete(answer) : selected.add(answer);
    questionWizard.selectedAnswers[step] = selected;
    questionWizard.useCustom[step] = false;
    questionWizard.answers[step] = [...selected].join(', ');
    renderQuestionPrompt();
  } else if (action === 'custom') {
    questionWizard.useCustom[step] = !questionWizard.useCustom[step];
    if (questionWizard.useCustom[step]) {
      questionWizard.selectedAnswers[step] = new Set();
      questionWizard.answers[step] = '';
    }
    renderQuestionPrompt();
  } else if (action === 'back' && step > 0) {
    questionWizard.step--;
    renderQuestionPrompt();
  } else if (action === 'next' && questionWizard.answers[step].trim()) {
    questionWizard.step = Math.min(step + 1, questions.length - 1);
    renderQuestionPrompt();
  } else if (action === 'submit') {
    submitPendingQuestion();
  }
});

questionPrompt.addEventListener('input', event => {
  const input = event.target.closest('[data-question-action="input"]');
  if (!input || !pendingQuestion || questionSubmitting) return;
  questionWizard.answers[questionWizard.step] = input.value;
  const submit = questionPrompt.querySelector('[data-question-action="submit"], [data-question-action="next"]');
  if (submit) submit.disabled = !input.value.trim();
});

function renderMessageParts(parts) {
  let html = '';
  for (const part of parts || []) {
    if (part.kind === 'file' && part.file) {
      const isImage = part.file.mediaType?.startsWith('image/');
      const icon = isImage ? '🖼' : '📎';
      const label = part.file.filename || (isImage ? 'Image' : 'File');
      html += `<span class="context-attachment${isImage ? ' context-image' : ''}"><span class="context-icon">${icon}</span>${escHtml(label)}</span>`;
    } else if (part.kind === 'context') {
      const icon = part.contextType === 'selection' ? '✂' : part.contextType === 'readable_text' ? '📖' : '📄';
      const label = part.preview || part.text || 'Attached context';
      html += `<span class="context-attachment context-chip-message"><span class="context-icon">${icon}</span>${escHtml(label)}</span>`;
    } else if (part.kind === 'text' && part.text) {
      html += `<span class="msg-text">${escHtml(part.text)}</span>`;
    }
  }
  return html;
}

function renderMessages(messages) {
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
    div.className = `message ${msg.role}`;
    if (msg.role === 'assistant') {
      const answerText = msg.question ? answersByQuestionId.get(msg.question.messageId) : null;
      div.innerHTML = renderAssistantMessage(msg, answerText);
    } else {
      div.innerHTML = renderMessageParts(msg.parts);
    }
    messageList.appendChild(div);
  });
  messageList.scrollTop = messageList.scrollHeight;
}

// Maps ordered stream segment IDs to their live DOM elements.
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
    if (!el) {
      el = document.createElement('div');
      el.className = `message assistant${record.segmentType === 'tool' ? ' tool-message' : ''}`;
      messageList.appendChild(el);
      streamArtifactElements.set(segmentId, el);
    }
    el.innerHTML = html;
  }
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
  if (pendingQuestion && questionSubmitting) {
    questionSubmitting = false;
    renderQuestionPrompt();
  }
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
    pendingQuestion = question;
    const count = Math.max(questionItems(question).length, 1);
    questionWizard = { step: 0, answers: Array(count).fill(''), useCustom: Array(count).fill(false), selectedAnswers: Array.from({ length: count }, () => new Set()) };
    questionSubmitting = false;
    renderQuestionPrompt();
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

function handlePageContext(data) {
  const isImage = data.type === 'screenshot' || data.parts?.some(part => part.mediaType?.startsWith('image/'));
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
    const icon = ctx.type === 'selection' ? '✂' : ctx.type === 'page_info' ? '📄' : ctx.type === 'screenshot' ? '📷' : ctx.type === 'image' ? '🖼' : '📖';
    chip.innerHTML = `${icon} ${ctx.preview} <span class="remove" data-idx="${i}">×</span>`;
    contextBar.appendChild(chip);
  });
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
    // Immediately render user message with context in UI
    const userDiv = document.createElement('div');
    userDiv.className = 'message user';
    userDiv.innerHTML = renderMessageParts(pendingMessage.parts.map(t => ({ kind: 'text', text: t })).concat(
      pendingMessage.contextParts.map(p => p.text
        ? { kind: 'text', text: p.text }
        : { kind: 'file', file: { filename: p.filename, mediaType: p.mediaType, _raw: p.raw } }
      )
    ).filter(Boolean));
    messageList.appendChild(userDiv);
    messageList.scrollTop = messageList.scrollHeight;

    chatInput.value = '';
    chatInput.style.height = 'auto';
    pendingContext = [];
    renderContextBar();
    sendBtn.disabled = true;
    sendBtn.textContent = '…';
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

  // Immediately render user message with context in UI
  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.innerHTML = renderMessageParts(parts.map(t => ({ kind: 'text', text: t })).concat(
    contextParts.map(p => p.text
      ? { kind: 'text', text: p.text }
      : { kind: 'file', file: { filename: p.filename, mediaType: p.mediaType, _raw: p.raw } }
    )
  ));
  messageList.appendChild(userDiv);
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
  sendBtn.textContent = '…';
}


function getActiveTab() {
  return browser.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]);
}

function toggleConvList() {
  convListOpen = !convListOpen;
  convListPanel.classList.toggle('hidden', !convListOpen);
  overlay.classList.toggle('hidden', !convListOpen);
}

// ── Event listeners ──

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
    sendBtn.textContent = '▶';
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

addScreenshot.addEventListener('click', async () => {
  if (taskActive || pendingQuestion || !port) return;

  addScreenshot.disabled = true;
  try {
    const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) {
      statusBar.textContent = 'Screenshot permission was not granted';
      statusBar.className = 'status-bar error';
      return;
    }
    port.postMessage({ type: 'CAPTURE_SCREENSHOT' });
  } catch (err) {
    statusBar.textContent = `Could not request screenshot permission: ${err.message}`;
    statusBar.className = 'status-bar error';
  } finally {
    addScreenshot.disabled = Boolean(taskActive || pendingQuestion);
  }
});

connect();
