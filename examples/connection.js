const {
  Constants,
  Gateway,
} = require('../lib');

const token = '';
const client = new Gateway.Socket(token, {
  presence: {
    activity: {
      name: 'something cool',
      type: Constants.GatewayPresenceTypes.WATCHING,
    },
    status: Constants.GatewayPresenceStatuses.DND,
  },
});

client.on('ready', () => {
  console.log('ready');
});

client.on('packet', (packet) => console.log('packet', packet));
client.on('close', (event) => console.log('client close', event));
client.on('warn', console.error);

client.connect('wss://gateway.discord.gg/');
