import * as path from "path";
import * as vscode from "vscode";
import type {
  AgentSource,
  AgentEvent,
  AgentSession,
  SessionPhase,
  HookEventName,
  ToolInProgress,
} from "./types";
import {
  canTransition,
  phaseFromHookEvent,
  shouldNotifyOnTransition,
} from "./session-phase";
import { Logger } from "./logger";

const SESSION_EXPIRE_MS = 10 * 60 * 1000; // 10 minutes
const DEDUP_WINDOW_MS = 1000; // 1 second

/**
 * Central session state manager. All events (HTTP hooks + JSONL watcher)
 * flow through here. Fires VS Code EventEmitter on state changes.
 */
export class SessionStore {
  private sessions = new Map<string, AgentSession>();
  private logger: Logger;

  // toolUseId cache: PreToolUse caches tool_use_id, PermissionRequest pops it.
  // Keyed by "sessionId:toolName:inputHash" with FIFO queue per key
  // (matches claude-island's pattern for when multiple tools of same type run)
  private toolUseIdCache = new Map<string, string[]>();

  // Dedup: last event key → timestamp
  private lastEventKeys = new Map<string, number>();

  // Event emitters for UI updates
  private _onSessionChanged = new vscode.EventEmitter<AgentSession>();
  readonly onSessionChanged = this._onSessionChanged.event;

  private _onNotification = new vscode.EventEmitter<AgentEvent>();
  readonly onNotification = this._onNotification.event;

  private expireTimer: ReturnType<typeof setInterval>;

  constructor(logger: Logger) {
    this.logger = logger;
    // Expire stale sessions every 1 minute
    this.expireTimer = setInterval(() => this.expireSessions(), 60 * 1000);
  }

  /**
   * Single entry point for all events from HTTP hooks.
   */
  processHookEvent(
    source: AgentSource,
    payload: Record<string, unknown>
  ): void {
    if (source === "claude") {
      this.processClaudeHookEvent(payload);
    } else if (source === "codex") {
      this.processCodexHookEvent(payload);
    }
  }

  /**
   * Entry point for events detected by the JSONL session file watcher.
   */
  processWatcherEvent(event: AgentEvent): void {
    const sessionId = event.sessionId || event.threadId || `watcher-${event.source}-${event.cwd}`;

    // Dedup: if we recently got the same event via HTTP hook, skip
    const dedupKey = `${sessionId}:${event.source}:completion`;
    if (this.isDuplicate(dedupKey)) {
      this.logger.debug("event", "watcher_event_deduped", {
        sessionId,
        source: event.source,
      });
      return;
    }

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession(sessionId, event.source, event.cwd);
    }

    // Watcher events are completion events — transition to waitingForInput
    const prevPhase = session.phase;
    const targetPhase: SessionPhase = "waitingForInput";

