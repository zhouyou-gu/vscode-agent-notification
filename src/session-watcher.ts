import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AgentEvent } from "./types";
import { Logger } from "./logger";
import { SessionStore } from "./session-store";

const POLL_INTERVAL_MS = 2000;

/**
 * Watches Claude Code and Codex JSONL session files for completion events.
 * Uses fs.watchFile (polling) since VS Code's createFileSystemWatcher
 * doesn't reliably detect changes outside the workspace.
 *
 * When a SessionStore is provided, events are routed through it for
 * state tracking and dedup. Otherwise, events go directly to onEvent callback.
 */
export class SessionWatcher {
  private logger: Logger;
  private onEvent: (event: AgentEvent) => void;
  private sessionStore?: SessionStore;

  // Track file sizes to only read new content
  private fileSizes = new Map<string, number>();
  // Watched files (for cleanup)
  private watchedFiles = new Set<string>();
  // Directory scan interval
  private scanInterval: ReturnType<typeof setInterval> | null = null;

  // Paths
  private claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  private codexSessionsDir = path.join(os.homedir(), ".codex", "sessions");

  constructor(
    logger: Logger,
    onEvent: (event: AgentEvent) => void,
    sessionStore?: SessionStore
  ) {
    this.logger = logger;
    this.onEvent = onEvent;
    this.sessionStore = sessionStore;
  }

  private emitEvent(event: AgentEvent): void {
    if (this.sessionStore) {
      this.sessionStore.processWatcherEvent(event);
    } else {
      this.onEvent(event);
    }
  }

  start(): void {
    // Initial scan for active session files
    this.scanAndWatch();

    // Re-scan periodically for new session files
    this.scanInterval = setInterval(() => this.scanAndWatch(), 10_000);

    this.logger.info("setup", "session_watcher_started");
  }

  private scanAndWatch(): void {
    this.scanClaudeSessions();
    this.scanCodexSessions();
  }

  // ── Claude Code ──────────────────────────────────────────────────

  private scanClaudeSessions(): void {
    if (!fs.existsSync(this.claudeProjectsDir)) return;

    try {
      // Find all .jsonl files in project subdirectories
      const projectDirs = fs.readdirSync(this.claudeProjectsDir);
      for (const dir of projectDirs) {
        const projectPath = path.join(this.claudeProjectsDir, dir);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(projectPath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        const files = fs.readdirSync(projectPath);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = path.join(projectPath, file);

          // Only watch recently modified files (within last hour)
          try {
            const fstat = fs.statSync(filePath);
            if (Date.now() - fstat.mtimeMs > 3600_000) continue;
          } catch {
            continue;
          }

          this.watchFile(filePath, "claude");
        }
      }
    } catch (err) {
      this.logger.error("setup", "scan_claude_sessions_failed", {
        error: String(err),
      });
    }
  }

  // ── Codex ────────────────────────────────────────────────────────

  private scanCodexSessions(): void {
    if (!fs.existsSync(this.codexSessionsDir)) return;

    try {
      // Codex sessions: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
      // Only look at today's directory
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      const todayDir = path.join(this.codexSessionsDir, year, month, day);

      if (!fs.existsSync(todayDir)) return;

      const files = fs.readdirSync(todayDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(todayDir, file);

        // Only watch recently modified files (within last hour)
        try {
          const fstat = fs.statSync(filePath);
          if (Date.now() - fstat.mtimeMs > 3600_000) continue;
        } catch {
          continue;
        }

        this.watchFile(filePath, "codex");
      }
    } catch (err) {
      this.logger.error("setup", "scan_codex_sessions_failed", {
        error: String(err),
      });
    }
  }

  // ── File watching ────────────────────────────────────────────────

