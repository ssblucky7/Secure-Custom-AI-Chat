const STORAGE_KEY = 'secureCustomAIStateV1';
const SETTINGS_KEY = 'secureCustomAISettingsV1';
const MAX_SAVED_CHATS = 30;

const state = {
  chats: [], currentChatId: null, isGenerating: false, abortController: null,
  serverConfig: { configured: false, defaultModel: '', allowedModels: [], maxTokensLimit: 8192 },
  settings: { protocol: 'openai', providerPreset: 'custom', providerUrl: '', apiKey: '', models: [], model: '', systemPrompt: 'You are a helpful AI assistant.', temperature: 0.7, maxTokens: 2048 },
  renderFrame: null, pendingRender: null, installPrompt: null
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const elements = {
  sidebar: $('#sidebar'), sidebarBackdrop: $('#sidebarBackdrop'), mobileMenu: $('#mobileMenu'), sidebarClose: $('#sidebarClose'),
  historyList: $('#historyList'), newChatBtn: $('#newChatBtn'), clearChatsBtn: $('#clearChatsBtn'), settingsBtn: $('#settingsBtn'),
  topModel: $('#topModel'), installBtn: $('#installBtn'), statusDot: $('#statusDot'), statusText: $('#statusText'), exportBtn: $('#exportBtn'),
  chat: $('#chat'), messages: $('#messages'), welcome: $('#welcome'), scrollBottomBtn: $('#scrollBottomBtn'),
  prompt: $('#prompt'), characterCount: $('#characterCount'), sendBtn: $('#sendBtn'), stopBtn: $('#stopBtn'),
  settingsDialog: $('#settingsDialog'), settingsForm: $('#settingsForm'), protocol: $('#protocol'), providerPreset: $('#providerPreset'), providerUrl: $('#providerUrl'), apiKey: $('#apiKey'), revealKeyBtn: $('#revealKeyBtn'), model: $('#model'), modelHelp: $('#modelHelp'), loadModelsBtn: $('#loadModelsBtn'), modelOptions: $('#modelOptions'), quickModels: $('#quickModels'), endpointPreview: $('#endpointPreview'),
  systemPrompt: $('#systemPrompt'), temperature: $('#temperature'), maxTokens: $('#maxTokens'), testBtn: $('#testBtn'),
  clearConfigBtn: $('#clearConfigBtn'), confirmDialog: $('#confirmDialog'), toastRegion: $('#toastRegion')
};

init();

async function init() {
  loadLocalState();
  bindEvents();
  renderHistory();
  renderConversation();
  syncComposer();
  await loadServerConfig();
  registerPwa();
  elements.prompt.focus();
}

function bindEvents() {
  setupFileAttachment();
  setupVoiceChat();
  elements.newChatBtn.addEventListener('click', newChat);
  elements.clearChatsBtn.addEventListener('click', requestClearChats);
  elements.settingsBtn.addEventListener('click', openSettings);
  elements.mobileMenu.addEventListener('click', openSidebar);
  elements.sidebarClose.addEventListener('click', closeSidebar);
  elements.sidebarBackdrop.addEventListener('click', closeSidebar);
  elements.sendBtn.addEventListener('click', sendMessage);
  elements.stopBtn.addEventListener('click', stopGeneration);
  elements.exportBtn.addEventListener('click', exportConversation);
  elements.scrollBottomBtn.addEventListener('click', () => scrollToBottom(true));
  elements.testBtn.addEventListener('click', testServer);
  elements.loadModelsBtn.addEventListener('click', loadModels);
  elements.providerPreset.addEventListener('change', applyProviderPreset);
  elements.protocol.addEventListener('change', updateEndpointPreview);
  elements.providerUrl.addEventListener('input', updateEndpointPreview);
  elements.model.addEventListener('change', handleModelChange);
  elements.model.addEventListener('blur', handleModelChange);
  elements.installBtn.addEventListener('click', installApp);
  elements.revealKeyBtn.addEventListener('click', toggleApiKeyVisibility);
  elements.clearConfigBtn.addEventListener('click', clearSavedConfiguration);
  elements.settingsForm.addEventListener('submit', saveSettings);
  elements.prompt.addEventListener('input', syncComposer);
  elements.prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  elements.chat.addEventListener('scroll', updateScrollButton, { passive: true });
  elements.messages.addEventListener('click', handleMessageAction);
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
      elements.prompt.value = button.dataset.prompt || '';
      syncComposer();
      elements.prompt.focus();
    });
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && elements.sidebar.classList.contains('open')) closeSidebar();
  });
}