    if (canTransition(prevPhase, targetPhase) || prevPhase === "idle") {
      session.phase = targetPhase;
      session.lastActivity = Date.now();
      session.message = event.message;

      this.logger.info("event", "session_phase_change", {
        sessionId,
        source: event.source,
        from: prevPhase,
        to: targetPhase,
        trigger: "watcher",
      });

      this._onSessionChanged.fire(session);

      // Always notify for watcher completion events
      if (prevPhase !== "waitingForInput") {
        this._onNotification.fire(event);
      }
    }
  }

  // ── Claude Code hook events ────────────────────────────────────

  private processClaudeHookEvent(payload: Record<string, unknown>): void {
    const hookEventName = payload.hook_event_name as HookEventName | undefined;
    if (!hookEventName) {
      // Legacy: treat as Notification event for backward compat
      this.processLegacyClaudeEvent(payload);
      return;
    }

    const sessionId = String(payload.session_id || "unknown");
    const cwd = String(payload.cwd || "");

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession(sessionId, "claude", cwd);
    }
    session.lastActivity = Date.now();
    if (cwd) session.cwd = cwd;

    // Handle tool tracking
    if (hookEventName === "PreToolUse") {
      this.handlePreToolUse(session, payload);
      return;
    }
    if (hookEventName === "PostToolUse") {
      this.handlePostToolUse(session, payload);
      return;
    }
    if (hookEventName === "PermissionRequest") {
      this.handlePermissionRequest(session, payload);
      return;
    }

    // Phase transition
    const targetPhase = phaseFromHookEvent(hookEventName);
    if (!targetPhase) return;

    this.transitionSession(session, targetPhase, hookEventName, payload);
  }

  private processLegacyClaudeEvent(payload: Record<string, unknown>): void {
    // Pre-v2 payloads without hook_event_name — treat as completion
    const sessionId = String(payload.session_id || `legacy-claude-${payload.cwd || "unknown"}`);
    const cwd = String(payload.cwd || "");

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession(sessionId, "claude", cwd);
    }
    session.lastActivity = Date.now();
    session.message = String(payload.message || payload.title || "Task complete");

    this.transitionSession(session, "waitingForInput", "Notification", payload);
  }

  // ── Codex hook events ──────────────────────────────────────────

  private processCodexHookEvent(payload: Record<string, unknown>): void {
    if (payload.type !== "agent-turn-complete") return;

    const threadId = String(payload["thread-id"] || "");
    const cwd = String(payload.cwd || "");
    const sessionId = threadId || `codex-${cwd}`;

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession(sessionId, "codex", cwd);
    }
    session.lastActivity = Date.now();

    const message = String(payload["last-assistant-message"] || "Turn complete");
    session.message = message;

    this.transitionSession(session, "waitingForInput", undefined, payload);
  }

  // ── Tool tracking ──────────────────────────────────────────────

  private handlePreToolUse(
    session: AgentSession,
    payload: Record<string, unknown>
  ): void {
    const toolUseId = String(payload.tool_use_id || "");
    const toolName = String(payload.tool_name || "unknown");
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;

    if (toolUseId) {
      // FIFO cache keyed by sessionId:toolName:inputHash (claude-island pattern)
      const cacheKey = this.toolCacheKey(session.id, toolName, toolInput);
      const queue = this.toolUseIdCache.get(cacheKey) || [];
      queue.push(toolUseId);
      this.toolUseIdCache.set(cacheKey, queue);

      const tool: ToolInProgress = {
        id: toolUseId,
        name: toolName,
        startTime: Date.now(),
        phase: "running",
      };
      session.tools.set(toolUseId, tool);
    }

    // Ensure we're in processing phase
    if (session.phase !== "processing") {
      this.transitionSession(session, "processing", "PreToolUse", payload);
    }

    this._onSessionChanged.fire(session);
  }

  private handlePostToolUse(
    session: AgentSession,
    payload: Record<string, unknown>
  ): void {
    const toolUseId = String(payload.tool_use_id || "");
    if (toolUseId) {
      session.tools.delete(toolUseId);

      // Clear permission context if this tool was the one pending approval
      if (session.permissionContext?.toolUseId === toolUseId) {
        session.permissionContext = undefined;
        // Transition back to processing (approval was handled)
        if (session.phase === "waitingForApproval") {
          this.transitionSession(session, "processing", "PostToolUse", payload);
        }
      }
    }
    this._onSessionChanged.fire(session);
  }

  private handlePermissionRequest(
    session: AgentSession,
    payload: Record<string, unknown>
  ): void {
    const toolName = String(payload.tool_name || "unknown");
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;

    // Pop tool_use_id from FIFO cache (PreToolUse fires before PermissionRequest)
    const cacheKey = this.toolCacheKey(session.id, toolName, toolInput);
    const queue = this.toolUseIdCache.get(cacheKey);
    const toolUseId = queue?.shift() || `perm-${Date.now()}`;
    if (queue && queue.length === 0) {
      this.toolUseIdCache.delete(cacheKey);
    }

    // Mark tool as pending approval
    const existingTool = session.tools.get(toolUseId);
    if (existingTool) {
      existingTool.phase = "pendingApproval";
    }

    session.permissionContext = {
      toolUseId,
      toolName,
      toolInput,
      receivedAt: Date.now(),
    };

    session.message = `Tool "${toolName}" needs approval`;
    this.transitionSession(session, "waitingForApproval", "PermissionRequest", payload);
  }

  private toolCacheKey(
    sessionId: string,
    toolName: string,
    toolInput?: Record<string, unknown>
  ): string {
    const inputStr = toolInput ? JSON.stringify(toolInput) : "";
    return `${sessionId}:${toolName}:${inputStr}`;
  }

  // ── Session lifecycle ──────────────────────────────────────────

  private transitionSession(
    session: AgentSession,
    targetPhase: SessionPhase,
    hookEventName: HookEventName | undefined,
    payload: Record<string, unknown>
  ): void {
    const prevPhase = session.phase;

    // Allow idle → any transition (implicit start)
    if (prevPhase === "idle" || canTransition(prevPhase, targetPhase)) {
      session.phase = targetPhase;
      session.lastActivity = Date.now();
      session.lastPhaseChange = Date.now();

      if (targetPhase === "ended") {
        session.tools.clear();
        session.permissionContext = undefined;
      }
      if (targetPhase === "processing") {
        session.permissionContext = undefined;
      }

      this.logger.info("event", "session_phase_change", {
        sessionId: session.id,
        source: session.source,
        from: prevPhase,
        to: targetPhase,
        trigger: hookEventName || "codex",
      });

      this._onSessionChanged.fire(session);

      // State-driven notifications: only on meaningful transitions
      // (claude-island pattern: UI drives from phase, not explicit notify calls)
      if (shouldNotifyOnTransition(prevPhase, targetPhase)) {
        const event = this.buildAgentEvent(session, hookEventName, payload);
        this._onNotification.fire(event);
      }
    } else {
      this.logger.debug("event", "invalid_transition_ignored", {
        sessionId: session.id,
        from: prevPhase,
        to: targetPhase,
        trigger: hookEventName,
      });
    }
  }

  private createSession(
    id: string,
    source: AgentSource,
    cwd: string
  ): AgentSession {
    // End any older session for the same source + cwd
    // (new session supersedes the old one for this project)
    if (cwd) {
      for (const [oldId, oldSession] of this.sessions) {
        if (
          oldId !== id &&
          oldSession.source === source &&
          oldSession.cwd === cwd &&
          oldSession.phase !== "ended"
        ) {
          oldSession.phase = "ended";
          oldSession.tools.clear();
          oldSession.permissionContext = undefined;
          this.logger.info("event", "session_superseded", {
            oldSessionId: oldId,
            newSessionId: id,
            source,
            cwd,
          });
          this._onSessionChanged.fire(oldSession);
        }
      }
    }

    const now = Date.now();
    const session: AgentSession = {
      id,
      source,
      cwd,
      projectName: cwd ? path.basename(cwd) : "unknown",
      phase: "idle",
      lastActivity: now,
      createdAt: now,
      lastPhaseChange: now,
      tools: new Map(),
    };
    this.sessions.set(id, session);
    this.logger.info("event", "session_created", {
      sessionId: id,
      source,
      cwd,
    });
    return session;
  }

  // ── Helpers ────────────────────────────────────────────────────

  private buildAgentEvent(
    session: AgentSession,
    hookEventName: HookEventName | undefined,
    payload: Record<string, unknown>
  ): AgentEvent {
    const event: AgentEvent = {
      source: session.source,
      title: session.source === "claude" ? "Claude Code" : "Codex",
      message: session.message || "Task complete",
      cwd: session.cwd,
      sessionId: session.id,
      hookEventName,
      timestamp: Date.now(),
      rawPayload: payload,
    };

    // Enrich with permission context when available
    if (session.permissionContext) {
      event.toolName = session.permissionContext.toolName;
      event.toolUseId = session.permissionContext.toolUseId;
      event.toolInput = session.permissionContext.toolInput;
    }

    return event;
  }

  private isDuplicate(key: string): boolean {
    const last = this.lastEventKeys.get(key);
    const now = Date.now();
    if (last && now - last < DEDUP_WINDOW_MS) {
      return true;
    }
    this.lastEventKeys.set(key, now);
    return false;
  }

  private expireSessions(): void {
    const cutoff = Date.now() - SESSION_EXPIRE_MS;
    // Ended sessions stick around for 5 minutes so users can still
    // click them in the menu bar to jump to the window
    const endedCutoff = Date.now() - 5 * 60_000;
    for (const [id, session] of this.sessions) {
      if (session.phase === "ended" && session.lastActivity < endedCutoff) {
        this.sessions.delete(id);
        this.logger.debug("event", "session_expired", { sessionId: id, reason: "ended" });
      } else if (session.lastActivity < cutoff) {
        this.sessions.delete(id);
        this.logger.debug("event", "session_expired", { sessionId: id, reason: "inactive" });
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): AgentSession[] {
    return this.getAllSessions().filter((s) => s.phase !== "ended");
  }

  clearAllSessions(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    this.toolUseIdCache.clear();
    this.lastEventKeys.clear();
    this._onSessionChanged.fire(null as unknown as AgentSession);
    return count;
  }

  getSessionsNeedingAttention(): AgentSession[] {
    return this.getAllSessions().filter(
      (s) => s.phase === "waitingForApproval"
    );
  }

  dispose(): void {
    clearInterval(this.expireTimer);
    this._onSessionChanged.dispose();
    this._onNotification.dispose();
    this.sessions.clear();
    this.toolUseIdCache.clear();
    this.lastEventKeys.clear();
  }
}
