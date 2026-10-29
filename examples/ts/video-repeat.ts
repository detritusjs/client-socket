// Repeats a user's camera back into the channel
// Requires `@snazzah/davey` (voice/video e2ee)
// Discord forces `self_video` off for bot accounts, so the official client never shows a tile for it, but the video
// still gets delivered and decoded (check the bot under Inbound in the client's RTC debug panel)
import { Constants, Gateway, MediaUdp } from 'detritus-client-socket';


const guildId = process.env.GUILD_ID || '';
const channelId = process.env.CHANNEL_ID || '';
const repeatUserId = process.env.REPEAT_USER_ID || '';

const token = process.env.DISCORD_TOKEN || '';

const client = new Gateway.Socket(token, {
  compress: true,
  guildSubscriptions: false,
  presence: {
    activity: {
      name: `user ${repeatUserId}`,
      type: Constants.GatewayActivityTypes.WATCHING,
    },
    status: Constants.GatewayPresenceStatuses.DND,
  },
});

client.on('close', ({code, reason}: {code: number, reason: string}) => {
  console.log('gateway close', code, reason);
});

client.on('open', () => {
  console.log('opened gateway on', client.url!.href);
});

client.on('ready', async () => {
  const media = await client.voiceConnect(guildId, channelId, {receive: true, video: true, selfVideo: true});
  if (!media) {
    throw new Error('Failed to join the voice channel');
  }
  media.on('warn', console.error);

  let isSetup = false;
  media.on('transportReady', (transport: MediaUdp.Socket) => {
    media.sendSpeaking({voice: true});
    // send an audio silence frame to start receiving media
    transport.sendAudioSilenceFrame();
    // tell everyone our video stream is live
    media.sendClientConnect({videoActive: true});
    if (isSetup) {
      return;
    }
    isSetup = true;

    let sourceSSRC: number | null = null;
    let needKeyframe = true;
    let requestedCodec: string | null = null;

    transport.on('videoCodec', (codec: Constants.MediaCodecs) => {
      console.log(`voice server has us sending ${codec} now`);
      needKeyframe = true;
      if (sourceSSRC !== null) {
        transport.requestKeyframe(sourceSSRC, true);
      }
    });

    transport.on('frame', (frame: MediaUdp.TransportFrame) => {
      if (frame.userId !== repeatUserId) {
        return;
      }
      sourceSSRC = frame.ssrc;

      // the voice server tells us which codec to send (viewers might not decode anything else) and we can't transcode,
      // so ask it for the user's codec and hold off until it agrees
      if (transport.codecs.video && frame.codec !== transport.codecs.video) {
        if (requestedCodec !== frame.codec) {
          console.log(`user sends ${frame.codec} but we're set to send ${transport.codecs.video}, asking for ${frame.codec}`);
          requestedCodec = frame.codec;
          transport.setPreferredVideoCodec(frame.codec);
        }
        needKeyframe = true;
        return;
      }

      if (needKeyframe) {
        // a viewer can only start decoding from a keyframe
        if (!frame.keyframe) {
          transport.requestKeyframe(frame.ssrc);
          return;
        }
        needKeyframe = false;
      }

      // e2e encrypts it with our key (it came in decrypted with the user's), splits it into packets and sends them,
      // keeping the user's own 90kHz timestamps. false means it got dropped (we're not in the DAVE group yet)
      const sent = transport.sendVideo(frame.data, {codec: frame.codec, keyframe: frame.keyframe, timestamp: frame.timestamp});
      if (!sent) {
        needKeyframe = true;
      }
    });

    // a viewer lost something it couldn't get retransmitted (or just started watching), only the user can make a keyframe
    transport.on('keyframeRequest', () => {
      if (sourceSSRC !== null) {
        transport.requestKeyframe(sourceSSRC);
      }
    });
    transport.on('warn', console.error);
  });
});

client.on('warn', console.error);

client.connect('wss://gateway.discord.gg');
