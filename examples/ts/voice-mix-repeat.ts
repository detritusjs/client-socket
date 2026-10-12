// Mixes everyone talking in a voice channel together and plays the mix right back into the same channel
// Requires `@snazzah/davey` (voice e2ee) and `@discordjs/opus`
import { OpusEncoder } from '@discordjs/opus';
import {
  Constants,
  Gateway,
  Media,
  MediaMixer,
  MediaUdp,
} from 'detritus-client-socket';


const guildId = '';
const channelId = '';
// only repeat these users, leave it empty to repeat everyone
const userIds: Array<string> = [];

// discord wants 5 frames of silence whenever we stop sending audio
const SILENCE_FRAME_COUNT = 5;

const token = '';
const client = new Gateway.Socket(token, {
  compress: true,
  guildSubscriptions: false,
  presence: {
    activity: {
      name: 'everyone',
      type: Constants.GatewayActivityTypes.LISTENING,
    },
    status: Constants.GatewayPresenceStatuses.DND,
  },
});

function isSilent(frame: Buffer): boolean {
  for (let i = 0; i < frame.length; i++) {
    if (frame[i]) {
      return false;
    }
  }
  return true;
}

function setupRepeat(media: Media.Socket, transport: MediaUdp.Socket): void {
  // 48khz stereo 20ms frames, the same format discord's opus uses
  const mixer = new MediaMixer.AudioMixer({
    userIds: (userIds.length) ? userIds : undefined,
  });
  const encoder = new OpusEncoder(mixer.format.sampleRate, mixer.format.channels);
  // opus decoders keep state, so every user needs their own
  const decoders = new Map<string, OpusEncoder>();

  transport.on('packet', (packet: MediaUdp.TransportPacket) => {
    if (packet.format !== Constants.MediaCodecTypes.AUDIO || packet.userId === null || !packet.rtp) {
      return;
    }
    if (!mixer.isMixing(packet.userId)) {
      return;
    }
    let decoder = decoders.get(packet.userId);
    if (!decoder) {
      decoder = new OpusEncoder(mixer.format.sampleRate, mixer.format.channels);
      decoders.set(packet.userId, decoder);
    }
    try {
      const pcm = decoder.decode(packet.data);
      mixer.push(packet.userId, pcm, packet.rtp.header.timestamp);
    } catch(error) {
      console.error(error);
    }
  });

  media.on('packet', (packet) => {
    if (packet.op === Constants.MediaOpCodes.CLIENT_DISCONNECT) {
      decoders.delete(packet.d.user_id);
      mixer.removeSource(packet.d.user_id);
    }
  });

  let silentFrames = SILENCE_FRAME_COUNT;
  mixer.on('data', (frame: Buffer) => {
    try {
      if (isSilent(frame)) {
        if (silentFrames < SILENCE_FRAME_COUNT) {
          transport.sendAudioSilenceFrame();
          silentFrames++;
        }
        return;
      }
      silentFrames = 0;
      transport.sendAudioFrame(encoder.encode(frame), {
        incrementTimestamp: true,
        timestamp: mixer.format.samplesPerFrame,
      });
    } catch(error) {
      console.error(error);
    }
  });

  media.once('killed', () => mixer.stop());
  mixer.start();
}

client.on('ready', async () => {
  const media = await client.voiceConnect(guildId, channelId, {receive: true});
  if (!media) {
    throw new Error('Failed to join the voice channel');
  }
  media.on('warn', console.error);

  // fires again after reconnects, but the transport (and our listeners on it) gets reused
  let isSetup = false;
  media.on('transportReady', (transport: MediaUdp.Socket) => {
    media.sendSpeaking({voice: true});
    // send an audio silence frame to start receiving media
    transport.sendAudioSilenceFrame();
    if (!isSetup) {
      isSetup = true;
      transport.on('warn', console.error);
      setupRepeat(media, transport);
    }
  });
});

client.on('close', ({code, reason}: {code: number, reason: string}) => console.log('gateway close', code, reason));
client.on('warn', console.error);

client.connect('wss://gateway.discord.gg');
