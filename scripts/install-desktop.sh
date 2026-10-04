#!/usr/bin/env bash
# Add You Research Console to the app menu (and `you-research` to ~/.local/bin).
# Run again after moving the app folder. Pass --uninstall to remove both.
set -euo pipefail

APP_ID="you-research-console"
APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ENTRY="$APPS/$APP_ID.desktop"
LINK="$HOME/.local/bin/you-research"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$ENTRY"
  [ -L "$LINK" ] && rm -f "$LINK"
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS" || true
  echo "Removed the app menu entry and $LINK."
  exit 0
fi

mkdir -p "$APPS" "$(dirname "$LINK")"
cat >"$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Name=You Research Console
GenericName=Research Console
Comment=Deep research, page contents and quick answers from You.com
Exec="$APP_DIR/bin/you-research"
Icon=$APP_DIR/public/icon.svg
Terminal=false
Categories=Network;Utility;
Keywords=you.com;research;search;answers;
StartupWMClass=$APP_ID
StartupNotify=true
DESKTOP
ln -sfn "$APP_DIR/bin/you-research" "$LINK"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS" || true
echo "Installed: 'You Research Console' is in the app menu; 'you-research' runs it from a terminal."
