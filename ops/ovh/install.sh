#!/usr/bin/env bash
# Installs the OVH user timers that start RentCars collections on time.
# Run as the server user that is logged in to gh (needs the workflow scope).
# Requires user lingering (loginctl enable-linger) so timers run without a login.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
unit_dir="$HOME/.config/systemd/user"

gh auth status >/dev/null
mkdir -p "$HOME/.local/bin" "$unit_dir"
install -m 755 "$here/rentcars-trigger.sh" "$HOME/.local/bin/rentcars-trigger"
install -m 644 "$here/rentcars-trigger@.service" "$here/rentcars-trigger-night.timer" \
  "$here/rentcars-trigger-daytime.timer" "$unit_dir/"
systemctl --user daemon-reload
systemctl --user enable --now rentcars-trigger-night.timer rentcars-trigger-daytime.timer
systemctl --user list-timers 'rentcars-trigger-*' --no-pager
