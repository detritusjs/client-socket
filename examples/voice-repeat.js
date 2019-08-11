const {
  Constants,
  Gateway,
} = require('../lib');


const guildId = '';
const channelId = '';
const repeatUserId = '';

const token = '';
const client = new Gateway.Socket(token, {
  compress: true,
  guildSubscriptions: false,
  presence: {
    activity: {
      name: `user ${repeatUserId}`,
      type: Constants.GatewayActivityTypes.LISTENING,
    },
    status: Constants.GatewayPresenceStatuses.DND,
  },
});

client.on('close', ({code, reason}) => {
  console.log('gateway close', code, reason);
});

client.on('open', () => {
  console.log('opened gateway on', client.url.href);
});

client.on('ready', async () => {
  const media = await client.voiceConnect(guildId, channelId, {receive: true});
  media.on('warn', console.error);
  media.on('transportReady', (transport) => {
    media.sendSpeaking({voice: true});

    // send an audio silence frame to start receiving media
    transport.sendAudioSilenceFrame();
    transport.on('packet', (packet) => {
      if (packet.userId === repeatUserId) {
        transport.sendAudioFrame(packet.data, {
          sequence: packet.rtp.header.sequence,
          timestamp: packet.rtp.header.timestamp,
        });
      }
    });
    transport.on('warn', console.error);
  });
});

client.on('warn', console.error);

client.connect('wss://gateway.discord.gg');
