import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import { execFile } from "child_process";
import { AgentSource } from "./types";
import { Logger } from "./logger";

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-notify");
const HOOKS_DIR = path.join(CONFIG_DIR, "hooks");
const MARKER = "agent-notify";
const TN_APP = path.join(CONFIG_DIR, "terminal-notifier.app");
const TN_BIN = path.join(TN_APP, "Contents", "MacOS", "terminal-notifier");
const TN_URL = "https://github.com/julienXX/terminal-notifier/releases/download/2.0.0/terminal-notifier-2.0.0.zip";

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
# agent-notify v1 — do not edit (managed by Agent Notification extension)
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

  // Download terminal-notifier for macOS banners (one-time)
  if (process.platform === "darwin") {
    await ensureTerminalNotifier(logger);
  }

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

export async function ensureTerminalNotifier(logger: Logger): Promise<boolean> {
  if (fs.existsSync(TN_BIN)) {
    logger.info("setup", "terminal_notifier_exists", { path: TN_BIN });
    return true;
  }

  logger.info("setup", "downloading_terminal_notifier");
  const zipPath = path.join(CONFIG_DIR, "terminal-notifier.zip");

  try {
    await downloadFile(TN_URL, zipPath);
    await new Promise<void>((resolve, reject) => {
      execFile("unzip", ["-o", zipPath, "-d", CONFIG_DIR], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    fs.unlinkSync(zipPath);
    // Clean up extra files from the zip
    const readmePath = path.join(CONFIG_DIR, "README.markdown");
    if (fs.existsSync(readmePath)) fs.unlinkSync(readmePath);

    logger.info("setup", "terminal_notifier_installed", { path: TN_BIN });
    return true;
  } catch (err) {
    logger.error("setup", "terminal_notifier_download_failed", { error: String(err) });
    return false;
  }
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (url: string) => {
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location!);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", reject);
      }).on("error", reject);
    };
    follow(url);
  });
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

  // Navigate to hooks.Notification
  if (!config.hooks || typeof config.hooks !== "object") {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown>;

  if (!Array.isArray(hooks.Notification)) {
    hooks.Notification = [];
  }
  const notifHooks = hooks.Notification as Array<Record<string, unknown>>;

  // Check if already configured
  const alreadyConfigured = notifHooks.some((entry) => {
    const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
    return entryHooks?.some(
      (h) => typeof h.command === "string" && h.command.includes(MARKER)
    );
  });

  if (alreadyConfigured && !force) {
    logger.info("setup", "already_configured", { tool: "claude" });
    return true;
  }

  // Remove our old entry if force-reconfiguring
  if (force) {
    hooks.Notification = notifHooks.filter((entry) => {
      const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      return !entryHooks?.some(
        (h) => typeof h.command === "string" && h.command.includes(MARKER)
      );
    });
  }

  // Append our hook entry
  const ourEntry = {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `sh ${hookPath}`,
      },
    ],
  };

  (hooks.Notification as Array<unknown>).push(ourEntry);

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  logger.info("setup", "hook_configured", {
    tool: "claude",
    action: alreadyConfigured ? "replaced" : "appended",
    existingHooks: notifHooks.length,
    configPath,
  });
  return true;
}
