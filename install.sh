#!/bin/sh
# Agent Notification — one-command installer
# Usage: curl -fsSL https://raw.githubusercontent.com/zhouyou-gu/vscode-agent-notification/main/install.sh | sh
set -e

REPO="zhouyou-gu/vscode-agent-notification"
VSIX="agent-notification.vsix"
TMP_DIR=$(mktemp -d)

# Find the VS Code CLI
if command -v code >/dev/null 2>&1; then
  CODE="code"
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
else
  echo "Error: VS Code 'code' CLI not found. Install VS Code or add 'code' to PATH."
  echo "  In VS Code: Cmd+Shift+P → 'Shell Command: Install code command in PATH'"
  exit 1
fi

echo "Fetching latest release..."
DOWNLOAD_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep "browser_download_url.*\.vsix" \
  | head -1 \
  | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: No .vsix found in latest release."
  exit 1
fi

echo "Downloading $DOWNLOAD_URL"
curl -fsSL -o "$TMP_DIR/$VSIX" "$DOWNLOAD_URL"

echo "Installing extension..."
"$CODE" --install-extension "$TMP_DIR/$VSIX" --force

rm -rf "$TMP_DIR"

echo ""
echo "Done! Reload VS Code to activate Agent Notification."
echo "On first run, enable macOS banners: System Settings > Notifications > terminal-notifier"
