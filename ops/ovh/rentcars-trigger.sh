#!/usr/bin/env bash
# Starts a planned RentCars collection on GitHub at the exact time.
# Usage: rentcars-trigger night|daytime  (systemd timers on the OVH server call it).
# GitHub's own schedule stays as a delayed fallback; the workflow gate skips
# whichever start of the same slot comes second, so retries here are safe.
set -euo pipefail

slot="${1:-}"
case "$slot" in
  night|daytime) ;;
  *) echo "Usage: rentcars-trigger night|daytime" >&2; exit 2 ;;
esac

repo="prejsik/MMSL-Scrapper-Rentcars"
for attempt in 1 2 3; do
  if gh workflow run rentcars-daily.yml --repo "$repo" --ref main -f scheduled_slot="$slot"; then
    echo "Started RentCars $slot slot (attempt $attempt)."
    exit 0
  fi
  echo "Start of RentCars $slot slot failed (attempt $attempt)." >&2
  [[ "$attempt" -lt 3 ]] && sleep 60
done
echo "Giving up; the delayed GitHub schedule will start the $slot slot." >&2
exit 1