async function loadServerConfig() {
  try {
    const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Could not load server configuration.');
    state.serverConfig = await response.json();
    if (!state.settings.providerUrl) state.settings.providerUrl = state.serverConfig.defaultProviderUrl || '';
    if (!state.settings.model) state.settings.model = state.serverConfig.defaultModel || '';
    elements.maxTokens.max = String(state.serverConfig.maxTokensLimit || 8192);
    state.settings.maxTokens = Math.min(state.settings.maxTokens, state.serverConfig.maxTokensLimit || 8192);
    updateModelUI();
    setStatus(state.serverConfig.configured ? 'Ready' : 'Server not configured', state.serverConfig.configured ? 'connected' : 'error');
  } catch (error) {
    setStatus('Server unavailable', 'error');
    showToast(error.message, 'error');
  }
}

function loadLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (Array.isArray(saved.chats)) state.chats = saved.chats.filter(validChat).slice(0, MAX_SAVED_CHATS);
    if (state.chats.some((chat) => chat.id === saved.currentChatId)) state.currentChatId = saved.currentChatId;
  } catch { state.chats = []; }
  try {
    const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (isPlaceholderApiKey(savedSettings.apiKey)) {
      savedSettings.apiKey = '';
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(savedSettings));
    }
    state.settings = sanitizeSettings({ ...state.settings, ...savedSettings });
  } catch { /* defaults remain */ }
}

function saveLocalState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chats: state.chats.slice(0, MAX_SAVED_CHATS), currentChatId: state.currentChatId }));
  } catch { showToast('Browser storage is full. Some chat history may not be saved.', 'error'); }
}

function saveLocalSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    showToast('Could not save AI setup in this browser.', 'error');
  }
}

function validChat(chat) {
  return chat && typeof chat.id === 'string' && typeof chat.title === 'string' && Array.isArray(chat.messages);
}

function currentChat() { return state.chats.find((chat) => chat.id === state.currentChatId) || null; }

function createChat() {
  const chat = { id: crypto.randomUUID(), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  trimChats();
  saveLocalState();
  return chat;
}

function newChat() {
  if (state.isGenerating) stopGeneration();
  state.currentChatId = null;
  saveLocalState();
  renderHistory();
  renderConversation();
  closeSidebar();
  setStatus(state.serverConfig.configured ? 'Ready' : 'Server not configured', state.serverConfig.configured ? 'connected' : 'error');
  elements.prompt.focus();
}

function requestClearChats() {
  if (!state.chats.length) return showToast('There is no saved history to clear.');
  elements.confirmDialog.showModal();
  elements.confirmDialog.addEventListener('close', onConfirmClear, { once: true });
}

function onConfirmClear() {
  if (elements.confirmDialog.returnValue !== 'confirm') return;
  if (state.isGenerating) stopGeneration();
  state.chats = [];
  state.currentChatId = null;
  saveLocalState();
  renderHistory();
  renderConversation();
  showToast('Chat history cleared.', 'success');
}

function renderHistory() {
  elements.historyList.replaceChildren();
  if (!state.chats.length) {
    const message = document.createElement('p');
    message.className = 'empty-history';
    message.textContent = 'Your conversations will appear here. API secrets are never stored in chat history.';
    elements.historyList.appendChild(message);
    return;
  }
  state.chats.forEach((chat) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `history-item${chat.id === state.currentChatId ? ' active' : ''}`;
    button.textContent = chat.title;
    button.title = chat.title;
    button.addEventListener('click', () => selectChat(chat.id));
    elements.historyList.appendChild(button);
  });
}

function selectChat(id) {
  if (state.isGenerating) stopGeneration();
  state.currentChatId = id;
  saveLocalState();
  renderHistory();
  renderConversation();
  closeSidebar();
}

function renderConversation() {
  elements.messages.replaceChildren();
  const chat = currentChat();
  if (!chat || !chat.messages.length) {
    elements.messages.appendChild(createWelcome());
    return;
  }
  chat.messages.forEach((message, index) => elements.messages.appendChild(createMessageElement(message, index)));
  requestAnimationFrame(() => scrollToBottom(false));
}

