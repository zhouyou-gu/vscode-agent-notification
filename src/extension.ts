import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import { Logger } from "./logger";
import { NotificationServer } from "./server";
import { parseAgentEvent, showNotification, setExtensionPath } from "./notification";
import { detectTools, configureHooks, isTerminalNotifierAvailable } from "./hooks";
import { detectRemote, setupRemote } from "./remote";
import { SessionWatcher } from "./session-watcher";
import { SessionStore } from "./session-store";
import type { AgentSource } from "./types";

const STATE_KEY_CONFIGURED = "agent-notify.configured";
const STATE_KEY_DISMISSED = "agent-notify.dismissed";
const STATE_KEY_VERSION = "agent-notify.configVersion";
const CONFIG_VERSION = 2;

let logger: Logger;
let server: NotificationServer;
let sessionStore: SessionStore;
let sessionWatcher: SessionWatcher;
let statusBarItem: vscode.StatusBarItem;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  logger = new Logger();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  logger.info("setup", "extension_activating");
  logger.cleanOldLogs();
  setExtensionPath(context.extensionPath);

  // Create session store — central state manager for all agent sessions
  sessionStore = new SessionStore(logger);
  context.subscriptions.push({ dispose: () => sessionStore.dispose() });

  // Session store fires notifications through showNotification
  sessionStore.onNotification((event) => {
    showNotification(event, logger);
  });

  // Start HTTP server — routes events through session store
  server = new NotificationServer(logger, (source, payload) => {
    logger.info("event", "agent_event", {
      source,
      hookEventName: payload.hook_event_name,
      rawPayload: payload,
    });

    sessionStore.processHookEvent(source as AgentSource, payload);
  });

  // Expose session state via /sessions endpoint
  server.setSessionsHandler(() => {
    const wsFile = vscode.workspace.workspaceFile;
    const workspaceFilePath = wsFile && wsFile.scheme === "file" ? wsFile.fsPath : undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];

    return sessionStore.getAllSessions().map((s) => ({
      id: s.id,
      source: s.source,
      cwd: s.cwd,
      projectName: s.projectName,
      phase: s.phase,
      lastActivity: s.lastActivity,
      lastPhaseChange: s.lastPhaseChange,
      createdAt: s.createdAt,
      toolCount: s.tools.size,
      message: s.message,
      permissionContext: s.permissionContext,
      workspaceFile: workspaceFilePath,
      workspaceFolders,
    }));
  });

  server.setClearSessionsHandler(() => sessionStore.clearAllSessions());

  let serverPort = 0;
  try {
    serverPort = await server.start();
  } catch (err) {
    if (err instanceof Error && err.message === "SECONDARY") {
      logger.info("setup", "running_as_secondary_window");
    } else {
      logger.error("setup", "server_start_failed", { error: String(err) });
      vscode.window.showErrorMessage(
        `Agent Notify: Could not start server — ${err}`
      );
    }
  }
  context.subscriptions.push({ dispose: () => server.stop() });

  // Start session file watcher — routes through session store for dedup
  sessionWatcher = new SessionWatcher(
    logger,
    (event) => showNotification(event, logger),
    sessionStore
  );
  sessionWatcher.start();
  context.subscriptions.push({ dispose: () => sessionWatcher.dispose() });

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  context.subscriptions.push(statusBarItem);
  updateStatusBar(serverPort, context);

  // Update status bar when sessions change
  sessionStore.onSessionChanged(() => {
    updateStatusBarFromSessions(serverPort, context);
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("agent-notify.configure", () =>
      runGuidedSetup(context)
    ),
    vscode.commands.registerCommand("agent-notify.reconfigure", () =>
      runGuidedSetup(context, true)
    ),
    vscode.commands.registerCommand("agent-notify.test", () =>
      runTestNotification()
    ),
    vscode.commands.registerCommand("agent-notify.setupRemote", () =>
      runSetupRemote()
    ),
    vscode.commands.registerCommand("agent-notify.showLogs", () =>
      logger.showOutputChannel()
    ),
    vscode.commands.registerCommand("agent-notify.restartMenuBar", () =>
      restartMenuBar(context)
    )
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agent-notify")) {
        logger.reloadConfig();
      }
    })
  );

  // First-run check (only if we own the server)
  if (serverPort > 0) {
    const configured = context.globalState.get<boolean>(STATE_KEY_CONFIGURED);
    const dismissed = context.globalState.get<boolean>(STATE_KEY_DISMISSED);
    const version = context.globalState.get<number>(STATE_KEY_VERSION);

    if (!configured || version !== CONFIG_VERSION) {
      if (!dismissed) {
        await promptFirstRun(context);
      }
    }
  }

  logger.info("setup", "extension_activated", { port: serverPort });
}

