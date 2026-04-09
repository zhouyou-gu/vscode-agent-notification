# Agent Notification

VS Code extension that sends you a **macOS desktop notification** when Codex or Claude Code finishes a task — even when VS Code isn't focused. Click the banner to jump back to VS Code.

Works with both **CLI** and **VS Code extension** versions of Codex and Claude Code.

## Install (one command)

```sh
curl -fsSL https://raw.githubusercontent.com/zhouyou-gu/vscode-agent-notification/main/install.sh | sh
```

This downloads the latest release VSIX and installs it into VS Code. Then reload VS Code.

### From source (development)

```sh
git clone https://github.com/zhouyou-gu/vscode-agent-notification.git
cd vscode-agent-notification
npm install
npm run build
```

Open the folder in VS Code and press **F5** to launch with the extension.

## Setup (guided — 3 steps)

On first launch, the extension walks you through setup:

**Step 1** — "Set up desktop notifications for Codex and Claude Code?" → click **Set Up**
- Extension auto-detects which tools you have installed
- Writes hook scripts to `~/.config/agent-notify/hooks/`
- Patches `~/.codex/config.toml` and `~/.claude/settings.json`
- Downloads `terminal-notifier` (one-time, ~70KB)

**Step 2** — "Enable macOS banners" → click **Open System Settings**
- Navigate to **Notifications > terminal-notifier**
- Toggle **Allow Notifications** ON
- Set alert style to **Banners**

**Step 3** — "Send Test Notification" → verify you see a macOS banner

If you skip setup, click the **"Agent Notify — Setup needed"** status bar item or run **Agent Notify: Configure Hooks** from the command palette.

## How It Works

The extension detects agent task completion via two mechanisms:

### 1. CLI hooks (for terminal-based sessions)

```
Agent CLI finishes task
  → Hook script runs (configured by extension)
  → curl POST localhost:19876/notify
  → Extension shows notification
```

### 2. Session file watching (for VS Code extension-based sessions)

```
Agent VS Code extension finishes task
  → JSONL session file is updated
  → Extension detects completion marker
  → Extension shows notification
```

The session watcher monitors:
- **Claude Code**: `~/.claude/projects/**/*.jsonl` for `stop_reason: "end_turn"`
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` for `type: "task_complete"`

### Notification behavior

- **macOS banner**: Always fires via `terminal-notifier`. Click the banner to focus VS Code.
- **VS Code in-app notification**: Shows with "Focus Workspace" / "Open Folder" action buttons.
- **Dedup**: 5-second window per source+CWD prevents notification floods.

## Commands

| Command | Description |
|---------|-------------|
| **Agent Notify: Configure Hooks** | Guided setup for detected agent tools |
| **Agent Notify: Reconfigure Hooks** | Re-run setup (updates hook scripts) |
| **Agent Notify: Send Test Notification** | Verify notifications work |
| **Agent Notify: Setup Remote** | Configure for Remote-SSH sessions |
| **Agent Notify: Show Logs** | Open the log output channel |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
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
├── extension.ts        # Entry point, guided setup, commands
├── server.ts           # HTTP server (POST /notify, GET /health)
├── session-watcher.ts  # Watches JSONL files for IDE extension sessions
├── notification.ts     # Event parsing, macOS banners, VS Code notifications
├── hooks.ts            # Auto-configures Codex/Claude hook scripts
├── remote.ts           # Remote-SSH detection and port forwarding guidance
├── logger.ts           # JSONL file logging with daily rotation
└── types.ts            # Shared interfaces and types
```

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

# Simulate Codex notification
curl -X POST -H "Content-Type: application/json" \
  -d '{"type":"agent-turn-complete","cwd":"/tmp","last-assistant-message":"Done"}' \
  "http://localhost:19876/notify?source=codex"

# Simulate Claude Code notification
curl -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"Notification","cwd":"/tmp","message":"Task complete"}' \
  "http://localhost:19876/notify?source=claude"
```

## Files Created

| Path | Purpose |
|------|---------|
| `~/.config/agent-notify/port` | Current server port |
| `~/.config/agent-notify/hooks/codex-hook.sh` | Hook script for Codex CLI |
| `~/.config/agent-notify/hooks/claude-hook.sh` | Hook script for Claude Code CLI |
| `~/.config/agent-notify/terminal-notifier.app/` | macOS notification binary |
| `~/.config/agent-notify/logs/` | Trace logs |

## Uninstall

1. Uninstall the extension from VS Code
2. Remove `notify` line from `~/.codex/config.toml`
3. Remove the Agent Notify entry from `hooks.Notification` in `~/.claude/settings.json`
4. `rm -rf ~/.config/agent-notify/`
