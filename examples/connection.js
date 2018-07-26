const DetritusSocket = require('../lib');

const token = '';
const client = new DetritusSocket.Gateway(token, {
	presence: {status: 'dnd'}
});

client.on('ready', () => {
	console.log('ready');
});

client.on('packet', (packet) => console.log('packet', packet));
client.on('close', (event) => console.log('client close', event));
client.on('warn', console.error);

client.connect('wss://gateway.discord.gg/');