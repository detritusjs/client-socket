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
