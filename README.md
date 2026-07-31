# AgentCrew Browser Bridge

A Firefox MV3 extension that connects to an [AgentCrew](https://github.com/daltonnyx/AgentCrew) A2A v1.0 server. Chat with any registered agent directly from your browser, attach page context (selected text, URL, readable content, images), and stream responses in real-time.

## Features

- **Agent Discovery**: Automatically fetches all registered agents from `/agents` endpoint
- **Streaming Chat**: Real-time SSE-based response streaming
- **Page Context**: Attach selected text, page info, or readable content from any webpage
- **Image Context**: Send images from web pages via context menu
- **Task Persistence**: Conversations survive popup close/reopen via background resubscription
- **Context Menus**: Right-click to send selection or images directly to agents

## Prerequisites

1. An AgentCrew server running with A2A support
2. Firefox 109+ (MV3 support)

## Setup

### 1. Start the AgentCrew Server

```bash
# Without authentication
agentcrew a2a-server

# With authentication
agentcrew a2a-server --api-key your-secret-token
```

### 2. Load the Extension

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on..."**
3. Select any file inside the `agentcrew-firefox/` directory (e.g., `manifest.json`)

### 3. Configure Settings

1. Click the extension icon in the toolbar
2. Click the **⚙** settings button
3. Enter the server URL (e.g., `http://localhost:41241`)
4. Enter the bearer token if authentication is enabled
5. Optionally set a default agent name
6. Click **Test Connection** to verify
7. Click **Save**

### 4. Start Chatting

1. Select an agent from the dropdown
2. Type your message and press Enter or click Send
3. Watch the response stream in real-time

## Using Context

### Via Popup
- Click **📄** to attach page URL and title
- Click **✂** to attach selected text
- Click **📖** to attach readable page content
- Multiple context items can be attached before sending

### Via Context Menu
- Right-click any text → "Send selection to AgentCrew"
- Right-click any image → "Send image to AgentCrew"
- Uses the default agent from settings

## Architecture

```
agentcrew-firefox/
├── manifest.json              # MV3 manifest
├── background/
│   ├── background.js          # Entry: event listeners, Port management
│   ├── a2a-client.js          # A2A v1 JSON-RPC + SSE stream client
│   ├── conversation-manager.js # Task/context tracking, resubscription
│   ├── context-extractor.js   # Page context collection
│   └── storage.js             # storage.local wrapper
├── popup/
│   ├── popup.html/css/js      # Thin UI communicating via runtime.Port
├── content/
│   └── content.js             # Page context extraction
├── options/
│   ├── options.html/js        # Settings page
├── lib/
│   └── sse-parser.js          # SSE event parser for ReadableStream
└── icons/
    ├── icon-48.png
    └── icon-96.png
```

## How It Works

1. **Background owns connections**: All A2A requests flow through the background script
2. **Popup is thin UI**: Communicates via `runtime.Port` messages
3. **Popup reopens**: Background resubscribes to active tasks via `SubscribeToTask`
4. **Artifact reconciliation**: On resubscribe, only new content is sent to popup

## Permissions

- `storage` — Persist conversation state and settings
- `activeTab` — Access current tab for context
- `scripting` — Inject content scripts for page extraction
- `contextMenus` — Right-click menu items
- `host_permissions` — Connect to local AgentCrew server

## Troubleshooting

- **"Not configured"**: Open settings and enter your server URL
- **"Connection failed"**: Ensure the server is running and accessible
- **No agents listed**: Check the server is running with `/agents` endpoint
- **Stream stops**: Check network stability and server logs
