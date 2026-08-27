/**
 * Discord side of the bridge.
 *
 * - Joins the configured voice channel.
 * - Subscribes to every speaking Discord user, decodes their Opus stream to
 *   PCM and forwards it to the TS audio link (-> TS6 client mic).
 * - Takes PCM from the TS audio link (TS users talking), encodes it to Opus
 *   and plays it into the Discord voice channel.
 */
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type VoiceBasedChannel,
  type Snowflake,
} from 'discord.js';
import { opus as prismOpus } from 'prism-media';
import { Readable, type ReadableOptions } from 'node:stream';
import type { TsAudioLink } from './audio.js';

/** A readable stream that we can push PCM frames into. */
class PcmPushable extends Readable {
  constructor(opts: ReadableOptions = {}) {
    super({ ...opts, highWaterMark: 1 << 16 });
  }
  pushPcm(buf: Buffer): void {
    if (!this.push(buf)) {
      // backpressure: drop oldest data rather than grow unbounded
      this.emit('dropped');
    }
  }
  override _read(): void {
    /* data pushed externally */
  }
}

export class DiscordBridge {
  readonly client: Client;
  private connection?: VoiceConnection;
  private player: AudioPlayer;
  private tsStream = new PcmPushable();
  private opusEncoder = new prismOpus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });

  constructor(
    private readonly token: string,
    private readonly guildId: Snowflake,
    private readonly voiceChannelId: Snowflake,
    private readonly ts: TsAudioLink,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
      ],
      partials: [Partials.Channel],
    });
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
  }

  async start(): Promise<void> {
    this.client.once(Events.ClientReady, async (c) => {
      console.log(`[discord] logged in as ${c.user.tag}`);
      try {
        await this.joinVoice();
      } catch (err) {
        console.error('[discord] failed to join voice:', err);
      }
    });

    this.client.on('error', (err) => {
      console.error('[discord] client error:', err);
    });

    this.client.on('voiceStateUpdate', (_old, newState) => {
      // Re-subscribe when someone (re)connects or starts speaking
      if (newState.guild.id === this.guildId && newState.channelId) {
        this.subscribeToSpeaker(newState.id);
      }
    });

    // TS -> Discord: encode PCM from the TS link and play it
    this.ts.on('tsAudio', (pcm: Buffer) => {
      const opus = this.opusEncoder.encoder.encode(pcm) as Buffer;
      const stream = new PcmPushable();
      stream.pushPcm(opus);
      const resource = createAudioResource(stream, {
        inputType: 'opus' as never, // raw opus frames
        inlineVolume: false,
      });
      // We must keep a single continuous resource; instead of per-frame
      // resources, route through a persistent stream (see startTsPlayback).
    });

    await this.client.login(this.token);
  }

  private async joinVoice(): Promise<void> {
    const channel = await this.client.channels.fetch(this.voiceChannelId) as VoiceBasedChannel;
    if (!channel || !channel.isVoiceBased()) {
      throw new Error(`Channel ${this.voiceChannelId} is not a voice channel`);
    }

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    this.connection.on('error', (e) => console.error('[discord] voice error:', e));

    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log('[discord] voice connection destroyed');
    });

    // If the connection drops (network blip, channel move), try to reconnect.
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000);
        // re-signalled (e.g. moved channels) — nothing to do
      } catch {
        console.warn('[discord] voice disconnected, attempting reconnect...');
        this.connection?.rejoin();
      }
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      console.error('[discord] voice failed to become Ready within 30s.');
      console.error('  -> Check that UDP ports 50000-65535 are open (ufw + cloud firewall).');
      console.error('  -> Discord voice requires outbound UDP; TCP-only firewalls will fail here.');
      throw err;
    }
    console.log('[discord] voice connection ready');

    this.connection.subscribe(this.player);
    this.startTsPlayback();
    this.subscribeAllSpeakers(channel);
  }

  /** Persistent TS->Discord audio: encode the pushable PCM stream to Opus. */
  private startTsPlayback(): void {
    const opusStream = this.tsStream.pipe(this.opusEncoder);
    const resource = createAudioResource(opusStream, {
      inputType: 'arbitrary' as never,
      inlineVolume: false,
    });
    this.player.play(resource);
  }

  /** Subscribe to a Discord user's audio and pipe decoded PCM to TS. */
  private subscribeToSpeaker(userId: Snowflake): void {
    if (!this.connection) return;
    const receiver = this.connection.receiver;
    if (receiver.subscriptions.has(userId)) return; // already subscribed

    const audio = receiver.subscribe(userId, {
      autoDestroy: true,
    });

    const opusDecoder = new prismOpus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    audio.pipe(opusDecoder);

    opusDecoder.on('data', (pcm: Buffer) => {
      this.ts.writeFromDiscord(pcm);
    });
    opusDecoder.on('error', (e: Error) =>
      console.error(`[discord] decode error for ${userId}:`, e.message));
  }

  private subscribeAllSpeakers(channel: VoiceBasedChannel): void {
    for (const [memberId] of channel.members) {
      if (memberId === this.client.user?.id) continue;
      this.subscribeToSpeaker(memberId);
    }
  }

  /** Called by the bot wiring to feed TS PCM into the Discord player. */
  feedTsAudio(pcm: Buffer): void {
    this.tsStream.pushPcm(pcm);
  }

  async stop(): Promise<void> {
    this.ts.stop();
    this.player.stop(true);
    this.connection?.destroy();
    await this.client.destroy();
  }
}
