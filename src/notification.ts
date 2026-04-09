import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import { AgentEvent } from "./types";
import { Logger } from "./logger";

const DEDUP_WINDOW_MS = 1000;
const MAX_MESSAGE_LENGTH = 150;
const RECENTMAP_CLEANUP_INTERVAL = 60_000;
const CODE_CLI = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

const recentNotifications = new Map<string, number>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

let extensionPath = "";

export function setExtensionPath(p: string): void {
  extensionPath = p;
}

// ── Event parsing ────────────────────────────────────────────────

export function parseAgentEvent(
  source: string,
  payload: Record<string, unknown>
): AgentEvent | null {
  if (source === "codex") return parseCodexEvent(payload);
  if (source === "claude") return parseClaudeEvent(payload);
  return null;
}

function parseCodexEvent(payload: Record<string, unknown>): AgentEvent | null {
  if (payload.type !== "agent-turn-complete") return null;

  return {
    source: "codex",
    title: "Codex",
    message: truncateMessage(String(payload["last-assistant-message"] || "Turn complete")),
    cwd: String(payload.cwd || ""),
    threadId: payload["thread-id"] ? String(payload["thread-id"]) : undefined,
    timestamp: Date.now(),
    rawPayload: payload,
  };
}

function parseClaudeEvent(payload: Record<string, unknown>): AgentEvent | null {
  return {
    source: "claude",
    title: "Claude Code",
    message: truncateMessage(String(payload.message || payload.title || "Task complete")),
    cwd: String(payload.cwd || ""),
    threadId: payload.session_id ? String(payload.session_id) : undefined,
    timestamp: Date.now(),
    rawPayload: payload,
    remoteAuthority: payload.remote_authority
      ? String(payload.remote_authority)
      : undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function sessionKey(event: AgentEvent): string {
  return event.sessionId || event.threadId || `${event.source}:${event.cwd}`;
}

function truncateMessage(msg: string): string {
  const firstLine = msg
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) || msg;
  if (firstLine.length <= MAX_MESSAGE_LENGTH) return firstLine;
  return firstLine.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
}

export function shouldShow(event: AgentEvent): boolean {
  const key = sessionKey(event);
  const last = recentNotifications.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return false;
  recentNotifications.set(key, Date.now());
  ensureCleanupTimer();
  return true;
}

function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - DEDUP_WINDOW_MS * 10;
    for (const [key, ts] of recentNotifications) {
      if (ts < cutoff) recentNotifications.delete(key);
    }
    if (recentNotifications.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, RECENTMAP_CLEANUP_INTERVAL);
}

export function cwdMatchesWorkspace(cwd: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !cwd) return false;
  return folders.some((f) => {
    const wsPath = f.uri.fsPath;
    return cwd === wsPath || cwd.startsWith(wsPath + path.sep);
  });
}

// ── Notification display ─────────────────────────────────────────

export async function showNotification(
  event: AgentEvent,
  logger: Logger
): Promise<void> {
  const config = vscode.workspace.getConfiguration("agent-notify");
  const allowedSources = config.get<string[]>("sources", ["codex", "claude"]);
  if (!allowedSources.includes(event.source)) return;
  if (!shouldShow(event)) return;

  const isCurrentWorkspace = cwdMatchesWorkspace(event.cwd);
  const projectName = event.cwd ? path.basename(event.cwd) : "unknown";

  logger.info("action", "notification_shown", {
    source: event.source,
    cwd: event.cwd,
    hookEventName: event.hookEventName,
  });

  // macOS banner (per-session group replaces previous banner)
  const isPermission = event.hookEventName === "PermissionRequest";
  if (isPermission) {
    sendMacOSNotification(
      { ...event, title: `${event.title} — Approval Needed`, message: `Tool "${event.toolName}" needs approval in ${projectName}` },
      logger
    );
  } else {
    sendMacOSNotification(event, logger);
  }

  // Auto-focus if configured and CWD matches
  if (config.get<boolean>("autoFocus", false) && isCurrentWorkspace) {
    await vscode.commands.executeCommand("workbench.action.focusWindow");
    return;
  }

  // VS Code in-app notification
  const msg = isPermission
    ? `${event.title}: "${event.toolName}" needs approval in ${projectName}`
    : `${event.title} (${projectName}): ${event.message}`;
  const showFn = isPermission
    ? vscode.window.showWarningMessage
    : vscode.window.showInformationMessage;

  const action = await showFn(msg, "Show");
  if (!action) return;

  focusVSCodeWindow(event.cwd, logger);
}

