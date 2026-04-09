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
import subprocess
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
    "processing": "working",
    "waitingForApproval": "needs approval",
    "waitingForInput": "done",
    "compacting": "compacting",
    "idle": "idle",
    "ended": "ended",
}

PHASE_ICONS = {
    "processing": "\u21bb",
    "waitingForApproval": "\u26a0\ufe0f",
    "waitingForInput": "\u2705",
    "compacting": "\u2026",
    "idle": "\u25cb",
    "ended": "\u2714\ufe0f",
}

# How long (seconds) a phase change counts as "recent" for highlighting
HIGHLIGHT_WINDOW_S = 30

MENU_ICON_SIZE = (16, 16)
STATUSBAR_ICON_SIZE = (18, 18)
MAX_SUMMARY_LEN = 60


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
        self.sessions = fetch_sessions()

        approvals = [s for s in self.sessions if s.get("phase") == "waitingForApproval"]
        processing = [s for s in self.sessions if s.get("phase") == "processing"]

        if not self.sessions:
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
        elif len(self.sessions) > 1:
            want_icon = ROBOT_ICON
            self.title = str(len(self.sessions))
        else:
            want_icon = ROBOT_ICON
            self.title = ""

        if want_icon and want_icon != self._current_icon:
            self.icon = want_icon
            self._current_icon = want_icon

        self.build_menu()

    def build_menu(self):
        self.menu.clear()

        active = [s for s in self.sessions if s.get("phase") != "ended"]
        header = rumps.MenuItem(f"Agent Notify \u2014 {len(active)} active, {len(self.sessions)} total")
        header.set_callback(None)
        self.menu.add(header)
        self.menu.add(rumps.separator)

        if not self.sessions:
            item = rumps.MenuItem("No sessions")
            item.set_callback(None)
            self.menu.add(item)
        else:
            now_ms = int(__import__("time").time() * 1000)

            def sort_key(s):
                phase = s.get("phase", "")
                last_change = s.get("lastPhaseChange", 0)
                is_recent = (now_ms - last_change) < HIGHLIGHT_WINDOW_S * 1000

                # Recently changed sessions float to top
                if is_recent and phase in ("waitingForInput", "waitingForApproval"):
                    return (0, -last_change)
                if phase == "waitingForApproval":
                    return (1, -last_change)
                if phase == "processing":
                    return (2, -last_change)
                if phase in ("waitingForInput", "idle", "compacting"):
                    return (3, -last_change)
                # ended at bottom
                return (4, -last_change)

            for s in sorted(self.sessions, key=sort_key):
                phase = s.get("phase", "unknown")
                source = s.get("source", "?")
                name = s.get("projectName", "unknown")
                cwd = s.get("cwd", "")
                message = s.get("message", "")
                last_change = s.get("lastPhaseChange", 0)
                is_recent = (now_ms - last_change) < HIGHLIGHT_WINDOW_S * 1000

                status = PHASE_ICONS.get(phase, "?")
                label = PHASE_LABELS.get(phase, phase)

                # Highlight recently-changed sessions
                if is_recent and phase in ("waitingForInput", "waitingForApproval"):
                    line = f"{status} {name}  \u00b7  {label}  \u2190 NEW"
                elif phase == "ended":
                    line = f"    {name}  \u00b7  {label}"
                else:
                    line = f"{status} {name}  \u00b7  {label}"

                pctx = s.get("permissionContext")
                if phase == "waitingForApproval" and pctx:
                    tool = pctx.get("toolName", "")
                    if tool:
                        line += f"  [{tool}]"

                def make_callback(folder, ws_file, session_name):
                    def cb(_):
                        log.info("menu_click  session=%s  folder=%s  workspace_file=%s", session_name, folder, ws_file)
                        focus_vscode_window(folder, ws_file)
                    return cb

                # Only use workspaceFile if this session's cwd is inside the workspace
                ws_file = None
                candidate_ws = s.get("workspaceFile")
                ws_folders = s.get("workspaceFolders", [])
                if candidate_ws and ws_folders and cwd:
                    for wf in ws_folders:
                        if cwd == wf or cwd.startswith(wf + "/"):
                            ws_file = candidate_ws
                            break
                item = rumps.MenuItem(line, callback=make_callback(cwd, ws_file, name))

                # Set agent app icon on the menu item
                icon_path = SOURCE_ICON_PATH.get(source)
                if icon_path:
                    item.set_icon(icon_path, dimensions=MENU_ICON_SIZE)

                self.menu.add(item)

                # Summary line (skip for ended sessions)
                if phase != "ended":
                    summary = truncate_summary(message)
                    if summary:
                        summary_item = rumps.MenuItem(f"       {summary}")
                        summary_item.set_callback(None)
                        self.menu.add(summary_item)

        self.menu.add(rumps.separator)
        self.menu.add(
            rumps.MenuItem("Focus VS Code", callback=lambda _: focus_vscode_window(""))
        )


if __name__ == "__main__":
    log.info("=== statusbar starting ===")
    log.info("robot_icon=%s  robot_icon_grey=%s", ROBOT_ICON, ROBOT_ICON_GREY)
    log.info("claude_icon=%s  codex_icon=%s", CLAUDE_ICON, CODEX_ICON)
    AgentStatusBarApp().run()
