#!/usr/bin/env python3
"""
macOS menu bar status widget for Agent Notification.
Uses rumps for a reliable status bar item.
Hidden when no active sessions, minimal when active.

Polls http://localhost:<port>/sessions every 3s.
"""

import json
import logging
import os
import re
import subprocess
import time
import urllib.request
import rumps

LOG_DIR = os.path.expanduser("~/.config/agent-notify/logs")
LOG_FILE = os.path.join(LOG_DIR, "statusbar.log")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.DEBUG,
    format="%(asctime)s  %(levelname)-5s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("statusbar")

PORT_FILE = os.path.expanduser("~/.config/agent-notify/port")
ICON_DIR = os.path.expanduser("~/.config/agent-notify/images")

# Full path to VS Code CLI — .app wrappers don't have user PATH
CODE_CLI = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"

# Fallback: check repo images dir (for development)
REPO_ICON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "images")

PHASE_LABELS = {
    "processing": "working\u2026",
    "waitingForApproval": "needs approval",
    "waitingForInput": "ready",
    "compacting": "compacting\u2026",
    "idle": "idle",
    "ended": "session ended",
}

PHASE_ICONS = {
    "processing": "\u21bb",        # ↻ spinning
    "waitingForApproval": "\u26a0\ufe0f",  # ⚠️
    "waitingForInput": "\u2705",    # ✅
    "compacting": "\u2026",         # …
    "idle": "\u25cb",               # ○
    "ended": "\u2501",              # ━ (dimmed dash)
}

# How long (seconds) a phase change counts as "recent" for highlighting
HIGHLIGHT_WINDOW_S = 30

MENU_ICON_SIZE = (16, 16)
MAX_SUMMARY_LEN = 60


def time_ago(ms_timestamp):
    """Human-readable relative time from a millisecond timestamp."""
    if not ms_timestamp:
        return ""
    delta_s = (time.time() * 1000 - ms_timestamp) / 1000
    if delta_s < 0:
        return ""
    if delta_s < 60:
        return "just now"
    if delta_s < 3600:
        m = int(delta_s / 60)
        return f"{m}m ago"
    if delta_s < 86400:
        h = int(delta_s / 3600)
        return f"{h}h ago"
    d = int(delta_s / 86400)
    return f"{d}d ago"


def find_icon(name):
    """Find an icon PNG by name, checking user-local then repo dirs."""
    for d in (ICON_DIR, REPO_ICON_DIR):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return None


# Menu bar robot icons
ROBOT_ICON = find_icon("robot_menu.png")
ROBOT_ICON_GREY = find_icon("robot_menu_grey.png")


def read_port():
    try:
        with open(PORT_FILE) as f:
            return int(f.read().strip())
    except Exception:
        return 19876


