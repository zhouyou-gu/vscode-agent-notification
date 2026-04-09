# Agent Notification — Requirements

Living document of the user's intended behavior. Updated as requirements evolve.

---

## Core

- VS Code extension that monitors AI agent sessions (Claude Code, Codex) and sends desktop notifications on meaningful events (task completion, permission requests).
- Works across: Claude Code CLI, Codex CLI, Claude/Codex VS Code extensions, Claude desktop app, remote-SSH sessions.

## Session Tracking

- Central session store tracks lifecycle: idle, processing, waitingForInput, waitingForApproval, compacting, ended.
- Notifications fire only on meaningful transitions (not every event).
- Session superseding: a new session with the same `source + cwd` auto-ends the old one.
- Session expiry: 10 minutes inactive, 30 seconds after ended.
- Dedup window: 1 second (prevents duplicate notifications from hooks + JSONL watcher).

## Notifications

- macOS banners via `terminal-notifier` (not osascript — broken on Sequoia).
- No `-sender` flag on terminal-notifier.
- Agent-specific app icons on notification banners (Claude icon for Claude, Codex icon for Codex).
- Permission requests show as warning-style notifications with tool name and project.
- Per-session grouping: new notification for same session replaces the previous banner.

## Menu Bar Widget

- macOS menu bar app built with `rumps` (Python).
- Robot icon: grey when no active sessions, color when active.
- Status text: shows approval count or processing count when relevant.
- Each session entry shows: phase icon + project name + phase label.
- Agent-specific icons (Claude/Codex app icons) on each menu item.
- Summary line below each session showing the agent's last message (truncated to 60 chars).
- Sessions sorted: approvals first, then processing, then others.
- Clicking a session jumps to the correct VS Code window.

## Window Focus / Jump

- Hybrid approach for instant perceived focus:
  1. `osascript activate` brings VS Code to macOS foreground instantly (~0.05s).
  2. `code` CLI targets the specific window in background (~1s).
- Workspace-aware: uses `.code-workspace` file path when the session's cwd is inside a workspace; uses folder path otherwise.
- Applies to: menu bar click, macOS banner click, VS Code "Show" button.

## Installation

- One-command install via `install.sh` with dependency checks and error handling.
- `rumps` version pinned for reproducibility.
- Agent-friendly manual install section in README.
- Menu bar app restartable via VS Code command (`Agent Notify: Restart Menu Bar`).

## VS Code Extension

- HTTP server on configurable port (default 19876) for receiving hook events.
- Port file written to `~/.config/agent-notify/port`.
- Secondary window detection (doesn't fight over the port).
- Status bar: shows session counts, processing spinner, approval warnings.
- Guided first-run setup for configuring agent hooks.
- Configurable: port, auto-focus, sources filter, log level, log retention.
