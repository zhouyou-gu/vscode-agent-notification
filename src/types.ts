export type AgentSource = "codex" | "claude";

export interface AgentEvent {
  source: AgentSource;
  title: string;
  message: string;
  cwd: string;
  threadId?: string;
  sessionId?: string;
  hookEventName?: HookEventName;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  timestamp: number;
  rawPayload: Record<string, unknown>;
  remoteAuthority?: string;
}

// ── Session state machine types ──────────────────────────────────

export type SessionPhase =
  | "idle"
  | "processing"
  | "waitingForInput"
  | "waitingForApproval"
  | "compacting"
  | "ended";

export interface AgentSession {
  id: string;
  source: AgentSource;
  cwd: string;
  projectName: string;
  phase: SessionPhase;
  lastActivity: number;
  createdAt: number;
  lastPhaseChange: number;
  tools: Map<string, ToolInProgress>;
  message?: string;
  permissionContext?: PermissionContext;
}

export interface PermissionContext {
  toolUseId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  receivedAt: number;
}

export interface ToolInProgress {
  id: string;
  name: string;
  startTime: number;
  phase: "starting" | "running" | "pendingApproval";
}

// All Claude Code hook event names
export type HookEventName =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PermissionRequest"
  | "Notification"
  | "Stop"
  | "SubagentStop"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export type LogCategory = "server" | "event" | "action" | "setup" | "error";

export interface LogEntry {
  timestamp: string;
  level: string;
  category: LogCategory;
  message: string;
  data?: Record<string, unknown>;
}