def fetch_sessions():
    port = read_port()
    try:
        req = urllib.request.Request(
            f"http://localhost:{port}/sessions",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            sessions = data.get("sessions", [])
            log.debug("fetch_sessions  port=%d  count=%d", port, len(sessions))
            return sessions
    except Exception as e:
        log.debug("fetch_sessions_failed  port=%d  error=%s", port, e)
        return []


# ── Filesystem session discovery ──────────────────────────────────

CLAUDE_PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
CODEX_SESSIONS_DIR = os.path.expanduser("~/.codex/sessions")
SCAN_RECENCY_S = 3600  # only look at files modified in the last hour


def _read_last_line(filepath):
    """Read the last non-empty line of a file efficiently."""
    try:
        with open(filepath, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size == 0:
                return None
            # Read last 4KB at most
            chunk = min(size, 4096)
            f.seek(-chunk, 2)
            data = f.read(chunk)
            lines = data.split(b"\n")
            for line in reversed(lines):
                stripped = line.strip()
                if stripped:
                    return stripped.decode("utf-8", errors="replace")
    except Exception:
        pass
    return None


def _read_first_line(filepath):
    """Read the first line of a file."""
    try:
        with open(filepath, "r") as f:
            return f.readline().strip()
    except Exception:
        return None


# Cache process lookups (refreshed at most every 10s)
_process_cache = {"claude_ids": set(), "codex_running": False, "ts": 0}
_PROCESS_CACHE_TTL = 10


def _refresh_process_cache():
    now = time.time()
    if now - _process_cache["ts"] < _PROCESS_CACHE_TTL:
        return
    _process_cache["ts"] = now

    # Claude session IDs
    ids = set()
    try:
        out = subprocess.check_output(
            ["ps", "-eo", "command"], text=True, timeout=3
        )
        for line in out.splitlines():
            m = re.search(r"claude.*--resume\s+(\S+)", line)
            if m:
                ids.add(m.group(1))
    except Exception:
        pass
    _process_cache["claude_ids"] = ids

    # Codex running
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", "codex app-server"],
            text=True, timeout=3, stderr=subprocess.DEVNULL
        )
        _process_cache["codex_running"] = bool(out.strip())
    except Exception:
        _process_cache["codex_running"] = False


def _get_running_claude_session_ids():
    _refresh_process_cache()
    return _process_cache["claude_ids"]


def _is_codex_running():
    _refresh_process_cache()
    return _process_cache["codex_running"]


def discover_sessions():
    """Scan filesystem + processes to discover active agent sessions.

    Returns a list of session dicts compatible with the /sessions API format.
    """
    discovered = []
    now = time.time()

    # ── Claude Code sessions ──
    running_claude_ids = _get_running_claude_session_ids()

    if os.path.isdir(CLAUDE_PROJECTS_DIR):
        for project_dir in os.listdir(CLAUDE_PROJECTS_DIR):
            project_path = os.path.join(CLAUDE_PROJECTS_DIR, project_dir)
            if not os.path.isdir(project_path):
                continue
            # Only look at top-level JSONL files — skip subagents/ directory
            for fname in os.listdir(project_path):
                if not fname.endswith(".jsonl") or fname.startswith("."):
                    continue
                # Skip files inside subdirectories (subagents, etc.)
                fpath = os.path.join(project_path, fname)
                if not os.path.isfile(fpath):
                    continue
                try:
                    mtime = os.path.getmtime(fpath)
                    if now - mtime > SCAN_RECENCY_S:
                        continue
                except OSError:
                    continue

                session_id = fname.replace(".jsonl", "")
                is_running = session_id in running_claude_ids

                # Read last line to get latest state
                last_line = _read_last_line(fpath)
                if not last_line:
                    continue
                try:
                    entry = json.loads(last_line)
                except json.JSONDecodeError:
                    continue

                cwd = entry.get("cwd", "")
                msg = ""
                if entry.get("type") == "assistant":
                    content = entry.get("message", {}).get("content", [])
                    for block in (content if isinstance(content, list) else []):
                        if isinstance(block, dict) and block.get("type") == "text":
                            msg = block.get("text", "")
                            break

                phase = "processing" if is_running else "waitingForInput"
                # If the last entry is a stop, it's done
                if entry.get("type") == "result" or (
                    entry.get("type") == "assistant"
                    and entry.get("message", {}).get("stop_reason") == "end_turn"
                    and not is_running
                ):
                    phase = "waitingForInput"

                discovered.append({
                    "id": session_id,
                    "source": "claude",
                    "cwd": cwd,
                    "projectName": os.path.basename(cwd) if cwd else session_id[:8],
                    "phase": phase,
                    "lastActivity": int(mtime * 1000),
                    "lastPhaseChange": int(mtime * 1000),
                    "createdAt": int(mtime * 1000),
                    "message": msg[:200] if msg else "",
                    "_discovered": True,
                })

    # ── Codex sessions ──
    codex_running = _is_codex_running()

    if os.path.isdir(CODEX_SESSIONS_DIR):
        # Look at recent date directories
        for dirpath, dirnames, filenames in os.walk(CODEX_SESSIONS_DIR):
            for fname in filenames:
                if not fname.endswith(".jsonl"):
                    continue
                fpath = os.path.join(dirpath, fname)
                try:
                    mtime = os.path.getmtime(fpath)
                    if now - mtime > SCAN_RECENCY_S:
                        continue
                except OSError:
                    continue

                # Read first line for session metadata (cwd)
                first_line = _read_first_line(fpath)
                cwd = ""
                session_id = ""
                if first_line:
                    try:
                        meta = json.loads(first_line)
                        payload = meta.get("payload", {})
                        cwd = payload.get("cwd", "")
                        session_id = payload.get("id", "")
                    except json.JSONDecodeError:
                        pass

                if not session_id:
                    # Extract from filename
                    m = re.search(r"([0-9a-f-]{36})", fname)
                    session_id = m.group(1) if m else fname.replace(".jsonl", "")

                # Read last line for latest message
                last_line = _read_last_line(fpath)
                msg = ""
                phase = "waitingForInput"
                if last_line:
                    try:
                        entry = json.loads(last_line)
                        p = entry.get("payload", {})
                        if p.get("type") == "task_complete":
                            msg = p.get("last_agent_message", "")
                            phase = "waitingForInput"
                        elif codex_running:
                            phase = "processing"
                    except json.JSONDecodeError:
                        pass

                discovered.append({
                    "id": session_id,
                    "source": "codex",
                    "cwd": cwd,
                    "projectName": os.path.basename(cwd) if cwd else session_id[:8],
                    "phase": phase,
                    "lastActivity": int(mtime * 1000),
                    "lastPhaseChange": int(mtime * 1000),
                    "createdAt": int(mtime * 1000),
                    "message": msg[:200] if msg else "",
                    "_discovered": True,
                })

    log.debug("discover_sessions  count=%d", len(discovered))
    return discovered


def _find_workspace_file(cwd):
    """Check if a .code-workspace file exists in or above the cwd."""
    if not cwd:
        return None
    # Check in the cwd itself
    try:
        for f in os.listdir(cwd):
            if f.endswith(".code-workspace"):
                return os.path.join(cwd, f)
    except OSError:
        pass
    return None


def merge_sessions(api_sessions, discovered):
    """Merge API sessions with filesystem-discovered sessions.

    API sessions take priority (they have richer state).
    Discovered sessions fill in gaps for sessions the API doesn't know about.
    """
    known_ids = {s.get("id") for s in api_sessions}
    # Also match by source+cwd to avoid duplicates
    known_keys = {(s.get("source"), s.get("cwd")) for s in api_sessions}

    merged = list(api_sessions)
    for d in discovered:
        if d["id"] in known_ids:
            continue
        if (d["source"], d["cwd"]) in known_keys:
            continue
        # Enrich discovered sessions with workspace file if available
        if not d.get("workspaceFile"):
            ws = _find_workspace_file(d.get("cwd", ""))
            if ws:
                d["workspaceFile"] = ws
                d["workspaceFolders"] = [d["cwd"]]
        merged.append(d)

    return merged


def truncate_summary(msg, max_len=MAX_SUMMARY_LEN):
    """Get first non-empty line, truncate to max_len."""
    if not msg:
        return ""
    for line in msg.split("\n"):
        stripped = line.strip()
        if stripped:
            if len(stripped) <= max_len:
                return stripped
            return stripped[: max_len - 1] + "\u2026"
    return ""


def focus_vscode_window(folder, workspace_file=None):
    """Focus the VS Code window for this folder/workspace.

    Hybrid approach for instant perceived focus:
    1. AppleScript 'activate' brings VS Code to macOS foreground instantly (~0.05s)
    2. 'code' CLI targets the specific window in the background (~1s)

    Both run as non-blocking Popen so this function returns immediately.
    """
    target = workspace_file or folder
    log.info("focus_request  folder=%s  workspace_file=%s", folder, workspace_file)

    # Step 1: Instantly bring VS Code to foreground
    subprocess.Popen(
        ["osascript", "-e", 'tell application "Visual Studio Code" to activate'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Step 2: Target the specific window via code CLI (background)
    if target:
        log.info("code_cli_bg  target=%s", target)
        subprocess.Popen(
            [CODE_CLI, target],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        log.info("activate_only  no target")


# Pre-resolve icon paths at startup
CLAUDE_ICON = find_icon("claude_32.png")
CODEX_ICON = find_icon("codex_32.png")

SOURCE_ICON_PATH = {
    "claude": CLAUDE_ICON,
    "codex": CODEX_ICON,
}


class AgentStatusBarApp(rumps.App):
    def __init__(self):
        super().__init__("Agent Notify", icon=ROBOT_ICON_GREY, quit_button="Quit")
        self.sessions = []
        self.title = ""
        self._current_icon = ROBOT_ICON_GREY

    @rumps.timer(3)
    def poll(self, _):
        api_sessions = fetch_sessions()
        discovered = discover_sessions()
        self.sessions = merge_sessions(api_sessions, discovered)

        active = [s for s in self.sessions if s.get("phase") not in ("ended", "idle")]
        approvals = [s for s in active if s.get("phase") == "waitingForApproval"]
        processing = [s for s in active if s.get("phase") == "processing"]

        if not active:
            want_icon = ROBOT_ICON_GREY
            self.title = ""
        elif approvals:
            want_icon = ROBOT_ICON
            n = len(approvals)
            self.title = f"\u26a0{n}" if n > 1 else "\u26a0"
        elif processing:
            want_icon = ROBOT_ICON
            n = len(processing)
            self.title = f"\u21bb{n}" if n > 1 else "\u21bb"
        elif len(active) > 1:
            want_icon = ROBOT_ICON
            self.title = str(len(active))
        else:
            want_icon = ROBOT_ICON
            self.title = ""

        if want_icon and want_icon != self._current_icon:
            self.icon = want_icon
            self._current_icon = want_icon

        self.build_menu()

    def build_menu(self):
        self.menu.clear()
        now_ms = int(time.time() * 1000)

        if not self.sessions:
            empty = rumps.MenuItem("No active agent sessions")
            empty.set_callback(None)
            self.menu.add(empty)
            return

        # Partition sessions
        attention = []  # needs action from user
        working = []    # agents busy
        ready = []      # agents done, waiting
        background = [] # ended/idle

        for s in self.sessions:
            phase = s.get("phase", "")
            last_change = s.get("lastPhaseChange", 0)
            is_recent = (now_ms - last_change) < HIGHLIGHT_WINDOW_S * 1000
            s["_is_recent"] = is_recent

            if phase == "waitingForApproval":
                attention.append(s)
            elif phase == "processing" or phase == "compacting":
                working.append(s)
            elif phase == "waitingForInput":
                if is_recent:
                    attention.append(s)  # just finished → needs attention
                else:
                    ready.append(s)
            elif phase == "ended":
                background.append(s)
            else:
                ready.append(s)

        # Sort each group by recency
        for group in (attention, working, ready, background):
            group.sort(key=lambda s: -s.get("lastActivity", 0))

        def add_section(label, sessions):
            if not sessions:
                return
            header = rumps.MenuItem(label)
            header.set_callback(None)
            self.menu.add(header)
            for s in sessions:
                self._add_session_item(s, now_ms)
            self.menu.add(rumps.separator)

        if attention:
            add_section("\u2757 Needs attention", attention)
        if working:
            add_section("\u21bb Working", working)
        if ready:
            add_section("\u2705 Ready", ready)
        if background:
            add_section("\u2501 Ended", background)

    def _add_session_item(self, s, now_ms):
        phase = s.get("phase", "unknown")
        source = s.get("source", "?")
        name = s.get("projectName", "unknown")
        cwd = s.get("cwd", "")
        message = s.get("message", "")
        is_recent = s.get("_is_recent", False)

        status = PHASE_ICONS.get(phase, "?")
        label = PHASE_LABELS.get(phase, phase)
        ago = time_ago(s.get("lastActivity", 0))

        # Build the main line
        if is_recent and phase in ("waitingForInput", "waitingForApproval"):
            line = f"{status} {name}  \u2022  {label}  \u25c0 new"
        elif phase == "ended":
            line = f"  {name}  \u2022  {ago}"
        else:
            parts = [f"{status} {name}  \u2022  {label}"]
            if ago and phase not in ("processing", "compacting"):
                parts.append(ago)
            line = "  ".join(parts)

        # Approval detail
        pctx = s.get("permissionContext")
        if phase == "waitingForApproval" and pctx:
            tool = pctx.get("toolName", "")
            if tool:
                line += f"  [{tool}]"

        def make_callback(folder, ws_file, session_name):
            def cb(_):
                log.info("menu_click  session=%s  folder=%s  workspace_file=%s",
                         session_name, folder, ws_file)
                focus_vscode_window(folder, ws_file)
            return cb

        # Resolve workspace file for click-to-jump
        ws_file = None
        candidate_ws = s.get("workspaceFile")
        ws_folders = s.get("workspaceFolders", [])
        if candidate_ws and cwd:
            if ws_folders:
                for wf in ws_folders:
                    if cwd == wf or cwd.startswith(wf + "/"):
                        ws_file = candidate_ws
                        break
            elif s.get("_discovered"):
                ws_file = candidate_ws

        item = rumps.MenuItem(line, callback=make_callback(cwd, ws_file, name))

        icon_path = SOURCE_ICON_PATH.get(source)
        if icon_path:
            item.set_icon(icon_path, dimensions=MENU_ICON_SIZE)

        self.menu.add(item)

        # Summary line (skip for ended)
        if phase != "ended":
            summary = truncate_summary(message)
            if summary:
                sub = rumps.MenuItem(f"    {summary}")
                sub.set_callback(None)
                self.menu.add(sub)


if __name__ == "__main__":
    log.info("=== statusbar starting ===")
    log.info("robot_icon=%s  robot_icon_grey=%s", ROBOT_ICON, ROBOT_ICON_GREY)
    log.info("claude_icon=%s  codex_icon=%s", CLAUDE_ICON, CODEX_ICON)
    AgentStatusBarApp().run()
