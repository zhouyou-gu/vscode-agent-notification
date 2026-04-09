# Agent Notification

VS Code extension that sends you a **macOS desktop notification** when Codex or Claude Code finishes a task — even when VS Code isn't focused.

## Install

### From source (development)

```sh
git clone <repo-url>
cd vscode-agent-notification
npm install
npm run build
```

Then open the folder in VS Code and press **F5** to launch with the extension.

### From VSIX

```sh
npm run build
npx @vscode/vsce package
code --install-extension agent-notification-0.1.0.vsix
```

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

```
Agent finishes task
  → Hook script runs (configured by extension)
  → curl POST localhost:19876/notify
  → Extension receives event
  → macOS desktop banner (terminal-notifier)
  → VS Code in-app notification with action buttons
```

The extension runs an HTTP server on `localhost:19876`. Hook scripts for Codex/Claude POST agent events to it. The extension shows both a macOS system banner and a VS Code notification with "Focus Workspace" / "Open Folder" actions.

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

## Logs

Trace logs at `~/.config/agent-notify/logs/` (JSONL format):
- `server-*.log` — HTTP requests
- `events-*.log` — Agent events with raw payloads (replayable)
- `actions-*.log` — User interactions
- `setup-*.log` — Configuration changes
- `errors-*.log` — Errors

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
echo '{"hook_event_name":"Notification","cwd":"/tmp","message":"Task complete"}' | \
  curl -X POST -H "Content-Type: application/json" -d @- \
  "http://localhost:19876/notify?source=claude"
```

## Files Created

| Path | Purpose |
|------|---------|
| `~/.config/agent-notify/port` | Current server port |
| `~/.config/agent-notify/hooks/codex-hook.sh` | Hook script for Codex |
| `~/.config/agent-notify/hooks/claude-hook.sh` | Hook script for Claude Code |
| `~/.config/agent-notify/terminal-notifier.app/` | macOS notification binary |
| `~/.config/agent-notify/logs/` | Trace logs |

## Uninstall

1. Uninstall the extension from VS Code
2. Remove `notify` line from `~/.codex/config.toml`
3. Remove the Agent Notify entry from `hooks.Notification` in `~/.claude/settings.json`
4. `rm -rf ~/.config/agent-notify/`
