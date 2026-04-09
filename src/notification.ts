import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import { AgentEvent } from "./types";
import { Logger } from "./logger";

const DEDUP_WINDOW_MS = 5000;
const MAX_MESSAGE_LENGTH = 150;

const recentNotifications = new Map<string, number>();

export function parseAgentEvent(
  source: string,
  payload: Record<string, unknown>
): AgentEvent | null {
  if (source === "codex") {
    return parseCodexEvent(payload);
  }
  if (source === "claude") {
    return parseClaudeEvent(payload);
  }
  return null;
}

function parseCodexEvent(payload: Record<string, unknown>): AgentEvent | null {
  // Only notify on task completion
  if (payload.type !== "agent-turn-complete") {
    return null;
  }

  const lastMessage = String(payload["last-assistant-message"] || "Turn complete");
  const message = truncateMessage(lastMessage);

  return {
    source: "codex",
    title: "Codex",
    message,
    cwd: String(payload.cwd || ""),
    threadId: payload["thread-id"] ? String(payload["thread-id"]) : undefined,
    timestamp: Date.now(),
    rawPayload: payload,
  };
}

function parseClaudeEvent(payload: Record<string, unknown>): AgentEvent | null {
  const message = truncateMessage(
    String(payload.message || payload.title || "Task complete")
  );

  return {
    source: "claude",
    title: "Claude Code",
    message,
    cwd: String(payload.cwd || ""),
    threadId: payload.session_id ? String(payload.session_id) : undefined,
    timestamp: Date.now(),
    rawPayload: payload,
    remoteAuthority: payload.remote_authority
      ? String(payload.remote_authority)
      : undefined,
  };
}

function truncateMessage(msg: string): string {
  // Take first non-empty line
  const firstLine = msg
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) || msg;

  if (firstLine.length <= MAX_MESSAGE_LENGTH) return firstLine;
  return firstLine.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
}

export function shouldShow(event: AgentEvent): boolean {
  const key = `${event.source}:${event.cwd}`;
  const last = recentNotifications.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) {
    return false;
  }
  recentNotifications.set(key, Date.now());
  return true;
}

export function cwdMatchesWorkspace(cwd: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !cwd) return false;
  return folders.some((f) => {
    const wsPath = f.uri.fsPath;
    return cwd === wsPath || cwd.startsWith(wsPath + path.sep);
  });
}

export async function showNotification(
  event: AgentEvent,
  logger: Logger
): Promise<void> {
  const config = vscode.workspace.getConfiguration("agent-notify");
  const allowedSources = config.get<string[]>("sources", ["codex", "claude"]);
  if (!allowedSources.includes(event.source)) {
    logger.debug("event", "source_filtered", { source: event.source });
    return;
  }

  if (!shouldShow(event)) {
    logger.debug("event", "throttled", {
      source: event.source,
      cwd: event.cwd,
      reason: "dedup_window",
    });
    return;
  }

  const isCurrentWorkspace = cwdMatchesWorkspace(event.cwd);

  logger.info("action", "notification_shown", {
    source: event.source,
    cwd: event.cwd,
    cwdMatched: isCurrentWorkspace,
  });

  // Send macOS native push notification (visible even when VS Code is not focused)
  sendMacOSNotification(event, logger);

  // Auto-focus if configured and CWD matches
  const autoFocus = config.get<boolean>("autoFocus", false);
  if (autoFocus && isCurrentWorkspace) {
    await vscode.commands.executeCommand("workbench.action.focusWindow");
    logger.info("action", "auto_focused", { cwd: event.cwd });
    return;
  }

  // Also show VS Code in-app notification with action buttons
  const actions = isCurrentWorkspace
    ? ["Focus Workspace"]
    : ["Focus Workspace", "Open Folder"];

  const action = await vscode.window.showInformationMessage(
    `[${event.title}] ${event.message}`,
    ...actions
  );

  if (!action) {
    logger.info("action", "notification_dismissed", {
      source: event.source,
      cwd: event.cwd,
    });
    return;
  }

  logger.info("action", "button_clicked", {
    button: action,
    source: event.source,
    cwd: event.cwd,
  });

  if (action === "Focus Workspace" && isCurrentWorkspace) {
    await vscode.commands.executeCommand("workbench.action.focusWindow");
    logger.info("action", "focused_current_window", { cwd: event.cwd });
  } else if (action === "Open Folder" || (action === "Focus Workspace" && !isCurrentWorkspace)) {
    await openFolder(event, logger);
  }
}

async function openFolder(event: AgentEvent, logger: Logger): Promise<void> {
  const remoteAuthority =
    event.remoteAuthority || process.env.VSCODE_REMOTE_AUTHORITY || undefined;

  let uri: vscode.Uri;
  if (remoteAuthority && event.cwd) {
    uri = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: remoteAuthority,
      path: event.cwd,
    });
  } else {
    uri = vscode.Uri.file(event.cwd);
  }

  try {
    await vscode.commands.executeCommand("vscode.openFolder", uri, {
      forceNewWindow: false,
    });
    logger.info("action", "opened_folder", {
      cwd: event.cwd,
      remote: !!remoteAuthority,
    });
  } catch (err) {
    logger.error("action", "open_folder_failed", {
      cwd: event.cwd,
      error: String(err),
    });
  }
}

function sendMacOSNotification(event: AgentEvent, logger: Logger): void {
  if (process.platform !== "darwin") return;

  const title = event.title;
  const message = event.message;
  const subtitle = event.cwd ? path.basename(event.cwd) : "";

  // Try terminal-notifier first (reliable banners on Sequoia+)
  const tnPath = path.join(
    os.homedir(),
    ".config",
    "agent-notify",
    "terminal-notifier.app",
    "Contents",
    "MacOS",
    "terminal-notifier"
  );

  if (fs.existsSync(tnPath)) {
    const args = [
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-sound", "default",
      "-group", `agent-notify-${event.source}`,
    ];
    execFile(tnPath, args, (err: Error | null) => {
      if (err) {
        logger.error("action", "terminal_notifier_failed", { error: String(err) });
      } else {
        logger.info("action", "macos_notification_sent", { source: event.source, cwd: event.cwd, method: "terminal-notifier" });
      }
    });
    return;
  }

  // Fallback: osascript (works if Script Editor notifications are enabled)
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display notification "${escape(message)}" with title "${escape(title)}" subtitle "${escape(subtitle)}" sound name "Glass"`;
  execFile("osascript", ["-e", script], (err: Error | null) => {
    if (err) {
      logger.error("action", "macos_notification_failed", { error: String(err) });
    } else {
      logger.info("action", "macos_notification_sent", { source: event.source, cwd: event.cwd, method: "osascript" });
    }
  });
}
