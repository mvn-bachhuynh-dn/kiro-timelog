#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== kiro-timelog installer ==="

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "✗ Node.js not found. Install Node.js >= 18 first:"
  echo "  macOS: brew install node"
  echo "  Ubuntu: sudo apt install nodejs"
  exit 1
fi

NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
  echo "✗ Node.js >= 18 required (found v$NODE_VER)"
  exit 1
fi

echo "✓ Node.js $(node --version)"

# Check if Kiro sessions exist
SESSIONS_DIR="${KIRO_SESSIONS_DIR:-$HOME/.kiro/sessions/cli}"
if [ ! -d "$SESSIONS_DIR" ]; then
  echo "⚠ Kiro sessions directory not found: $SESSIONS_DIR"
  echo "  (This is OK if you haven't used Kiro CLI yet)"
fi

# Create timelog directory
mkdir -p ~/.kiro/timelog
echo "✓ Created ~/.kiro/timelog/"

# Create default config if not exists
if [ ! -f ~/.kiro/timelog/config.json ]; then
  cat > ~/.kiro/timelog/config.json << 'EOF'
{
  "ticketPatterns": ["([A-Z][A-Z0-9]+-\\d+)"],
  "projectSource": "git-root",
  "projectPattern": null,
  "breakThreshold": 1800
}
EOF
  echo "✓ Created default config.json"
  echo "  Tip: set projectPattern to extract project names from paths"
  echo "  Example: \"projectPattern\": \"$HOME/projects/([^/]+)\""
fi

# Make executable
chmod +x "$DIR/bin/kirolog"
echo "✓ Made kirolog executable"

# Install scheduler (launchd on macOS, cron on Linux)
node "$DIR/scripts/scheduler.mjs" install

# Symlink to PATH
LINK_TARGET=""
if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  LINK_TARGET="/usr/local/bin/kirolog"
elif [ -d "$HOME/.local/bin" ]; then
  LINK_TARGET="$HOME/.local/bin/kirolog"
elif [ -d "$HOME/bin" ]; then
  LINK_TARGET="$HOME/bin/kirolog"
fi

if [ -n "$LINK_TARGET" ]; then
  ln -sf "$DIR/bin/kirolog" "$LINK_TARGET"
  echo "✓ Linked kirolog → $LINK_TARGET"
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$DIR/bin/kirolog" "$HOME/.local/bin/kirolog"
  echo "✓ Linked kirolog → ~/.local/bin/kirolog"
  echo "  Add to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# Initial scan
echo ""
node "$DIR/scripts/scan.mjs"
echo ""
echo "=== Done! ==="
echo "Run: kirolog              # this week's report"
echo "     kirolog --month      # this month"
echo "     kirolog --timesheet  # project × ticket summary"
