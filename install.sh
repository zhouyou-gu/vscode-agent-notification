#!/bin/sh
# Agent Notification — one-command installer
# Usage: curl -fsSL https://raw.githubusercontent.com/zhouyou-gu/vscode-agent-notification/main/install.sh | sh
set -e

REPO="zhouyou-gu/vscode-agent-notification"
RAW_BASE="https://raw.githubusercontent.com/$REPO/main"
INSTALL_DIR="$HOME/.config/agent-notify"
STATUSBAR_DIR="$INSTALL_DIR/statusbar"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

info()  { printf "  → %s\n" "$*"; }
warn()  { printf "  ⚠ %s\n" "$*"; }
fail()  { printf "  ✗ %s\n" "$*"; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────

echo "==> Checking dependencies..."
command -v curl  >/dev/null 2>&1 || fail "curl is required"
[ "$(uname)" = "Darwin" ]       || fail "macOS required (this extension is macOS-only)"

# Find VS Code CLI
CODE=""
if command -v code >/dev/null 2>&1; then
  CODE="code"
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
fi

# ── Step 1: VS Code extension ────────────────────────────────────

echo "==> Installing VS Code extension..."
if [ -z "$CODE" ]; then
  warn "VS Code CLI not found — skipping extension install."
  warn "After installing VS Code, run: code --install-extension <vsix>"
else
  DOWNLOAD_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep "browser_download_url.*\.vsix" \
    | head -1 \
    | cut -d '"' -f 4) || true

  if [ -z "$DOWNLOAD_URL" ]; then
    warn "No .vsix in latest release — build from source instead."
  elif curl -fsSL -o "$TMP_DIR/extension.vsix" "$DOWNLOAD_URL"; then
    "$CODE" --install-extension "$TMP_DIR/extension.vsix" --force
    info "Extension installed."
  else
    warn "Download failed — skipping extension install."
  fi
fi

# ── Step 2: terminal-notifier ─────────────────────────────────────

echo "==> Installing terminal-notifier..."
TN_BIN="$INSTALL_DIR/terminal-notifier.app/Contents/MacOS/terminal-notifier"

if [ -x "$TN_BIN" ]; then
  info "Already installed."
else
  mkdir -p "$(dirname "$TN_BIN")"
  if curl -fsSL -o "$TN_BIN" "$RAW_BASE/bin/terminal-notifier.app/Contents/MacOS/terminal-notifier"; then
    chmod +x "$TN_BIN"
    info "Installed."
  else
    warn "Download failed — macOS banners may not work."
  fi
fi

# ── Step 3: Agent icons ──────────────────────────────────────────

echo "==> Installing icons..."
mkdir -p "$INSTALL_DIR/images"
for icon in claude.png codex.png vscode.png claude_32.png codex_32.png robot_menu.png robot_menu_grey.png; do
  if [ ! -f "$INSTALL_DIR/images/$icon" ]; then
    curl -fsSL -o "$INSTALL_DIR/images/$icon" "$RAW_BASE/images/$icon" 2>/dev/null || true
  fi
done
info "Icons ready."

# ── Step 4: Menu bar helper ──────────────────────────────────────

echo "==> Installing menu bar helper..."

if ! command -v python3 >/dev/null 2>&1; then
  warn "python3 not found — skipping menu bar helper."
  warn "Install Python 3, then re-run this script."
else
  mkdir -p "$STATUSBAR_DIR"

  # Download statusbar script
  if ! curl -fsSL -o "$STATUSBAR_DIR/agent-statusbar.py" "$RAW_BASE/bin/statusbar/agent-statusbar.py"; then
    warn "Failed to download statusbar script."
  else
    # Create .app wrapper
    APP_DIR="$STATUSBAR_DIR/AgentStatusBar.app/Contents"
    mkdir -p "$APP_DIR/MacOS"

    cat > "$APP_DIR/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>AgentStatusBar</string>
    <key>CFBundleIdentifier</key>
    <string>com.agent-notify.statusbar</string>
    <key>CFBundleExecutable</key>
    <string>run.sh</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleVersion</key>
    <string>1.0</string>
</dict>
</plist>
PLIST

    cat > "$APP_DIR/MacOS/run.sh" << SH
#!/bin/sh
exec "$STATUSBAR_DIR/.venv/bin/python3" "$STATUSBAR_DIR/agent-statusbar.py"
SH
    chmod +x "$APP_DIR/MacOS/run.sh"

    # Python venv + dependencies
    if [ ! -d "$STATUSBAR_DIR/.venv" ]; then
      info "Creating Python venv..."
      if python3 -m venv "$STATUSBAR_DIR/.venv" && \
         "$STATUSBAR_DIR/.venv/bin/pip" install --quiet "rumps>=0.4.0" "pyobjc-framework-Quartz>=9.0"; then
        info "Dependencies installed."
      else
        warn "Failed to create venv or install dependencies."
      fi
    else
      info "Python venv already exists."
    fi

    # Launch
    if [ -x "$STATUSBAR_DIR/.venv/bin/python3" ]; then
      pkill -f "agent-statusbar.py" 2>/dev/null || true
      sleep 0.5
      open "$STATUSBAR_DIR/AgentStatusBar.app"
      info "Menu bar helper launched."

      # Add to login items
      osascript -e "
        tell application \"System Events\"
          if not (exists login item \"AgentStatusBar\") then
            make login item at end with properties {path:\"$STATUSBAR_DIR/AgentStatusBar.app\", hidden:true}
          end if
        end tell
      " 2>/dev/null && info "Added to login items." || true
    else
      warn "Python venv broken — menu bar helper not launched."
    fi
  fi
fi

# ── Done ──────────────────────────────────────────────────────────

echo ""
echo "Done! Next steps:"
echo "  1. Reload VS Code (Cmd+Shift+P → Developer: Reload Window)"
echo "  2. Run 'Agent Notify: Configure Hooks' from the command palette"
echo "  3. Enable macOS banners: System Settings → Notifications → terminal-notifier"