  private watchFile(filePath: string, source: "claude" | "codex"): void {
    if (this.watchedFiles.has(filePath)) return;

    // Initialize size to current size (don't process existing content)
    try {
      const stat = fs.statSync(filePath);
      this.fileSizes.set(filePath, stat.size);
    } catch {
      return;
    }

    this.watchedFiles.add(filePath);

    fs.watchFile(filePath, { interval: POLL_INTERVAL_MS }, (curr, prev) => {
      if (curr.size <= prev.size) {
        this.fileSizes.set(filePath, curr.size);
        return;
      }

      const prevSize = this.fileSizes.get(filePath) || prev.size;
      this.fileSizes.set(filePath, curr.size);

      this.readNewLines(filePath, prevSize, (line) => {
        if (source === "claude") {
          this.processClaudeLine(line);
        } else {
          this.processCodexLine(line);
        }
      });
    });

    this.logger.info("setup", "watching_session_file", {
      source,
      file: path.basename(filePath),
    });
  }

  // ── Line processors ──────────────────────────────────────────────

  private processClaudeLine(line: string): void {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") return;

      const msg = entry.message;
      if (!msg || typeof msg !== "object") return;
      if (msg.stop_reason !== "end_turn") return;

      // Extract text from content blocks
      const content = msg.content;
      let text = "";
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            text = block.text;
            break;
          }
        }
      }

      const firstLine =
        text
          .split("\n")
          .map((l: string) => l.trim())
          .find((l: string) => l.length > 0) || "Task complete";

      const truncated =
        firstLine.length > 150 ? firstLine.slice(0, 147) + "..." : firstLine;

      const event: AgentEvent = {
        source: "claude",
        title: "Claude Code",
        message: truncated,
        cwd: entry.cwd || "",
        threadId: entry.sessionId || undefined,
        sessionId: entry.sessionId || undefined,
        timestamp: Date.now(),
        rawPayload: { stop_reason: "end_turn", entrypoint: entry.entrypoint },
      };

      this.logger.info("event", "claude_session_completion", {
        cwd: event.cwd,
        sessionId: entry.sessionId,
        entrypoint: entry.entrypoint,
      });

      this.emitEvent(event);
    } catch {
      // Not valid JSON or unexpected format — skip
    }
  }

  private processCodexLine(line: string): void {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "event_msg") return;

      const payload = entry.payload;
      if (!payload || payload.type !== "task_complete") return;

      const message = payload.last_agent_message || "Task complete";
      const firstLine =
        message
          .split("\n")
          .map((l: string) => l.trim())
          .find((l: string) => l.length > 0) || "Task complete";

      const truncated =
        firstLine.length > 150 ? firstLine.slice(0, 147) + "..." : firstLine;

      const cwd = payload.cwd || "";

      const event: AgentEvent = {
        source: "codex",
        title: "Codex",
        message: truncated,
        cwd,
        threadId: payload.turn_id || undefined,
        timestamp: Date.now(),
        rawPayload: { type: "task_complete" },
      };

      this.logger.info("event", "codex_session_completion", {
        cwd: event.cwd,
        turnId: payload.turn_id,
      });

      this.emitEvent(event);
    } catch {
      // Not valid JSON or unexpected format — skip
    }
  }

  // ── Shared utilities ─────────────────────────────────────────────

  private readNewLines(
    filePath: string,
    fromByte: number,
    onLine: (line: string) => void
  ): void {
    try {
      const fd = fs.openSync(filePath, "r");
      const stat = fs.fstatSync(fd);
      const bytesToRead = stat.size - fromByte;

      if (bytesToRead <= 0) {
        fs.closeSync(fd);
        return;
      }

      // Cap at 64KB to avoid reading huge chunks
      const maxRead = Math.min(bytesToRead, 64 * 1024);
      const buffer = Buffer.alloc(maxRead);
      fs.readSync(fd, buffer, 0, maxRead, fromByte);
      fs.closeSync(fd);

      const text = buffer.toString("utf-8");
      const lines = text.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          onLine(trimmed);
        }
      }
    } catch (err) {
      this.logger.error("event", "read_session_file_failed", {
        filePath,
        error: String(err),
      });
    }
  }

  dispose(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    for (const filePath of this.watchedFiles) {
      fs.unwatchFile(filePath);
    }
    this.watchedFiles.clear();
    this.fileSizes.clear();
  }
}
