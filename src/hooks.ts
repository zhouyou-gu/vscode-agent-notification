import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AgentSource } from "./types";
import { Logger } from "./logger";

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-notify");
const HOOKS_DIR = path.join(CONFIG_DIR, "hooks");
const MARKER = "agent-notify";

const CODEX_HOOK_SCRIPT = `#!/bin/sh
# agent-notify v1 — do not edit (managed by Agent Notification extension)
PORT=$(cat "$HOME/.config/agent-notify/port" 2>/dev/null || echo 19876)
curl -s -X POST \\
  -H "Content-Type: application/json" \\
  -d "$1" \\
  "http://localhost:$PORT/notify?source=codex" \\
  2>/dev/null || true
`;

const CLAUDE_HOOK_SCRIPT = `#!/bin/sh
# agent-notify v2 — do not edit (managed by Agent Notification extension)
PORT=$(cat "$HOME/.config/agent-notify/port" 2>/dev/null || echo 19876)
curl -s -X POST \\
  -H "Content-Type: application/json" \\
  -d @- \\
  "http://localhost:$PORT/notify?source=claude" \\
  2>/dev/null || true
`;

export interface DetectedTools {
  codex: boolean;
  claude: boolean;
  codexConfigPath: string;
  claudeConfigPath: string;
}

export function detectTools(logger: Logger): DetectedTools {
  const codexDir = path.join(os.homedir(), ".codex");
  const claudeDir = path.join(os.homedir(), ".claude");

  const result: DetectedTools = {
    codex: fs.existsSync(codexDir),
    claude: fs.existsSync(claudeDir),
    codexConfigPath: path.join(codexDir, "config.toml"),
    claudeConfigPath: path.join(claudeDir, "settings.json"),
  };

  logger.info("setup", "tools_detected", {
    codex: result.codex,
    claude: result.claude,
  });

  return result;
}

export async function configureHooks(
  tools: DetectedTools,
  logger: Logger,
  force = false
): Promise<AgentSource[]> {
  const configured: AgentSource[] = [];

  // Ensure hooks directory exists
  fs.mkdirSync(HOOKS_DIR, { recursive: true });

  if (tools.codex) {
    const result = await configureCodex(tools.codexConfigPath, logger, force);
    if (result) configured.push("codex");
  }

  if (tools.claude) {
    const result = await configureClaude(tools.claudeConfigPath, logger, force);
    if (result) configured.push("claude");
  }

  return configured;
}

export function isTerminalNotifierAvailable(extensionPath: string): boolean {
  const bundledPath = path.join(
    extensionPath, "bin", "terminal-notifier.app", "Contents", "MacOS", "terminal-notifier"
  );
  return fs.existsSync(bundledPath);
}

async function configureCodex(
  configPath: string,
  logger: Logger,
  force: boolean
): Promise<boolean> {
  // Write hook script
  const hookPath = path.join(HOOKS_DIR, "codex-hook.sh");
  fs.writeFileSync(hookPath, CODEX_HOOK_SCRIPT, { mode: 0o755 });
  logger.info("setup", "wrote_hook_script", { tool: "codex", path: hookPath });

  // Patch config.toml
  const notifyValue = `notify = ["sh", "${hookPath}"]`;
  let content = "";

  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    // File doesn't exist — create it
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, notifyValue + "\n");
    logger.info("setup", "created_config", { tool: "codex", path: configPath });
    return true;
  }

  // Check for existing notify line
  const notifyRegex = /^notify\s*=.*/m;
  const match = content.match(notifyRegex);

  if (match) {
    if (match[0].includes(MARKER)) {
      if (!force) {
        logger.info("setup", "already_configured", { tool: "codex" });
        return true;
      }
    } else {
      // Foreign notify command — ask user
      const choice = await vscode.window.showWarningMessage(
        `Codex already has a notify command configured:\n${match[0]}\n\nReplace it with Agent Notify?`,
        "Replace",
        "Keep Existing"
      );
      if (choice !== "Replace") {
        logger.info("setup", "user_kept_existing", {
          tool: "codex",
          existing: match[0],
        });
        return false;
      }
    }
    // Replace existing line
    content = content.replace(notifyRegex, notifyValue);
  } else {
    // Insert at top level — before the first [section] header so it doesn't
    // end up inside a TOML table like [projects.*] or [features].
    const firstSection = content.search(/^\[/m);
    if (firstSection > 0) {
      content =
        content.slice(0, firstSection).trimEnd() +
        "\n" +
        notifyValue +
        "\n\n" +
        content.slice(firstSection);
    } else if (firstSection === 0) {
      content = notifyValue + "\n\n" + content;
    } else {
      // No sections at all — just append
      content = content.trimEnd() + "\n" + notifyValue + "\n";
    }
  }

  fs.writeFileSync(configPath, content);
  logger.info("setup", "hook_configured", {
    tool: "codex",
    action: match ? "replaced" : "appended",
    configPath,
  });
  return true;
}

async function configureClaude(
  configPath: string,
  logger: Logger,
  force: boolean
): Promise<boolean> {
  // Write hook script
  const hookPath = path.join(HOOKS_DIR, "claude-hook.sh");
  fs.writeFileSync(hookPath, CLAUDE_HOOK_SCRIPT, { mode: 0o755 });
  logger.info("setup", "wrote_hook_script", {
    tool: "claude",
    path: hookPath,
  });

  // Patch settings.json
  let config: Record<string, unknown> = {};

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {
    // File doesn't exist or invalid — start fresh
  }

  // Navigate to hooks object
  if (!config.hooks || typeof config.hooks !== "object") {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown>;

  // All hook event types we want to register
  const HOOK_EVENTS = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
    "PreCompact",
  ];

  // Check if already configured (check any event for our marker)
  const alreadyConfigured = HOOK_EVENTS.some((eventName) => {
    const eventHooks = hooks[eventName] as Array<Record<string, unknown>> | undefined;
    return eventHooks?.some((entry) => {
      const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      return entryHooks?.some(
        (h) => typeof h.command === "string" && h.command.includes(MARKER)
      );
    });
  });

  if (alreadyConfigured && !force) {
    logger.info("setup", "already_configured", { tool: "claude" });
    return true;
  }

  // Remove our old entries from all event types if force-reconfiguring
  if (force || alreadyConfigured) {
    for (const eventName of HOOK_EVENTS) {
      const eventHooks = hooks[eventName] as Array<Record<string, unknown>> | undefined;
      if (eventHooks) {
        hooks[eventName] = eventHooks.filter((entry) => {
          const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
          return !entryHooks?.some(
            (h) => typeof h.command === "string" && h.command.includes(MARKER)
          );
        });
      }
    }
  }

  // Register our hook for each event type
  for (const eventName of HOOK_EVENTS) {
    if (!Array.isArray(hooks[eventName])) {
      hooks[eventName] = [];
    }

    const ourEntry: Record<string, unknown> = {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `sh ${hookPath}`,
        },
      ],
    };

    // PermissionRequest gets a long timeout so we can respond from VS Code (Phase 2)
    if (eventName === "PermissionRequest") {
      ourEntry.timeout = 86400;
    }

    (hooks[eventName] as Array<unknown>).push(ourEntry);
  }

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  logger.info("setup", "hook_configured", {
    tool: "claude",
    action: alreadyConfigured ? "replaced" : "appended",
    configPath,
  });
  return true;
}
