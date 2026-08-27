#!/usr/bin/env bash
# Creates the virtual audio devices used by the bridge.
# Works on PipeWire (with pipewire-pulse) and plain PulseAudio.
set -euo pipefail

SINK_NAME="${TS_SINK_NAME:-ts-bridge-out}"
SOURCE_NAME="${TS_SOURCE_NAME:-ts-bridge-in}"

echo "Creating sink '${SINK_NAME}' (TS6 client playback -> bot captures monitor)..."
pactl load-module module-null-sink \
  sink_name="${SINK_NAME}" \
  sink_properties="device.description='TS Bridge Out (TS6 playback)'" || true

echo "Creating virtual source '${SOURCE_NAME}' (bot plays Discord audio -> TS6 mic)..."
# A null-sink whose monitor is remapped as a source gives us a writable mic.
pactl load-module module-null-sink \
  sink_name="${SOURCE_NAME}-sink" \
  sink_properties="device.description='TS Bridge In (sink)'" || true
pactl load-module module-remap-source \
  source_name="${SOURCE_NAME}" \
  master="${SOURCE_NAME}-sink.monitor" \
  source_properties="device.description='TS Bridge In (TS6 microphone)'" || true

echo
echo "Done. Devices:"
pactl list short sinks | grep -E "${SINK_NAME}|${SOURCE_NAME}" || true
pactl list short sources | grep -E "${SOURCE_NAME}|${SINK_NAME}" || true
echo
echo "In the TS6 client settings set:"
echo "  Playback device : $(pactl get-default-sink >/dev/null 2>&1; true) -> choose '${SINK_NAME}'"
echo "  Capture device  : choose '${SOURCE_NAME}'"