function createWelcome() {
  const section = document.createElement('section');
  section.className = 'welcome';
  section.setAttribute('aria-labelledby', 'welcomeTitleDynamic');
  section.innerHTML = '<div class="welcome-icon" aria-hidden="true">✦</div><h1 id="welcomeTitleDynamic">How can I help?</h1><p>Start a secure conversation with the AI model configured on this server.</p><div class="suggestions" aria-label="Suggested prompts"><button type="button" data-prompt="Explain this topic in simple steps: ">Explain a topic</button><button type="button" data-prompt="Review and improve this code:\n\n">Improve code</button><button type="button" data-prompt="Create a practical step-by-step plan for: ">Make a plan</button></div>';
  section.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
    elements.prompt.value = button.dataset.prompt || '';
    syncComposer();
    elements.prompt.focus();
  }));
  return section;
}

function createMessageElement(message, index) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  article.dataset.index = String(index);

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = message.role === 'user' ? 'You' : 'AI';

  const body = document.createElement('div');
  body.className = 'message-body';
  const header = document.createElement('div');
  header.className = 'message-header';
  const role = document.createElement('span');
  role.className = 'message-role';
  role.textContent = message.role === 'user' ? 'You' : 'Assistant';
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  actions.appendChild(actionButton('Copy', 'copy'));
  if (message.role === 'assistant') actions.appendChild(actionButton('Regenerate', 'regenerate'));
  header.append(role, actions);

  const content = document.createElement('div');
  content.className = 'message-content';
  if (message.pending) content.innerHTML = '<div class="typing" aria-label="AI is generating"><span></span><span></span><span></span></div>';
  else if (message.role === 'assistant') renderMarkdown(content, message.content);
  else renderPlainUserText(content, message.content);

  body.append(header, content);
  article.append(avatar, body);
  return article;
}

function actionButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action-btn';
  button.dataset.action = action;
  button.textContent = label;
  button.setAttribute('aria-label', `${label} message`);
  return button;
}

async function handleMessageAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const article = button.closest('.message');
  const index = Number(article?.dataset.index);
  const chat = currentChat();
  const message = chat?.messages[index];
  if (!message) return;
  if (button.dataset.action === 'copy') {
    const ok = await copyText(message.content);
    button.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => { button.textContent = 'Copy'; }, 1300);
  }
  if (button.dataset.action === 'regenerate') regenerateFrom(index);
}

async function sendMessage() {
  const text = elements.prompt.value.trim();
  if (!text || state.isGenerating) return;
  const setupError = validateSettings(state.settings);
  if (setupError) {
    showToast(setupError, 'error');
    openSettings();
    return;
  }
  let chat = currentChat();
  if (!chat) chat = createChat();
  chat.messages.push({ role: 'user', content: text });
  if (chat.messages.length === 1) chat.title = makeTitle(text);
  chat.updatedAt = Date.now();
  elements.prompt.value = '';
  syncComposer();
  saveLocalState();
  renderHistory();
  renderConversation();
  await requestAssistant(chat);
}

async function regenerateFrom(index) {
  if (state.isGenerating) return;
  const chat = currentChat();
  if (!chat || chat.messages[index]?.role !== 'assistant') return;
  chat.messages = chat.messages.slice(0, index);
  saveLocalState();
  renderConversation();
  await requestAssistant(chat);
}

async function requestAssistant(chat) {
  const pending = { role: 'assistant', content: '', pending: true };
  chat.messages.push(pending);
  const assistantIndex = chat.messages.length - 1;
  renderConversation();
  setGenerating(true);
  state.abortController = new AbortController();

  try {
    const apiMessages = [];
    if (state.settings.systemPrompt.trim()) apiMessages.push({ role: 'system', content: state.settings.systemPrompt.trim() });
    apiMessages.push(...chat.messages.slice(0, -1).map(({ role, content }) => ({ role, content })));

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
      body: JSON.stringify({
        protocol: state.settings.protocol,
        baseUrl: state.settings.providerUrl,
        apiKey: state.settings.apiKey,
        model: state.settings.model,
        messages: apiMessages,
        temperature: state.settings.temperature,
        maxTokens: state.settings.maxTokens
      }),
      signal: state.abortController.signal
    });

    if (!response.ok) throw new Error(await readError(response));
    if (!response.body) throw new Error('This browser does not support streaming responses.');

    const contentType = response.headers.get('content-type') || '';
    let answer = '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      answer = data.choices?.[0]?.message?.content || '';
      updatePending(chat, assistantIndex, answer);
    } else {
      answer = await readEventStream(response.body, (text) => updatePending(chat, assistantIndex, text));
    }

    if (!answer.trim()) throw new Error('The model returned an empty response.');
    chat.messages[assistantIndex] = { role: 'assistant', content: answer };
    chat.updatedAt = Date.now();
    saveLocalState();
    flushPendingRender(chat, assistantIndex, answer);
    setStatus('Connected', 'connected');
  } catch (error) {
    if (error.name === 'AbortError') {
      const partial = chat.messages[assistantIndex]?.content?.trim();
      if (partial) chat.messages[assistantIndex] = { role: 'assistant', content: `${partial}\n\n*Generation stopped.*` };
      else chat.messages.splice(assistantIndex, 1);
      showToast('Generation stopped.');
    } else {
      chat.messages[assistantIndex] = { role: 'assistant', content: `Error: ${error.message}` };
      setStatus('Request failed', 'error');
      showToast(error.message, 'error');
    }
    saveLocalState();
    renderConversation();
  } finally {
    state.abortController = null;
    setGenerating(false);
    elements.prompt.focus();
  }
}