// ── Window focus ─────────────────────────────────────────────────

/**
 * Hybrid focus: AppleScript activate (instant foreground) +
 * code CLI (targets specific window, ~1s).
 */
function focusVSCodeWindow(cwd: string, logger: Logger): void {
  if (!cwd) {
    vscode.commands.executeCommand("workbench.action.focusWindow");
    return;
  }

  const wsFile = vscode.workspace.workspaceFile;
  const target = wsFile && wsFile.scheme === "file" && wsFile.fsPath.endsWith(".code-workspace")
    ? wsFile.fsPath : cwd;

  execFile("osascript", ["-e", 'tell application "Visual Studio Code" to activate'], (err) => {
    if (err) logger.error("action", "activate_failed", { error: String(err) });
  });
  execFile(CODE_CLI, [target], (err) => {
    if (err) logger.error("action", "code_cli_focus_failed", { error: String(err), target });
  });
  logger.info("action", "hybrid_focus", { target });
}

// ── macOS notifications ──────────────────────────────────────────

function resolveAppIcon(event: AgentEvent): string {
  const iconName = event.source === "codex" ? "codex.png" : "claude.png";
  if (extensionPath) {
    const bundled = path.join(extensionPath, "images", iconName);
    if (fs.existsSync(bundled)) return bundled;
  }
  const userLocal = path.join(os.homedir(), ".config", "agent-notify", "images", iconName);
  if (fs.existsSync(userLocal)) return userLocal;
  return "";
}

function resolveBundleId(event: AgentEvent): string {
  const entrypoint = event.rawPayload?.entrypoint as string | undefined;
  if (entrypoint === "claude-desktop" || entrypoint === "desktop") return "com.anthropic.claudefordesktop";
  if (entrypoint === "codex-app" || entrypoint === "codex-desktop") return "com.openai.codex";

  const ide = event.rawPayload?.ide as string | undefined;
  if (ide === "cursor") return "com.todesktop.230313mzl4w4u92";

  return "com.microsoft.VSCode";
}

function findTerminalNotifier(): string {
  const bundledPath = extensionPath
    ? path.join(extensionPath, "bin", "terminal-notifier.app", "Contents", "MacOS", "terminal-notifier")
    : "";
  if (bundledPath && fs.existsSync(bundledPath)) return bundledPath;

  const userLocalPath = path.join(
    os.homedir(), ".config", "agent-notify",
    "terminal-notifier.app", "Contents", "MacOS", "terminal-notifier"
  );
  if (fs.existsSync(userLocalPath)) return userLocalPath;

  return "";
}

function sendMacOSNotification(event: AgentEvent, logger: Logger): void {
  if (process.platform !== "darwin") return;

  const subtitle = event.cwd ? path.basename(event.cwd) : "";
  const tnPath = findTerminalNotifier();

  if (tnPath) {
    const group = `agent-notify-${sessionKey(event)}`;
    const bundleId = resolveBundleId(event);
    const appIcon = resolveAppIcon(event);
    const args = [
      "-title", event.title,
      "-subtitle", subtitle,
      "-message", event.message,
      "-sound", "default",
      "-group", group,
    ];

    if (bundleId === "com.microsoft.VSCode" && event.cwd) {
      const wsFile = vscode.workspace.workspaceFile;
      const target = wsFile && wsFile.scheme === "file" && wsFile.fsPath.endsWith(".code-workspace")
        ? wsFile.fsPath : event.cwd;
      const escaped = target.replace(/'/g, "'\\''");
      args.push("-execute", `osascript -e 'tell application "Visual Studio Code" to activate' & '${CODE_CLI}' '${escaped}'`);
    } else {
      args.push("-activate", bundleId);
    }

    if (appIcon) args.push("-appIcon", appIcon);

    execFile(tnPath, args, (err) => {
      if (err) logger.error("action", "terminal_notifier_failed", { error: String(err) });
    });
    return;
  }

  // Fallback: osascript
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display notification "${escape(event.message)}" with title "${escape(event.title)}" subtitle "${escape(subtitle)}" sound name "Glass"`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) logger.error("action", "macos_notification_failed", { error: String(err) });
  });
}
