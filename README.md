# Agent Notification

VS Code extension that monitors AI coding agent sessions and sends **macOS desktop notifications** — when a task finishes, when permission approval is needed, or when an agent is waiting for input. Click the banner to jump straight back to VS Code.

Works with **Claude Code**, **Codex**, and their variants: CLI, VS Code extension, desktop app, and Remote-SSH.

## Use Cases

### 1. Task completion alerts

You're in another app while Claude Code or Codex works in the background. When the agent finishes, you get a macOS banner and a VS Code notification — click either to jump back instantly.

### 2. Permission approval needed

Claude Code needs approval for a tool (e.g. `Bash`, `Write`). You get a warning notification with the tool name and project — click "Show" to focus VS Code and handle it.

### 3. Multi-session monitoring

Running Claude Code in one project and Codex in another? The **VS Code status bar** shows live session counts, and the **macOS menu bar helper** gives you a persistent overview with per-session status icons.

### 4. Remote development

Working over SSH? Port forwarding routes agent hooks from the remote server to your local Mac. You get the same notifications as local sessions.

---

## Install

### Quick install (one command)

```sh
curl -fsSL https://raw.githubusercontent.com/zhouyou-gu/vscode-agent-notification/main/install.sh | sh
```

Then reload VS Code and run **Agent Notify: Configure Hooks** from the command palette.

### Install from source

```sh
git clone https://github.com/zhouyou-gu/vscode-agent-notification.git
cd vscode-agent-notification
npm install
npm run build
npx @vscode/vsce package          # produces agent-notification.vsix
code --install-extension agent-notification.vsix --force
```

Then reload VS Code and run **Agent Notify: Configure Hooks** from the command palette.

### Manual install (for AI agents and headless environments)

If you are an AI coding agent or operating in a headless environment, follow these exact steps. No GUI interaction is needed.

#### Prerequisites

- macOS (notifications use `terminal-notifier`)
- VS Code with `code` CLI on PATH
- Node.js and npm
- `curl` on PATH

#### Step 1: Build and install the extension

```sh
cd /path/to/vscode-agent-notification
npm install
npm run build
npx @vscode/vsce package
code --install-extension agent-notification.vsix --force
```

The extension activates on next VS Code window reload.

#### Step 2: Write hook scripts

Create the directory and hook scripts that forward agent events to the extension's HTTP server:

```sh
mkdir -p ~/.config/agent-notify/hooks
```

**Claude Code hook** — write to `~/.config/agent-notify/hooks/claude-hook.sh`:

```sh
#!/bin/sh
# agent-notify v2 — do not edit (managed by Agent Notification extension)
PORT=$(cat "$HOME/.config/agent-notify/port" 2>/dev/null || echo 19876)
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d @- \
  "http://localhost:$PORT/notify?source=claude" \
  2>/dev/null || true
```

```sh
chmod +x ~/.config/agent-notify/hooks/claude-hook.sh
```

**Codex hook** — write to `~/.config/agent-notify/hooks/codex-hook.sh`:

```sh
#!/bin/sh
# agent-notify v1 — do not edit (managed by Agent Notification extension)
PORT=$(cat "$HOME/.config/agent-notify/port" 2>/dev/null || echo 19876)
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$1" \
  "http://localhost:$PORT/notify?source=codex" \
  2>/dev/null || true
```

```sh
chmod +x ~/.config/agent-notify/hooks/codex-hook.sh
```

#### Step 3: Patch Claude Code settings

Edit `~/.claude/settings.json`. Add a hook entry for **each** of the following event names: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`.

Each entry has the same structure. The `PermissionRequest` entry additionally needs `"timeout": 86400`.

Example — if `~/.claude/settings.json` does not have a `hooks` key yet:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ],
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ],
    "PermissionRequest": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }], "timeout": 86400 }
    ],
    "Notification": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ],
    "SubagentStop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ],
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ],
    "PreCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.config/agent-notify/hooks/claude-hook.sh" }] }
    ]
  }
}
```

If `~/.claude/settings.json` already exists with other keys, **merge** the `hooks` object — do not overwrite existing settings. If a hook event array already exists, **append** the new entry to it.

#### Step 4: Patch Codex config

Edit `~/.codex/config.toml`. Add this line at the **top level** (before any `[section]` header):

