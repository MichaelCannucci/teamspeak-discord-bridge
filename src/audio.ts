/**
 * PulseAudio/PipeWire audio plumbing.
 *
 * Layout:
 *   - TS6 client playback device  -> sink "ts-bridge-out"
 *       The bot records from that sink's monitor source (ts-bridge-out.monitor)
 *       and sends the audio to Discord.
 *   - TS6 client microphone device -> virtual source "ts-bridge-in"
 *       The bot plays Discord audio into this source via `parec`-style playback
 *       (we use `pacat` / `pw-cat` spawned as child processes).
 *
 * We shell out to pactl/pacat/pw-cat because they are always present on a
 * PipeWire system (pipewire-pulse compatibility layer) and handle the
 * PulseAudio native protocol for us. Raw PCM (s16le, 48kHz, stereo) is piped
 * over stdin/stdout of those processes.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

/** Recorder: stdout/stderr piped, stdin ignored. */
type Recorder = ChildProcessByStdio<null, Readable, Readable>;
/** Player: stdin piped, stdout ignored, stderr piped. */
type Player = ChildProcessByStdio<Writable, null, Readable>;
import type { Writable } from 'node:stream';

export interface AudioOptions {
  sinkName: string;      // e.g. "ts-bridge-out"
  sourceName: string;    // e.g. "ts-bridge-in"
  sampleRate: number;    // 48000
  channels: number;      // 2
}

const FRAME_BYTES = 3840; // 20ms of s16le 48kHz stereo (960 samples * 2ch * 2B)

export class TsAudioLink extends EventEmitter {
  private recorder?: Recorder;
  private player?: Player;
  private readonly opts: AudioOptions;
  private buffer = Buffer.alloc(0);

  constructor(opts: AudioOptions) {
    super();
    this.opts = opts;
  }

  /** Start capturing the TS6 client's playback (what TS users say).
   *
   * Uses `parec` (PulseAudio protocol) with an explicit monitor source name —
   * unlike pw-record's --target, parec's device argument reliably binds to the
   * exact requested source and never silently falls back to another one. */
  startCapture(): void {
    const monitor = `${this.opts.sinkName}.monitor`;
    const recorder = spawn('parec', [
      '-d', monitor,
      '--rate', String(this.opts.sampleRate),
      '--channels', String(this.opts.channels),
      '--format', 's16',
      '--raw',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] }) as Recorder;
    this.recorder = recorder;

    recorder.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= FRAME_BYTES) {
        const frame = this.buffer.subarray(0, FRAME_BYTES);
        this.buffer = this.buffer.subarray(FRAME_BYTES);
        this.emit('tsAudio', frame);
      }
    });

    recorder.on('error', (err) =>
      this.emit('error', new Error(`pw-record failed: ${err.message}`)));
    recorder.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.emit('log', `[parec] ${s}`);
    });
  }

  /** Start the playback pipe into the TS6 client's virtual microphone.
   *
   * We play into the null-sink `ts-bridge-in-sink`; setup-audio.sh creates a
   * remap-source (`ts-bridge-in`) backed by that sink's monitor, which is what
   * the TS6 client uses as its microphone. pw-play cannot write into a source
   * directly — it must target the sink. */
  startPlayback(): void {
    this.spawnPlayer();
  }

  /** Spawn (or re-spawn) the pacat process feeding the TS mic sink. */
  private spawnPlayer(): void {
    const player = spawn('pacat', [
      '--playback',
      '-d', `${this.opts.sourceName}-sink`,
      '--rate', String(this.opts.sampleRate),
      '--channels', String(this.opts.channels),
      '--format', 's16',
      '--raw',
      '-',
    ], { stdio: ['pipe', 'ignore', 'pipe'] }) as Player;
    this.player = player;

    player.on('error', (err) =>
      this.emit('error', new Error(`pacat failed: ${err.message}`)));

    player.on('exit', (code) => {
      // pacat exits on stdin EOF; respawn so future Discord audio still plays.
      this.emit('log', `[pacat] exited (code ${code}), respawning`);
      this.player = undefined;
      setTimeout(() => {
        if (!this.player) this.spawnPlayer();
      }, 500);
    });

    player.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.emit('log', `[pacat] ${s}`);
    });
  }

  /** Feed Discord audio (PCM s16le 48kHz stereo) into the TS mic. */
  writeFromDiscord(pcm: Buffer): void {
    if (this.player && this.player.stdin.writable) {
      this.player.stdin.write(pcm);
    }
  }

  stop(): void {
    this.recorder?.kill('SIGTERM');
    this.player?.kill('SIGTERM');
    this.recorder = undefined;
    this.player = undefined;
  }
}
