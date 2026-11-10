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
- `sodium-native` or `libsodium-wrappers`: optional, see below

### encryption mode
Nothing has to be picked or installed for this. `aead_aes256_gcm_rtpsize` is used whenever the voice server offers it, `aead_xchacha20_poly1305_rtpsize` when it doesn't, and both run on Node's own crypto at about the same speed (around 30,000 packets a second on one core, someone talking is 50).

A sodium module only helps a process that handles a lot of streams at once. `aead_xchacha20_poly1305_rtpsize` through one is several times faster than either mode on Node's crypto, but it isn't picked by itself, pass `forceMode` to use it:

```js
const media = await client.voiceConnect(guildId, channelId, {forceMode: 'aead_xchacha20_poly1305_rtpsize'});
```

`MediaMixer.AudioMixer` mixes decoded voice from multiple users into one PCM stream, see [examples/js/voice-mix-repeat.js](examples/js/voice-mix-repeat.js) ([ts](examples/ts/voice-mix-repeat.ts)) for mixing a channel and playing it right back.

### receiving
The voice server can be told what to forward to us (media sink wants), so what we get can be changed while connected instead of dropping packets as they come in:

```js
const media = await client.voiceConnect(guildId, channelId, {receive: true});

media.setReceive(false);         // nothing is forwarded to us anymore, audio included
media.setReceive(true);

media.setUserWants(userId, 0);   // stop getting one user, a mute only we notice
media.setUserWants(userId, null);

media.setDefaultWants(0);        // only get the users given a value
media.setUserWants(userId, 100);
```

Values go from 0 to 100, for video anything between picks a lower quality layer. Connecting with `receive: false` asks for nothing from the start.

### events
- `flags`: a user's clips settings (`Constants.MediaFlags`), `ALLOW_VOICE_RECORDING` is them allowing their voice in recordings
- `platform`: what a user joined from (`Constants.MediaPlatforms`)
- `videoQuality`: the quality we get of a user's video changed
- `voiceBackendVersion`: the versions of the voice server we connected to
- `mediaSinkWants`: the wants the voice server sent us

`flags` and `platform` aren't sent for users that don't report them (like bots).
