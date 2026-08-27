#!/usr/bin/env bash
# Launches the TS6 client under a virtual X display so it can run on a
# headless server. First run: use VNC to interact with the GUI once
# (connect the client to your server, set audio devices, enable auto-connect).
set -euo pipefail

DISPLAY_NUM="${TS_DISPLAY:-:99}"
SCREEN_GEOMETRY="${TS_SCREEN:-1920x1080x24}"

# Start virtual display if not running
if ! xdpyinfo -display "${DISPLAY_NUM}" >/dev/null 2>&1; then
  echo "Starting Xvfb on ${DISPLAY_NUM} (${SCREEN_GEOMETRY})"
  Xvfb "${DISPLAY_NUM}" -screen 0 "${SCREEN_GEOMETRY}" -nolisten tcp &
  sleep 1
fi

# Optional: x11vnc so you can control the client remotely for initial setup
if [[ "${TS_VNC:-1}" == "1" ]] && ! pgrep -x x11vnc >/dev/null; then
  echo "Starting x11vnc on port ${TS_VNC_PORT:-5900}"
  x11vnc -display "${DISPLAY_NUM}" -rfbport "${TS_VNC_PORT:-5900}" \
    -nopw -shared -forever -bg -quiet || true
fi

export DISPLAY="${DISPLAY_NUM}"

# PipeWire/PulseAudio per-user session must be reachable from here.
# If the bridge runs as a systemd user service, this is already the case.
TS_CLIENT_BIN="${TS_CLIENT_BIN:-$HOME/.local/share/TeamSpeak/Client/TeamSpeak}"

echo "Launching TS6 client on ${DISPLAY_NUM}..."
exec "${TS_CLIENT_BIN}"
