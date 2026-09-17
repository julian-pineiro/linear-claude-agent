#!/bin/bash
# Installs the relay and its ngrok tunnel as macOS login services (launchd user agents).
set -euo pipefail

CONFIG_DIR="${LINEAR_CLAUDE_HOME:-$HOME/.linear-claude}"
AGENTS="$HOME/Library/LaunchAgents"
NODE="$(command -v node)"
NGROK="$(command -v ngrok)"
PORT="$(grep -E '^PORT=' "$CONFIG_DIR/.env" | cut -d= -f2- || true)"
PORT="${PORT:-3456}"
DOMAIN="$(grep -E '^NGROK_DOMAIN=' "$CONFIG_DIR/.env" | cut -d= -f2- || true)"

[ -n "$NODE" ] || { echo "node not found"; exit 1; }
[ -f "$CONFIG_DIR/.env" ] || { echo "No $CONFIG_DIR/.env — copy .env.example first"; exit 1; }

# launchd starts with a minimal PATH; the session needs claude, git, gh and tmux on it.
PATH_VALUE="$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

write_agent() {  # label, program, args..., logfile
  local label="$1" logfile="$2"; shift 2
  local args=""
  for arg in "$@"; do args+="    <string>$arg</string>"$'\n'; done

  cat > "$AGENTS/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$CONFIG_DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH_VALUE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$logfile</string>
  <key>StandardErrorPath</key><string>$logfile</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  echo "started $label"
}

mkdir -p "$AGENTS"
write_agent com.linear-claude.relay "$CONFIG_DIR/service.log" "$NODE" "$CONFIG_DIR/relay.mjs"

if [ -n "$DOMAIN" ] && [ -n "$NGROK" ]; then
  write_agent com.linear-claude.ngrok "$CONFIG_DIR/ngrok.log" \
    "$NGROK" http "--url=$DOMAIN" "$PORT" --log=stdout
else
  echo "No NGROK_DOMAIN in .env (or ngrok not installed) — skipping the tunnel service."
  echo "Expose port $PORT yourself, or set NGROK_DOMAIN and re-run this script."
fi

sleep 3
launchctl list | grep linear-claude || echo "Nothing running — check $CONFIG_DIR/service.log"