```toml
notify = ["sh", "~/.config/agent-notify/hooks/codex-hook.sh"]
```

If a `notify` line already exists, replace it.

#### Step 5: Enable macOS notification banners

The extension bundles `terminal-notifier` at `bin/terminal-notifier.app/` inside the VSIX. To also install a user-local fallback:

```sh
mkdir -p ~/.config/agent-notify/terminal-notifier.app/Contents/MacOS
cp /path/to/vscode-agent-notification/bin/terminal-notifier.app/Contents/MacOS/terminal-notifier \
   ~/.config/agent-notify/terminal-notifier.app/Contents/MacOS/terminal-notifier
chmod +x ~/.config/agent-notify/terminal-notifier.app/Contents/MacOS/terminal-notifier
```

Then the user must **manually** enable notifications in macOS:
- System Settings > Notifications > terminal-notifier > Allow Notifications ON, alert style "Banners"

This cannot be done programmatically.

#### Step 6: Verify

After reloading VS Code:

```sh
# Check the extension's HTTP server is running
curl -s http://localhost:19876/health
# Expected: {"status":"ok","app":"agent-notify","port":19876}

# Send a test notification
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"Notification","session_id":"test","cwd":"/tmp","message":"Install verified"}' \
  "http://localhost:19876/notify?source=claude"
# Expected: {"ok":true}  and a macOS banner + VS Code notification appear
```

#### Optional: macOS menu bar helper

The menu bar helper is a Python app that shows a persistent status icon. It requires `python3` and installs the `rumps` package in a local venv.

```sh
STATUSBAR_DIR="$HOME/.config/agent-notify/statusbar"
mkdir -p "$STATUSBAR_DIR"

# Copy the script
cp /path/to/vscode-agent-notification/bin/statusbar/agent-statusbar.py "$STATUSBAR_DIR/"

# Create venv
python3 -m venv "$STATUSBAR_DIR/.venv"
"$STATUSBAR_DIR/.venv/bin/pip" install "rumps>=0.4.0"

# Create .app wrapper
mkdir -p "$STATUSBAR_DIR/AgentStatusBar.app/Contents/MacOS"

cat > "$STATUSBAR_DIR/AgentStatusBar.app/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>AgentStatusBar</string>
    <key>CFBundleIdentifier</key>
    <string>com.agent-notify.statusbar</string>
    <key>CFBundleExecutable</key>
    <string>run.sh</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleVersion</key>
    <string>1.0</string>
</dict>
</plist>
EOF

cat > "$STATUSBAR_DIR/AgentStatusBar.app/Contents/MacOS/run.sh" << RUNSH
#!/bin/sh
DIR="$STATUSBAR_DIR"
exec "\$DIR/.venv/bin/python3" "\$DIR/agent-statusbar.py"
RUNSH
chmod +x "$STATUSBAR_DIR/AgentStatusBar.app/Contents/MacOS/run.sh"

# Launch
open "$STATUSBAR_DIR/AgentStatusBar.app"
```

---

## How It Works

### Session state machine

The extension tracks each agent session through a lifecycle:

```
idle → processing → waitingForInput → processing → ... → ended
                  ↘ waitingForApproval ↗
                  ↘ compacting ↗
```

Notifications only fire on meaningful transitions:
- `processing → waitingForInput` — agent finished, waiting for you
- `→ waitingForApproval` — tool needs permission
- `processing → ended` — session complete

### Detection mechanisms

#### 1. CLI hooks (Claude Code CLI, Codex CLI)

```
Agent CLI event (start, tool use, completion, permission request, etc.)
  → Hook script runs (configured in Step 3/4 above)
  → curl POST localhost:19876/notify
  → Session store updates phase
  → Notification fires on meaningful transition
```

All 10 Claude Code hook events are registered: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop`, `SubagentStop`, `SessionEnd`, `PreCompact`.

#### 2. Session file watching (VS Code extension sessions, desktop apps)

```
Agent writes to JSONL session file
  → Extension detects completion marker
  → Session store updates (with dedup against HTTP hooks)
  → Notification fires
```

The session watcher monitors:
- **Claude Code**: `~/.claude/projects/**/*.jsonl` for `stop_reason: "end_turn"`
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` for `type: "task_complete"`

### Notification surfaces

