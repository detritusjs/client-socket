# Detritus Client Socket
![npm](https://img.shields.io/npm/v/detritus-client-socket?style=flat-square)

A pure-TypeScript low-level wrapper for just Discord's Gateway and Voice Connection.

- [API Documentation](https://socket.detritusjs.com)
- [npm](https://www.npmjs.com/package/detritus-client-socket)

## usage
```js
const { Gateway } = require('detritus-client-socket');

const token = '';
const client = new Gateway.Socket(token, {
  presence: {
    status: 'dnd',
  },
});

client.on('ready', () => {
  console.log('ready');
});

client.on('packet', (packet) => console.log('packet', packet));
client.on('close', (event) => console.log('client close', event));
client.on('warn', console.error);

client.connect('wss://gateway.discord.gg/');
```

## voice
Voice uses gateway v8 with the `aead_aes256_gcm_rtpsize` encryption mode (built into Node). Since March 1st, 2026, Discord requires end-to-end encryption (DAVE) for voice, so install:

- `@snazzah/davey`: **required** to join voice channels (DAVE / E2EE)
- `sodium-native` or `libsodium-wrappers`: optional, enables the `aead_xchacha20_poly1305_rtpsize` fallback mode

`MediaMixer.AudioMixer` mixes decoded voice from multiple users into one PCM stream, see [examples/js/voice-mix-repeat.js](examples/js/voice-mix-repeat.js) ([ts](examples/ts/voice-mix-repeat.ts)) for mixing a channel and playing it right back.
