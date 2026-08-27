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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface AudioOptions {
  sinkName: string;      // e.g. "ts-bridge-out"
  sourceName: string;    // e.g. "ts-bridge-in"
  sampleRate: number;    // 48000
  channels: number;      // 2
}

const FRAME_BYTES = 3840; // 20ms of s16le 48kHz stereo (960 samples * 2ch * 2B)

export class TsAudioLink extends EventEmitter {
  private recorder?: ChildProcessWithoutNullStreams;
  private player?: ChildProcessWithoutNullStreams;
  private readonly opts: AudioOptions;
  private buffer = Buffer.alloc(0);

  constructor(opts: AudioOptions) {
    super();
    this.opts = opts;
  }

  /** Start capturing the TS6 client's playback (what TS users say). */
  startCapture(): void {
    const monitor = `${this.opts.sinkName}.monitor`;
    // pw-record / parec both accept the same args via pipewire-pulse
    this.recorder = spawn('pw-record', [
      '--rate', String(this.opts.sampleRate),
      '--channels', String(this.opts.channels),
      '--format', 's16',
      `--target`, monitor,
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.recorder.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= FRAME_BYTES) {
        const frame = this.buffer.subarray(0, FRAME_BYTES);
        this.buffer = this.buffer.subarray(FRAME_BYTES);
        this.emit('tsAudio', frame);
      }
    });

    this.recorder.on('error', (err) =>
      this.emit('error', new Error(`pw-record failed: ${err.message}`)));
    this.recorder.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.emit('log', `[pw-record] ${s}`);
    });
  }

  /** Start the playback pipe into the TS6 client's virtual microphone. */
  startPlayback(): void {
    this.player = spawn('pw-play', [
      '--rate', String(this.opts.sampleRate),
      '--channels', String(this.opts.channels),
      '--format', 's16',
      `--target`, this.opts.sourceName,
      '-',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    this.player.on('error', (err) =>
      this.emit('error', new Error(`pw-play failed: ${err.message}`)));
    this.player.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.emit('log', `[pw-play] ${s}`);
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