| Surface | Behavior |
| ------- | -------- |
| **macOS banner** | Via `terminal-notifier`. Grouped by session (new replaces old). Click to focus the correct app. |
| **VS Code notification** | Info message for completions, warning for permission requests. "Show" button focuses workspace. |
| **VS Code status bar** | Live session counts: `⚡ 2 processing`, `⚠ 1 approval needed` |
| **macOS menu bar** | Persistent icon via AgentStatusBar.app: `⚠` for approvals, `⚡` for processing, `●` for active sessions |

### Click-to-focus

Clicking a macOS banner activates the correct application based on context:

| Agent | Bundle ID |
| ----- | --------- |
| VS Code (default) | `com.microsoft.VSCode` |
| Claude desktop app | `com.anthropic.claudefordesktop` |
| Codex desktop app | `com.openai.codex` |
| Cursor | `com.todesktop.230313mzl4w4u92` |

### Dedup

Events are deduplicated with a 1-second window per session. When both HTTP hooks and JSONL watcher detect the same event, only one notification fires.

## Compatibility matrix

| Scenario | State Source | Notifications | Dashboard |
| -------- | ----------- | ------------- | --------- |
| Claude Code CLI (local) | HTTP hooks | Yes | Yes |
| Claude Code CLI (remote) | HTTP hooks via port forward | Yes | Yes |
| Claude Code VS Code ext (local) | JSONL watcher | Yes | Yes |
| Claude Code VS Code ext (remote) | HTTP hooks via port forward | Yes | Yes |
| Claude desktop app | JSONL watcher | Yes | Yes |
| Codex CLI (local/remote) | HTTP hooks | Yes | Yes |
| Codex VS Code ext (local) | JSONL watcher | Yes | Yes |
| Codex VS Code ext (remote) | HTTP hooks via port forward | Yes | Yes |

## macOS Menu Bar Helper

The installer sets up **AgentStatusBar.app** — a lightweight Python app (using `rumps`) that sits in your macOS menu bar:

- **Hidden** when no active sessions
- **⚠** when a session needs approval (⚠2 for multiple)
- **⚡** when sessions are processing (⚡3 for multiple)
- **●** when sessions are active but idle

Click a session in the dropdown to focus its VS Code window. Polls `http://localhost:<port>/sessions` every 3 seconds.

Starts automatically on login (added to Login Items by the installer).

## Commands

| Command | Description |
| ------- | ----------- |
| **Agent Notify: Configure Hooks** | Guided setup for detected agent tools |
| **Agent Notify: Reconfigure Hooks** | Re-run setup (updates hook scripts) |
| **Agent Notify: Send Test Notification** | Verify notifications work |
| **Agent Notify: Setup Remote** | Configure for Remote-SSH sessions |
| **Agent Notify: Show Logs** | Open the log output channel |

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `agent-notify.port` | `19876` | HTTP server port |
| `agent-notify.autoFocus` | `false` | Auto-focus window on notification |
| `agent-notify.sources` | `["codex", "claude"]` | Which tools to notify for |
| `agent-notify.logLevel` | `info` | Log verbosity: debug, info, warn, error |
| `agent-notify.logRetentionDays` | `14` | Auto-delete logs older than N days |

## Remote SSH

When connected via Remote-SSH:

1. The extension runs locally (UI extension) — HTTP server is on your Mac
2. Agent hooks on the remote server call `curl localhost:19876/notify`
3. SSH port forwarding routes the request to your Mac

**Setup:**

1. Run **Agent Notify: Setup Remote** from the command palette
2. Add to `~/.ssh/config`:
   ```
   Host your-server
     RemoteForward 19876 localhost:19876
   ```
3. Reconnect to the remote host

## Architecture

```
src/
├── extension.ts        # Entry point, guided setup, commands, status bar
├── server.ts           # HTTP server (POST /notify, GET /health, GET /sessions)
├── session-store.ts    # Central session state manager (phase machine, tool tracking)
├── session-phase.ts    # Pure state machine logic (transitions, phase mapping)
├── session-watcher.ts  # Watches JSONL files for IDE extension / desktop app sessions
├── notification.ts     # Event parsing, macOS banners, VS Code notifications, click-to-focus
├── hooks.ts            # Auto-configures Codex/Claude hook scripts (all 10 event types)
├── remote.ts           # Remote-SSH detection and port forwarding guidance
├── logger.ts           # JSONL file logging with daily rotation
└── types.ts            # Shared interfaces and types

bin/
├── terminal-notifier.app/  # Bundled macOS notification binary (~68KB)
└── statusbar/
    ├── agent-statusbar.py   # macOS menu bar helper (rumps)
    └── AgentStatusBar.app/  # .app wrapper (LSUIElement, auto-launched)
```

