import 'dotenv/config';
import { TsAudioLink } from './audio.js';
import { DiscordBridge } from './discord.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  // Don't let stray async errors (e.g. voice connection timeouts) kill the process
  process.on('unhandledRejection', (err) => {
    console.error('[bridge] unhandled rejection:', err);
  });

  const token = requireEnv('DISCORD_TOKEN');
  const guildId = requireEnv('DISCORD_GUILD_ID');
  const voiceChannelId = requireEnv('DISCORD_VOICE_CHANNEL_ID');

  const sinkName = process.env.TS_SINK_NAME ?? 'ts-bridge-out';
  const sourceName = process.env.TS_SOURCE_NAME ?? 'ts-bridge-in';
  const sampleRate = Number(process.env.SAMPLE_RATE ?? 48000);
  const channels = Number(process.env.CHANNELS ?? 2);

  // --- TS side: virtual audio devices ---
  const ts = new TsAudioLink({ sinkName, sourceName, sampleRate, channels });
  ts.on('log', (m) => console.log(m));
  ts.on('error', (e) => console.error('[audio]', e.message));

  ts.startCapture();   // TS users speaking -> 'tsAudio' events
  ts.startPlayback();  // Discord audio -> TS mic

  // --- Discord side ---
  const bridge = new DiscordBridge(token, guildId, voiceChannelId, ts);

  // Route TS audio into the Discord player's persistent stream
  ts.on('tsAudio', (pcm: Buffer) => bridge.feedTsAudio(pcm));

  await bridge.start();

  const shutdown = async (sig: string) => {
    console.log(`\n[bridge] received ${sig}, shutting down`);
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bridge] fatal:', err);
  process.exit(1);
});