async function readEventStream(stream, onUpdate) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const event of events) full = processSseEvent(event, full, onUpdate);
    if (done) break;
  }
  if (buffer.trim()) full = processSseEvent(buffer, full, onUpdate);
  return full;
}

function processSseEvent(event, current, onUpdate) {
  const lines = event.split(/\r?\n/);
  let result = current;
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const json = JSON.parse(data);
      if (json.error) throw new Error(typeof json.error === 'string' ? json.error : (json.error.message || 'Provider stream error.'));
      const delta = json.delta || '';
      if (delta) { result += delta; onUpdate(result); }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return result;
}

function updatePending(chat, index, content) {
  if (!chat.messages[index]) return;
  chat.messages[index].content = content;
  chat.messages[index].pending = false;
  state.pendingRender = { chatId: chat.id, index, content };
  if (state.renderFrame) return;
  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = null;
    const update = state.pendingRender;
    state.pendingRender = null;
    if (!update || update.chatId !== state.currentChatId) return;
    const article = elements.messages.querySelector(`[data-index="${update.index}"]`);
    const contentElement = article?.querySelector('.message-content');
    if (contentElement) renderMarkdown(contentElement, update.content);
    if (isNearBottom()) scrollToBottom(false);
  });
}

function flushPendingRender(chat, index, content) {
  if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
  state.renderFrame = null; state.pendingRender = null;
  if (chat.id !== state.currentChatId) return;
  const article = elements.messages.querySelector(`[data-index="${index}"]`);
  const contentElement = article?.querySelector('.message-content');
  if (contentElement) renderMarkdown(contentElement, content);
  scrollToBottom(false);
}

function stopGeneration() { state.abortController?.abort(); }

function setGenerating(active) {
  state.isGenerating = active;
  elements.sendBtn.hidden = active;
  elements.stopBtn.hidden = !active;
  elements.prompt.disabled = active;
  elements.sendBtn.disabled = active || !elements.prompt.value.trim();
  setStatus(active ? 'Generating' : (state.serverConfig.configured ? 'Ready' : 'Server not configured'), active ? 'busy' : (state.serverConfig.configured ? 'connected' : 'error'));
}

function renderPlainUserText(container, text) {
  container.replaceChildren();
  const lines = String(text).split('\n');
  lines.forEach((line, index) => {
    if (index) container.appendChild(document.createElement('br'));
    container.appendChild(document.createTextNode(line));
  });
}

function renderMarkdown(container, markdown) {
  container.replaceChildren();
  const fragments = tokenizeCodeBlocks(String(markdown || ''));
  fragments.forEach((fragment) => {
    if (fragment.type === 'code') container.appendChild(createCodeBlock(fragment.content, fragment.language));
    else appendTextMarkdown(container, fragment.content);
  });
}

function tokenizeCodeBlocks(text) {
  const parts = [];
  const regex = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0; let match;
  while ((match = regex.exec(text))) {
    if (match.index > last) parts.push({ type: 'text', content: text.slice(last, match.index) });
    parts.push({ type: 'code', language: match[1].trim().slice(0, 30), content: match[2].replace(/\n$/, '') });
    last = regex.lastIndex;
  }
  if (last < text.length) parts.push({ type: 'text', content: text.slice(last) });
  return parts.length ? parts : [{ type: 'text', content: text }];
}

