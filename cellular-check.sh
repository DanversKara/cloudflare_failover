#!/bin/bash
# cellular-check.sh — runs every minute from cron on a host at home.
# Compares the home's current public egress IP against the known primary
# WAN IP. If they differ, the home has failed over to its backup link.
# Writes a tiny JSON file served by cellular-status.service on :8899, which
# the failover-notice Worker reads to decide whether to show the degraded
# banner.
#
# IMPORTANT: set WAN_IP below to your primary link's public IP (find the
# current one on your router's WAN status page). If your ISP ever changes
# it, update this one line. A stale WAN_IP shows the degraded banner
# permanently — one-line fix.

WAN_IP="YOUR_PRIMARY_WAN_IP"
OUT_DIR="/opt/cellular-status"
OUT_FILE="$OUT_DIR/status.json"

IP="$(curl -s --max-time 10 https://api.ipify.org)"

if [ -z "$IP" ]; then
  # Could not determine egress IP (transient failure): keep the previous value.
  exit 0
fi

if [ "$IP" = "$WAN_IP" ]; then
  DEGRADED="false"
else
  DEGRADED="true"
fi

mkdir -p "$OUT_DIR"
printf '{"degraded": %s, "checked": "%s"}\n' "$DEGRADED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT_FILE.tmp"
mv "$OUT_FILE.tmp" "$OUT_FILE"