function updateStatusBar(
  port: number,
  context: vscode.ExtensionContext
): void {
  const configured = context.globalState.get<boolean>(STATE_KEY_CONFIGURED);
  if (port > 0 && configured) {
    statusBarItem.text = "$(bell) Agent Notify";
    statusBarItem.tooltip = `Listening on port ${port} — click to reconfigure`;
    statusBarItem.command = "agent-notify.reconfigure";
    statusBarItem.show();
  } else if (port > 0) {
    statusBarItem.text = "$(bell-dot) Agent Notify — Setup needed";
    statusBarItem.tooltip = "Click to set up agent notifications";
    statusBarItem.command = "agent-notify.configure";
    statusBarItem.show();
  }
}

function updateStatusBarFromSessions(
  port: number,
  context: vscode.ExtensionContext
): void {
  if (port <= 0) return;

  const active = sessionStore.getActiveSessions();
  const needsAttention = sessionStore.getSessionsNeedingAttention();

  if (needsAttention.length > 0) {
    statusBarItem.text = `$(alert) ${needsAttention.length} approval needed`;
    statusBarItem.tooltip = `${active.length} active session(s), ${needsAttention.length} need approval`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusBarItem.command = "agent-notify.showLogs";
    statusBarItem.show();
  } else if (active.length > 0) {
    const processing = active.filter((s) => s.phase === "processing");
    if (processing.length > 0) {
      statusBarItem.text = `$(sync~spin) ${processing.length} processing`;
      statusBarItem.tooltip = `${active.length} active session(s)`;
    } else {
      statusBarItem.text = `$(bell) ${active.length} session(s)`;
      statusBarItem.tooltip = `${active.length} active session(s)`;
    }
    statusBarItem.backgroundColor = undefined;
    statusBarItem.command = "agent-notify.showLogs";
    statusBarItem.show();
  } else {
    // No active sessions — revert to default
    updateStatusBar(port, context);
  }
}

// ── First-run prompt ──────────────────────────────────────────────

async function promptFirstRun(
  context: vscode.ExtensionContext
): Promise<void> {
  const tools = detectTools(logger);

  if (!tools.codex && !tools.claude) {
    logger.info("setup", "no_tools_detected");
    // Show guidance for users who install the extension before the tools
    const choice = await vscode.window.showInformationMessage(
      "Agent Notify: No agent tools detected. Install Codex or Claude Code, then run setup.",
      "OK"
    );
    return;
  }

  const toolNames: string[] = [];
  if (tools.codex) toolNames.push("Codex");
  if (tools.claude) toolNames.push("Claude Code");

  const choice = await vscode.window.showInformationMessage(
    `Set up desktop notifications for ${toolNames.join(" and ")}?`,
    "Set Up",
    "Not Now",
    "Don't Ask Again"
  );

  if (choice === "Don't Ask Again") {
    await context.globalState.update(STATE_KEY_DISMISSED, true);
    logger.info("setup", "user_dismissed_permanently");
    return;
  }

  if (choice !== "Set Up") {
    logger.info("setup", "user_deferred_setup");
    return;
  }

  await runGuidedSetup(context);
}

