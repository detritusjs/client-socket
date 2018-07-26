const DetritusSocket = require('detritus-websocket');

const token = '';
const client = new DetritusSocket.Gateway(token, {
	presence: {status: 'dnd'}
});

const guildId = '';
const channelId = '';

client.on('ready', () => {
	console.log('ready');

	client.voiceConnect(guildId, channelId, {mute: true}).then((vGateway) => {
		vGateway.on('ready', () => {
			console.log('voice ready');
		});

		vGateway.on('close', (event) => console.log('voice close', event));
		vGateway.on('warn', console.error);

		vGateway.on('udpReady', ({udp}) => {

			udp.on('ready', () => console.log('udp ready'));

			udp.on('packet', (packet) => console.log('udp packet', packet));
			udp.on('close', () => console.log('udp close'));
			udp.on('warn', console.error);
		});
	});
});

client.on('packet', (packet) => console.log('packet', packet));
client.on('close', (event) => console.log('client close', event));
client.on('warn', console.error);

client.connect('wss://gateway.discord.gg/');