import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LogLevel, LogCategory, LogEntry } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-notify");
const LOGS_DIR = path.join(CONFIG_DIR, "logs");

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

function parseLogLevel(s: string): LogLevel {
  switch (s.toLowerCase()) {
    case "debug":
      return LogLevel.DEBUG;
    case "warn":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export class Logger {
  private outputChannel: vscode.OutputChannel;
  private minLevel: LogLevel;
  private retentionDays: number;
  private ensuredDir = false;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("Agent Notification");
    const config = vscode.workspace.getConfiguration("agent-notify");
    this.minLevel = parseLogLevel(config.get<string>("logLevel", "info"));
    this.retentionDays = config.get<number>("logRetentionDays", 14);
  }

  reloadConfig(): void {
    const config = vscode.workspace.getConfiguration("agent-notify");
    this.minLevel = parseLogLevel(config.get<string>("logLevel", "info"));
    this.retentionDays = config.get<number>("logRetentionDays", 14);
  }

  private ensureLogDir(): void {
    if (this.ensuredDir) return;
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    this.ensuredDir = true;
  }

  private write(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>
  ): void {
    if (level < this.minLevel) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LEVEL_NAMES[level],
      category,
      message,
      ...(data !== undefined && { data }),
    };

    const line = JSON.stringify(entry);

    // Write to VS Code output channel
    this.outputChannel.appendLine(
      `[${entry.timestamp}] [${entry.level}] [${category}] ${message}${data ? " " + JSON.stringify(data) : ""}`
    );

    // Write to file
    try {
      this.ensureLogDir();
      const filename = `${category}-${todayStamp()}.log`;
      fs.appendFileSync(path.join(LOGS_DIR, filename), line + "\n");
    } catch {
      // Logging should never crash the extension
    }
  }

  debug(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.DEBUG, category, message, data);
  }

  info(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.INFO, category, message, data);
  }

  warn(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.WARN, category, message, data);
  }

  error(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.ERROR, category, message, data);
    // Errors also go to the error category file
    if (category !== "error") {
      this.write(LogLevel.ERROR, "error", message, data);
    }
  }

  cleanOldLogs(): void {
    try {
      this.ensureLogDir();
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(LOGS_DIR);
      for (const file of files) {
        if (!file.endsWith(".log")) continue;
        const filePath = path.join(LOGS_DIR, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          this.info("setup", "deleted_old_log", { file });
        }
      }
    } catch {
      // Best effort
    }
  }

  showOutputChannel(): void {
    this.outputChannel.show();
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}