function createCodeBlock(code, language) {
  const pre = document.createElement('pre');
  const codeElement = document.createElement('code');
  codeElement.textContent = code;
  const label = document.createElement('span');
  label.className = 'code-language';
  label.textContent = language || 'code';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-copy-btn';
  button.textContent = 'Copy code';
  button.addEventListener('click', async () => {
    const ok = await copyText(code);
    button.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => { button.textContent = 'Copy code'; }, 1300);
  });
  pre.append(label, button, codeElement);
  return pre;
}

function appendTextMarkdown(container, text) {
  const lines = text.replace(/^\n+|\n+$/g, '').split('\n');
  let list = null;
  const flushList = () => { if (list) { container.appendChild(list); list = null; } };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { flushList(); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList();
      const h = document.createElement(`h${heading[1].length}`);
      appendInline(h, heading[2]);
      container.appendChild(h);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const tag = unordered ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { flushList(); list = document.createElement(tag); }
      const li = document.createElement('li');
      appendInline(li, (unordered || ordered)[1]);
      list.appendChild(li);
      continue;
    }
    flushList();
    if (line.startsWith('> ')) {
      const quote = document.createElement('blockquote'); appendInline(quote, line.slice(2)); container.appendChild(quote);
    } else {
      const p = document.createElement('p'); appendInline(p, line); container.appendChild(p);
    }
  }
  flushList();
}

function appendInline(parent, text) {
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0; let match;
  while ((match = regex.exec(text))) {
    if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('`')) { const code = document.createElement('code'); code.textContent = token.slice(1, -1); parent.appendChild(code); }
    else if (token.startsWith('**')) { const strong = document.createElement('strong'); strong.textContent = token.slice(2, -2); parent.appendChild(strong); }
    else if (token.startsWith('*')) { const em = document.createElement('em'); em.textContent = token.slice(1, -1); parent.appendChild(em); }
    else {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      const link = document.createElement('a'); link.textContent = linkMatch[1]; link.href = linkMatch[2]; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.appendChild(link);
    }
    last = regex.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function openSettings() {
  elements.protocol.value = state.settings.protocol || 'openai';
  elements.providerPreset.value = state.settings.providerPreset || 'custom';
  elements.providerUrl.value = state.settings.providerUrl || state.serverConfig.defaultProviderUrl || '';
  elements.apiKey.value = state.settings.apiKey || '';
  elements.model.value = state.settings.model || state.serverConfig.defaultModel || '';
  elements.systemPrompt.value = state.settings.systemPrompt;
  elements.temperature.value = String(state.settings.temperature);
  elements.maxTokens.value = String(state.settings.maxTokens);
  renderQuickModels(state.settings.providerPreset);
  renderModelChips();
  updateEndpointPreview();
  elements.settingsDialog.showModal();
  requestAnimationFrame(() => elements.model.focus());
}

function saveSettings(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const candidate = sanitizeSettings({
    protocol: elements.protocol.value,
    providerPreset: elements.providerPreset.value,
    providerUrl: elements.providerUrl.value,
    apiKey: elements.apiKey.value,
    model: elements.model.value,
    systemPrompt: elements.systemPrompt.value,
    temperature: elements.temperature.value,
    maxTokens: elements.maxTokens.value
  });
  const error = validateSettings(candidate);
  if (error) return showToast(error, 'error');
  state.settings = candidate;
  saveLocalSettings();
  updateModelUI();
  elements.settingsDialog.close();
  showToast('AI setup saved in this browser.', 'success');
}

function sanitizeSettings(settings) {
  const models = Array.isArray(settings.models) 
    ? settings.models.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim().slice(0, 200)).slice(0, 20)
    : [String(settings.model || '').trim().slice(0, 200)].filter(Boolean);
  return {
    protocol: ['openai','anthropic'].includes(settings.protocol) ? settings.protocol : 'openai',
    providerPreset: String(settings.providerPreset || 'custom').slice(0,40),
    providerUrl: String(settings.providerUrl || '').trim().slice(0, 500),
    apiKey: String(settings.apiKey || '').trim().slice(0, 1000),
    model: models[0] || '',
    models: models,
    systemPrompt: String(settings.systemPrompt || '').trim().slice(0, 4000),
    temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.7,
    maxTokens: Number.isInteger(Number(settings.maxTokens)) ? Number(settings.maxTokens) : 2048
  };
}

function isPlaceholderApiKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return false;
  return [
    'replace_with_your_secret',
    'replace_with_your_server_side_secret',
    'your_real_api_key',
    'your_api_key',
    'sk-...',
    'test'
  ].includes(key) || key.includes('replace_with') || key.includes('your_secret');
}

function validateSettings(settings) {
  if (!settings.providerUrl) return 'Provider URL is required.';
  try { const url = new URL(settings.providerUrl); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); } catch { return 'Enter a valid HTTP or HTTPS provider URL.'; }
  if (!settings.model) return 'Model is required.';
  if (settings.apiKey && isPlaceholderApiKey(settings.apiKey)) return 'Remove the example API key and enter your real provider API key.';
  if (settings.temperature < 0 || settings.temperature > 2) return 'Temperature must be between 0 and 2.';
  if (settings.maxTokens < 1 || settings.maxTokens > state.serverConfig.maxTokensLimit) return `Maximum tokens must be between 1 and ${state.serverConfig.maxTokensLimit}.`;
  return '';
}

async function testServer() {
  const providerUrl = elements.providerUrl.value.trim();
  const apiKey = elements.apiKey.value.trim();
  const model = elements.model.value.trim();
  if (!providerUrl) return showToast('Enter a provider URL first.', 'error');
  if (!model) return showToast('Enter a model first.', 'error');
  elements.testBtn.disabled = true;
  elements.testBtn.textContent = 'Testing...';
  try {
    const response = await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: elements.protocol.value, baseUrl: providerUrl, apiKey, model }) });
    if (!response.ok) throw new Error(await readError(response));
    showToast('Server connection successful.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { elements.testBtn.disabled = false; elements.testBtn.textContent = 'Test connection'; }
}

const PROVIDERS = {
  'zenmux-openai': { protocol:'openai', baseUrl:'https://zenmux.ai/api/v1', models:['z-ai/glm-4.7-flash-free','z-ai/glm-4.6v-flash-free','deepseek/deepseek-v4-flash-free'] },
  'zenmux-anthropic': { protocol:'anthropic', baseUrl:'https://zenmux.ai/api/anthropic', models:['anthropic/claude-sonnet-4.5','anthropic/claude-opus-4.5'] },
  openai: { protocol:'openai', baseUrl:'https://api.openai.com/v1', models:['gpt-4.1-mini','gpt-4o-mini'] },
  anthropic: { protocol:'anthropic', baseUrl:'https://api.anthropic.com', models:['claude-sonnet-4-5','claude-haiku-4-5'] },
  openrouter: { protocol:'openai', baseUrl:'https://openrouter.ai/api/v1', models:[] },
  groq: { protocol:'openai', baseUrl:'https://api.groq.com/openai/v1', models:[] },
  together: { protocol:'openai', baseUrl:'https://api.together.xyz/v1', models:[] },
  deepseek: { protocol:'openai', baseUrl:'https://api.deepseek.com/v1', models:['deepseek-chat','deepseek-reasoner'] },
  mistral: { protocol:'openai', baseUrl:'https://api.mistral.ai/v1', models:[] },
  ollama: { protocol:'openai', baseUrl:'http://localhost:11434/v1', models:[] },
  lmstudio: { protocol:'openai', baseUrl:'http://localhost:1234/v1', models:[] }
};

