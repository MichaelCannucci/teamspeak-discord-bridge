# TeamSpeak 6 ↔ Discord Audio Bridge

Bridges voice between a self-hosted **TeamSpeak 6** server and a **Discord**
voice channel. TS users hear/talk to Discord users and vice versa.

> **Why this architecture?** TeamSpeak 6 has no client SDK or voice bot API
> (the TS3 SDK is protocol-incompatible with TS6 servers). The only thing
> that speaks TS6 voice today is the official TS6 client — so the bridge runs
> a real TS6 client on the server and routes its audio through virtual audio
> devices.

```
TS6 server ◀──WebRTC──▶ TS6 client (Xvfb, on server)
                            │ playback → sink "ts-bridge-out" ──monitor──▶ pw-record ─▶ Discord bot ─▶ Discord VC
                            │ mic       ← source "ts-bridge-in" ◀──pw-play── Discord bot ◀── Discord VC
```

## Prerequisites

- Linux server (tested target: Debian/Ubuntu with PipeWire)
- Node.js ≥ 20
- TS6 client installed (`~/.local/share/TeamSpeak/Client/TeamSpeak`)
- Packages: `pipewire pipewire-pulse pulseaudio-utils xvfb x11vnc`
- A Discord bot with the **Server Members** + **Voice States** intents enabled

## Setup

### 1. Discord bot

1. Create an app at <https://discord.com/developers/applications>, add a bot,
   enable **Voice States** intent, invite it to your server.
2. `cp .env.example .env` and fill in `DISCORD_TOKEN`,
   `DISCORD_GUILD_ID`, `DISCORD_VOICE_CHANNEL_ID`.

### 2. Virtual audio devices

```bash
./scripts/setup-audio.sh
```

### 3. TS6 client (one-time, via VNC)

```bash
./scripts/run-ts-client.sh   # starts Xvfb + x11vnc + TS6 client
```

Connect with a VNC client to `server:5900`, then in the TS6 client:

1. Connect to your TS6 server (bookmark it, enable auto-connect on startup).
2. Settings → Audio: set **Playback** device to `TS Bridge Out`,
   **Capture** device to `TS Bridge In`.
3. Name the client something like `Discord Bridge`.

### 4. Run the bridge

```bash
npm install
npm run build
npm start
```

### 5. systemd (recommended)

```bash
mkdir -p ~/.config/systemd/user
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ts6-client.service
systemctl --user enable --now bridge.service
journalctl --user -u bridge -f
```

## How audio flows

| Direction | Path |
|---|---|
| TS → Discord | TS6 client plays into sink `ts-bridge-out`; bot records its `.monitor` via `pw-record`, encodes Opus, plays via `@discordjs/voice` |
| Discord → TS | Bot receives Opus per user, decodes to PCM, pipes into virtual mic `ts-bridge-in` via `pw-play` |

Audio format: s16le PCM, 48 kHz, stereo (Discord native).

## Known limitations

- All TS users appear as one Discord bot; all Discord users appear as one TS
  client. (Optional TTS speaker announcements: see `ANNOUNCE_SPEAKERS`.)
- TS6 is beta — client updates may require re-doing the audio device setup.
- No per-user volume control across the bridge.
- The TS6 client needs a GUI session (Xvfb); there is no headless mode.

## Troubleshooting

- **No audio from TS**: check `pactl list short sinks` shows `ts-bridge-out`
  and the TS6 client is actually using it (VNC in and verify).
- **No audio from Discord**: ensure the bot isn't server-muted/deafened and
  `DISCORD_VOICE_CHANNEL_ID` is correct.
- **`pw-record: command not found`**: install `pipewire-tools` or swap to
  `parec`/`pacat` in `src/audio.ts`.
