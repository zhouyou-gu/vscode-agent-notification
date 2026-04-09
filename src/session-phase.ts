import { SessionPhase, HookEventName } from "./types";

/**
 * Valid state transitions for the session state machine.
 * Key = current phase, Value = set of phases it can transition to.
 */
const TRANSITIONS: Record<SessionPhase, Set<SessionPhase>> = {
  idle: new Set(["processing", "ended"]),
  processing: new Set([
    "waitingForInput",
    "waitingForApproval",
    "compacting",
    "ended",
  ]),
  waitingForInput: new Set(["processing", "ended"]),
  waitingForApproval: new Set(["processing", "waitingForInput", "ended"]),
  compacting: new Set(["processing", "waitingForInput", "ended"]),
  ended: new Set(), // terminal state
};

/**
 * Check if a state transition is valid.
 */
export function canTransition(from: SessionPhase, to: SessionPhase): boolean {
  return TRANSITIONS[from].has(to);
}

/**
 * Map a Claude Code hook event name to the session phase it implies.
 * Returns undefined for events that don't directly map to a phase change
 * (e.g. PreToolUse/PostToolUse update tool tracking, not session phase).
 */
export function phaseFromHookEvent(
  eventName: HookEventName
): SessionPhase | undefined {
  switch (eventName) {
    case "SessionStart":
      return "idle";
    case "UserPromptSubmit":
      return "processing";
    case "PermissionRequest":
      return "waitingForApproval";
    case "Stop":
    case "SubagentStop":
      return "waitingForInput";
    case "Notification":
      return "waitingForInput";
    case "SessionEnd":
      return "ended";
    case "PreCompact":
      return "compacting";
    case "PreToolUse":
    case "PostToolUse":
      return undefined; // handled via tool tracking, not phase change
  }
}

/**
 * Whether a session phase requires user attention (notification-worthy).
 */
export function needsAttention(phase: SessionPhase): boolean {
  return phase === "waitingForApproval";
}

/**
 * Whether a session is considered "active" (not ended).
 */
export function isActive(phase: SessionPhase): boolean {
  return phase !== "ended";
}

/**
 * Phases that should trigger a notification when transitioned to.
 */
export function shouldNotifyOnTransition(
  from: SessionPhase,
  to: SessionPhase
): boolean {
  // Notify when agent finishes processing (waiting for user)
  if (from === "processing" && to === "waitingForInput") return true;
  // Notify when permission approval is needed
  if (to === "waitingForApproval") return true;
  // Notify when session ends after processing
  if (from === "processing" && to === "ended") return true;
  return false;
}