function applyProviderPreset() {
  const preset = PROVIDERS[elements.providerPreset.value];
  if (!preset) { updateEndpointPreview(); renderQuickModels('custom'); return; }
  elements.protocol.value = preset.protocol;
  elements.providerUrl.value = preset.baseUrl;
  if (preset.models[0]) elements.model.value = preset.models[0];
  renderQuickModels(elements.providerPreset.value);
  updateEndpointPreview();
}
function renderQuickModels(presetName) {
  elements.quickModels.replaceChildren();
  const models = PROVIDERS[presetName]?.models || [];
  models.forEach(model => {
    const button=document.createElement('button'); button.type='button'; button.textContent=model;
    button.addEventListener('click',()=>{ elements.model.value=model; });
    elements.quickModels.appendChild(button);
  });
}
function updateEndpointPreview() {
  const base=elements.providerUrl.value.trim().replace(/\/+$/,'');
  if (!base) { elements.endpointPreview.textContent='Endpoint preview appears here.'; return; }
  let endpoint;
  if (elements.protocol.value==='anthropic') endpoint=/\/v1\/messages$/.test(base)?base:/\/v1$/.test(base)?`${base}/messages`:`${base}/v1/messages`;
  else endpoint=/\/chat\/completions$/.test(base)?base:/\/v1$/.test(base)?`${base}/chat/completions`:`${base}/v1/chat/completions`;
  elements.endpointPreview.textContent=`Request endpoint: ${endpoint}`;
}
async function loadModels() {
  const payload={ protocol:elements.protocol.value, baseUrl:elements.providerUrl.value.trim(), apiKey:elements.apiKey.value.trim() };
  if(!payload.baseUrl) return showToast('Enter a Base URL first.','error');
  elements.loadModelsBtn.disabled=true; elements.loadModelsBtn.textContent='Loading...';
  try{
    const response=await fetch('/api/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!response.ok) throw new Error(await readError(response));
    const data=await response.json(); elements.modelOptions.replaceChildren();
    data.models.forEach(id=>{const option=document.createElement('option');option.value=id;elements.modelOptions.appendChild(option)});
    if(data.models.length && !elements.model.value) elements.model.value=data.models[0];
    showToast(data.models.length?`${data.models.length} models loaded.`:'Provider returned no model list.',data.models.length?'success':'');
  }catch(error){showToast(error.message,'error')}
  finally{elements.loadModelsBtn.disabled=false;elements.loadModelsBtn.textContent='Load models'}
}
function registerPwa() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.installPrompt=event;elements.installBtn.hidden=false});
  window.addEventListener('appinstalled',()=>{state.installPrompt=null;elements.installBtn.hidden=true;showToast('App installed.','success')});
}
async function installApp() {
  if(!state.installPrompt) return showToast('Use your browser menu and choose Install app or Add to Home Screen.');
  state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt=null; elements.installBtn.hidden=true;
}

function clearSavedConfiguration() {
  localStorage.removeItem(SETTINGS_KEY);
  state.settings = sanitizeSettings({
    protocol: 'openai',
    providerPreset: 'custom',
    providerUrl: '',
    apiKey: '',
    models: [],
    model: state.serverConfig.defaultModel || '',
    systemPrompt: 'You are a helpful AI assistant.',
    temperature: 0.7,
    maxTokens: Math.min(2048, state.serverConfig.maxTokensLimit || 8192)
  });
  elements.protocol.value = state.settings.protocol;
  elements.providerPreset.value = state.settings.providerPreset;
  elements.providerUrl.value = state.settings.providerUrl;
  elements.apiKey.value = '';
  elements.model.value = state.settings.model;
  elements.systemPrompt.value = state.settings.systemPrompt;
  elements.temperature.value = String(state.settings.temperature);
  elements.maxTokens.value = String(state.settings.maxTokens);
  updateModelUI();
  renderModelChips();
  showToast('Saved AI setup and API key cleared.', 'success');
}

function toggleApiKeyVisibility() {
  const showing = elements.apiKey.type === 'text';
  elements.apiKey.type = showing ? 'password' : 'text';
  elements.revealKeyBtn.textContent = showing ? 'Show' : 'Hide';
  elements.revealKeyBtn.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
}

function updateModelUI() { elements.topModel.textContent = state.settings.model || state.serverConfig.defaultModel || 'Not configured'; }

// Multi-model support
function renderModelChips() {
  const container = document.getElementById('modelChips');
  const badge = document.getElementById('modelBadge');
  if (!container) return;
  
  const models = Array.isArray(state.settings.models) && state.settings.models.length 
    ? state.settings.models 
    : [state.settings.model].filter(Boolean);
  if (badge) badge.textContent = `${models.length} model${models.length !== 1 ? 's' : ''}`;
  
  container.innerHTML = '';
  if (models.length === 0) {
    container.innerHTML = '<div class="model-chip"><span class="chip-icon">✦</span><span class="chip-text">No models added</span></div>';
    return;
  }
  
  models.forEach((model, index) => {
    const chip = document.createElement('div');
    chip.className = `model-chip${index === 0 ? ' active' : ''}`;
    chip.dataset.model = model;

    const icon = document.createElement('span');
    icon.className = 'chip-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '✦';

    const text = document.createElement('span');
    text.className = 'chip-text';
    text.textContent = model;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chip-remove';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', `Remove ${model}`);

    chip.append(icon, text, removeBtn);
    chip.addEventListener('click', (e) => {
      if (!e.target.classList.contains('chip-remove')) {
        selectModel(model);
      }
    });
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeModel(model);
    });
    container.appendChild(chip);
  });
}

