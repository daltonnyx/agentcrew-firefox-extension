const STORAGE_KEY = 'agentcrew_state';

async function getState() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || { serverConfig: { baseUrl: '', bearerToken: '', defaultAgent: null } };
}

async function load() {
  const state = await getState();
  document.getElementById('serverUrl').value = state.serverConfig?.baseUrl || '';
  document.getElementById('bearerToken').value = state.serverConfig?.bearerToken || '';
  document.getElementById('defaultAgent').value = state.serverConfig?.defaultAgent || '';
}

async function save() {
  const state = await getState();
  const baseUrl = document.getElementById('serverUrl').value.trim();
  state.serverConfig = {
    baseUrl,
    bearerToken: document.getElementById('bearerToken').value.trim(),
    defaultAgent: document.getElementById('defaultAgent').value.trim() || null
  };

  try {
    const url = new URL(baseUrl);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (!isLocal) {
      const origin = `${url.protocol}//${url.hostname}/*`;
      const granted = await browser.permissions.request({ origins: [origin] });
      if (!granted) {
        document.getElementById('error').textContent = 'Host permission denied for ' + origin;
        return;
      }
    }
  } catch {
    // URL parsing failed - save anyway, fetch will fail with clearer error
  }

  await browser.storage.local.set({ [STORAGE_KEY]: state });
  document.getElementById('status').textContent = 'Settings saved!';
  document.getElementById('error').textContent = '';
  setTimeout(() => {
    document.getElementById('status').textContent = '';
  }, 2000);
}

async function testConnection() {
  const baseUrl = document.getElementById('serverUrl').value.trim();
  const token = document.getElementById('bearerToken').value.trim();

  if (!baseUrl) {
    document.getElementById('error').textContent = 'Please enter a server URL';
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(`${baseUrl}/agents`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const agents = await res.json();
    document.getElementById('status').textContent = `Connected! Found ${agents.length} agent(s).`;
    document.getElementById('error').textContent = '';
  } catch (err) {
    document.getElementById('error').textContent = `Connection failed: ${err.message}`;
    document.getElementById('status').textContent = '';
  }
}

document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('testBtn').addEventListener('click', testConnection);

load();