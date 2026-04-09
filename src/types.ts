export type AgentSource = "codex" | "claude";

export interface AgentEvent {
  source: AgentSource;
  title: string;
  message: string;
  cwd: string;
  threadId?: string;
  timestamp: number;
  rawPayload: Record<string, unknown>;
  remoteAuthority?: string;
}

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

export interface AgentNotifyConfig {
  port: number;
  configuredTools: AgentSource[];
  remoteHosts: Record<
    string,
    { configured: boolean; tools: AgentSource[] }
  >;
  version: number;
}