function selectModel(model) {
  state.settings.model = model;
  updateModelUI();
  renderModelChips();
  showToast(`Switched to ${model}`, 'success');
}

function addModel(model) {
  if (!model || state.settings.models.includes(model)) return;
  if (!state.settings.models) state.settings.models = [];
  state.settings.models.push(model);
  if (!state.settings.model) state.settings.model = model;
  renderModelChips();
  updateModelUI();
  showToast(`Added ${model}`, 'success');
}

function removeModel(model) {
  state.settings.models = (state.settings.models || []).filter(m => m !== model);
  if (state.settings.model === model) {
    state.settings.model = state.settings.models[0] || '';
  }
  renderModelChips();
  updateModelUI();
}

function handleModelChange() {
  const modelValue = elements.model.value.trim();
  if (modelValue && !state.settings.models.includes(modelValue)) {
    addModel(modelValue);
  }
  renderModelChips();
}

/* Attachment and voice support are wired by their dedicated feature phases.
 * These guards bind existing controls if the markup is present, without
 * crashing startup when it is not yet available. */
function setupFileAttachment() {
  const attachBtn = document.getElementById('attachBtn');
  const fileInput = document.getElementById('fileInput');
  if (!attachBtn || !fileInput) return;
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (!fileInput.files.length) return;
    const names = [...fileInput.files].map((f) => f.name).join(', ');
    showToast(`Attached: ${names}`, 'success');
    fileInput.value = '';
  });
}

function setupVoiceChat() {
  const voiceBtn = document.getElementById('voiceBtn');
  if (!voiceBtn) return;
  voiceBtn.addEventListener('click', () => {
    showToast('Voice input is not available yet.', '');
  });
}

function syncComposer() {
  elements.prompt.style.height = 'auto';
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 190)}px`;
  const length = elements.prompt.value.length;
  elements.characterCount.textContent = `${length.toLocaleString()} / 20,000`;
  elements.sendBtn.disabled = state.isGenerating || !elements.prompt.value.trim();
}

function setStatus(text, mode) {
  elements.statusText.textContent = text;
  elements.statusDot.className = `status-dot${mode === 'connected' ? ' connected' : mode === 'busy' ? ' busy' : ''}`;
}

function openSidebar() {
  elements.sidebar.classList.add('open'); elements.sidebarBackdrop.classList.add('show');
  elements.mobileMenu.setAttribute('aria-expanded', 'true'); elements.sidebarClose.focus();
}
function closeSidebar() {
  elements.sidebar.classList.remove('open'); elements.sidebarBackdrop.classList.remove('show');
  elements.mobileMenu.setAttribute('aria-expanded', 'false');
}

function isNearBottom(threshold = 130) { return elements.chat.scrollHeight - elements.chat.scrollTop - elements.chat.clientHeight < threshold; }
function scrollToBottom(smooth) { elements.chat.scrollTo({ top: elements.chat.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }
function updateScrollButton() { elements.scrollBottomBtn.classList.toggle('show', !isNearBottom()); }

function exportConversation() {
  const chat = currentChat();
  if (!chat?.messages.length) return showToast('There is no conversation to export.');
  const content = [`# ${chat.title}`, '', ...chat.messages.flatMap((message) => [`## ${message.role === 'user' ? 'You' : 'Assistant'}`, '', message.content, ''])].join('\n');
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `${slugify(chat.title)}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const textarea = document.createElement('textarea'); textarea.value = text; textarea.style.position = 'fixed'; textarea.style.opacity = '0';
    document.body.appendChild(textarea); textarea.select(); const ok = document.execCommand('copy'); textarea.remove(); return ok;
  }
}

async function readError(response) {
  try { const data = await response.json(); return data.error || `Request failed with status ${response.status}.`; }
  catch { return `Request failed with status ${response.status}.`; }
}

function showToast(message, type = '') {
  const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = message;
  elements.toastRegion.appendChild(toast); setTimeout(() => toast.remove(), 3800);
}
function makeTitle(text) { const clean = text.replace(/\s+/g, ' ').trim(); return clean.length > 44 ? `${clean.slice(0, 44)}…` : clean; }
function trimChats() { state.chats.sort((a, b) => b.updatedAt - a.updatedAt); state.chats = state.chats.slice(0, MAX_SAVED_CHATS); }
function slugify(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'conversation'; }