// ── Guided setup ──────────────────────────────────────────────────

async function runGuidedSetup(
  context: vscode.ExtensionContext,
  force = false
): Promise<void> {
  const tools = detectTools(logger);

  if (!tools.codex && !tools.claude) {
    vscode.window.showWarningMessage(
      "No agent tools detected. Install Codex or Claude Code first, then re-run this command."
    );
    return;
  }

  // Step 1: Configure hooks
  const configured = await configureHooks(tools, logger, force);

  if (configured.length === 0) {
    vscode.window.showInformationMessage("No changes made.");
    return;
  }

  await context.globalState.update(STATE_KEY_CONFIGURED, true);
  await context.globalState.update(STATE_KEY_DISMISSED, false);
  await context.globalState.update(STATE_KEY_VERSION, CONFIG_VERSION);

  const names = configured.map((s) =>
    s === "codex" ? "Codex" : "Claude Code"
  );

  // Step 2: Guide user to enable macOS notification banners
  if (process.platform === "darwin" && isTerminalNotifierAvailable(context.extensionPath)) {
    const enableChoice = await vscode.window.showWarningMessage(
      `Hooks configured for ${names.join(" and ")}. One more step: enable macOS banners.\n\nGo to System Settings > Notifications > terminal-notifier > set to "Banners" and enable "Allow Notifications".`,
      "Open System Settings",
      "Send Test",
      "Done"
    );

    if (enableChoice === "Open System Settings") {
      vscode.env.openExternal(
        vscode.Uri.parse("x-apple.systempreferences:com.apple.Notifications-Settings")
      );
      const testChoice = await vscode.window.showInformationMessage(
        "After enabling banners for terminal-notifier, test it here.",
        "Send Test Notification"
      );
      if (testChoice) {
        runTestNotification();
      }
    } else if (enableChoice === "Send Test") {
      runTestNotification();
    }
  } else {
    vscode.window.showInformationMessage(
      `Agent Notify configured for ${names.join(" and ")}.`
    );
  }

  updateStatusBar(server.getPort(), context);
}

// ── Test notification ─────────────────────────────────────────────

function runTestNotification(): void {
  const event = parseAgentEvent("claude", {
    hook_event_name: "Notification",
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "/tmp",
    message: "This is a test notification from Agent Notify",
  });
  if (event) {
    showNotification(event, logger);
    logger.info("action", "test_notification_sent");
  }
}

// ── Remote setup ──────────────────────────────────────────────────

async function runSetupRemote(): Promise<void> {
  const remote = detectRemote(logger);
  if (!remote.isRemote) {
    vscode.window.showWarningMessage(
      "Not connected to a remote host. Connect via Remote-SSH first."
    );
    return;
  }
  await setupRemote(remote, server.getPort(), logger);
}

// ── Menu bar helper ──────────────────────────────────────────────

function restartMenuBar(context: vscode.ExtensionContext): void {
  // Kill existing
  execFile("pkill", ["-f", "agent-statusbar.py"], () => {
    // Find the .app — check user-local first, then extension bundled
    const candidates = [
      path.join(os.homedir(), ".config", "agent-notify", "statusbar", "AgentStatusBar.app"),
      path.join(context.extensionPath, "bin", "statusbar", "AgentStatusBar.app"),
    ];

    const appPath = candidates.find((p) => fs.existsSync(p));
    if (!appPath) {
      vscode.window.showWarningMessage(
        "AgentStatusBar.app not found. Run the installer or check bin/statusbar/."
      );
      return;
    }

    setTimeout(() => {
      execFile("open", [appPath], (err) => {
        if (err) {
          vscode.window.showErrorMessage(`Failed to start menu bar helper: ${err.message}`);
        } else {
          vscode.window.showInformationMessage("Menu bar helper restarted.");
        }
      });
    }, 1000);
  });
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