## API

The extension runs an HTTP server on `localhost:19876`:

| Endpoint | Method | Description |
| -------- | ------ | ----------- |
| `/health` | GET | Health check (`{"status":"ok","app":"agent-notify"}`) |
| `/notify?source=claude` | POST | Receive agent hook events |
| `/sessions` | GET | Current session states (JSON array) |

## Logs

Trace logs at `~/.config/agent-notify/logs/` (JSONL format):
- `server-*.log` — HTTP requests
- `event-*.log` — Agent events with raw payloads
- `action-*.log` — Notification actions
- `setup-*.log` — Configuration changes
- `error-*.log` — Errors

Live logs: run **Agent Notify: Show Logs** or open the "Agent Notification" output channel.

## Manual Testing

```sh
# Health check
curl http://localhost:19876/health

# View active sessions
curl http://localhost:19876/sessions | python3 -m json.tool

# Simulate full Claude Code session lifecycle
PORT=$(cat ~/.config/agent-notify/port)

# Session start
curl -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"SessionStart","session_id":"test-1","cwd":"/tmp/project"}' \
  "http://localhost:$PORT/notify?source=claude"

# User prompt → processing
curl -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"UserPromptSubmit","session_id":"test-1","cwd":"/tmp/project"}' \
  "http://localhost:$PORT/notify?source=claude"

# Tool starts
curl -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PreToolUse","session_id":"test-1","tool_name":"Bash","tool_use_id":"tu-1","tool_input":{"command":"ls"}}' \
  "http://localhost:$PORT/notify?source=claude"

# Tool completes
curl -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PostToolUse","session_id":"test-1","tool_name":"Bash","tool_use_id":"tu-1"}' \
  "http://localhost:$PORT/notify?source=claude"

# Agent stops → notification fires
curl -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"Stop","session_id":"test-1","cwd":"/tmp/project","message":"Done refactoring"}' \
  "http://localhost:$PORT/notify?source=claude"

# Permission request → warning notification
curl -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PermissionRequest","session_id":"test-1","cwd":"/tmp/project","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/test"}}' \
  "http://localhost:$PORT/notify?source=claude"

# Simulate Codex completion
curl -X POST -H "Content-Type: application/json" \
  -d '{"type":"agent-turn-complete","cwd":"/tmp","last-assistant-message":"Done"}' \
  "http://localhost:$PORT/notify?source=codex"
```

## Files Created

| Path | Purpose |
| ---- | ------- |
| `~/.config/agent-notify/port` | Current server port (written by extension on startup) |
| `~/.config/agent-notify/hooks/codex-hook.sh` | Hook script for Codex CLI |
| `~/.config/agent-notify/hooks/claude-hook.sh` | Hook script for Claude Code CLI |
| `~/.config/agent-notify/terminal-notifier.app/` | User-local fallback notification binary |
| `~/.config/agent-notify/statusbar/` | Menu bar helper (AgentStatusBar.app + Python venv) |
| `~/.config/agent-notify/logs/` | Trace logs (JSONL, daily rotation) |
| `~/.claude/settings.json` | Patched with hook entries (under `hooks` key) |
| `~/.codex/config.toml` | Patched with `notify` line |

## Uninstall

```sh
# 1. Remove the VS Code extension
code --uninstall-extension agent-notify.agent-notification

# 2. Remove Codex hook: delete the "notify" line from ~/.codex/config.toml
#    The line looks like: notify = ["sh", "...agent-notify..."]

# 3. Remove Claude hooks: delete all entries containing "agent-notify" from
#    every hook event array in ~/.claude/settings.json

# 4. Kill menu bar helper
pkill -f agent-statusbar.py 2>/dev/null

# 5. Remove login item
osascript -e 'tell application "System Events" to delete login item "AgentStatusBar"' 2>/dev/null

# 6. Remove all created files
rm -rf ~/.config/agent-notify/
```
