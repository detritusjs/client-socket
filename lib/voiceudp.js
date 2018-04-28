const dgram = require('dgram');

const Utils = require('./utils');
const Constants = Utils.Constants;
const OpCodes = Constants.OpCodes.Voice;

const Packet = Constants.Voice.PACKET;
const RTCP = Packet.RTCP;

const Voice = Utils.Voice;


class VoiceUDP extends Utils.EventEmitter
{
	constructor(voiceGateway)
	{
		super();

		this.voiceGateway = voiceGateway;

		this.remote = {
			ip: null,
			port: null
		};

		this.local = {
			ip: null,
			port: null
		};

		this.ssrc = null;
		this.mode = null;

		this.socket = null;

		this.crypto = new Voice.PacketCrypto(); //allow pass in for module use
		this.header = new Voice.PacketRTPHeader(Packet.HEADER.TYPE, Packet.HEADER.VERSION);

		this.connection = false;

		this.listening = false;
	}

	get connected()
	{
		return this.connection;
	}

	setSSRC(ssrc)
	{
		this.ssrc = ssrc;
		this.header.setSSRC(this.ssrc);
	}

	setMode(mode)
	{
		if (!Constants.Voice.MODES.includes(mode)) {throw new Error(`Encryption mode '${mode}' is not supported.`);}
		this.mode = mode;
	}

	connect(ip, port)
	{
		this.remote.ip = ip || this.remote.ip;
		this.remote.port = port || this.remote.port;

		if (this.connected) {this.disconnect();}

		this.socket = dgram.createSocket('udp4');

		this.socket.once('message', (packet) => {
			if (this.ssrc !== packet.readUInt32LE(0)) {
				throw new Error('SSRC mismatch in ip discovery packet');
			}

			this.local.ip = packet.slice(4, packet.indexOf(0, 4)).toString();
			this.local.port = packet.readUIntLE(packet.length - 2, 2);

			console.log('ip identify', this.ssrc, this.mode, this.local, this.remote);

			this.voiceGateway.send(OpCodes.SELECT_PROTOCOL, {
				'protocol': 'udp',
				'data': {
					'address': this.local.ip,
					'port': this.local.port,
					'mode': 'xsalsa20_poly1305' || this.mode
				}
			});
			this.socket.on('message', this.onPacket.bind(this));
		});
		this.socket.on('error', this.onError.bind(this));
		this.socket.on('close', this.onClose.bind(this));

		this.connection = true;

		const ipDiscovery = Buffer.alloc(70);
		ipDiscovery.writeUIntBE(this.ssrc, 0, 4);
		this.send(ipDiscovery);
	}

	disconnect()
	{
		if (this.socket) {
			this.socket.close();
			this.socket = null;
		}

		//reset the packets

		this.connection = false;
	}

	onPacket(packet, rinfo)
	{
		//check if any decoders exist, if not return
		const rtp = new Voice.PacketRTP(packet, this.mode);

		let data = this.crypto.decrypt(rtp.data, rtp.nonce);
		if (!data) {
			const error = new Error('Packet failed to decrypt');
			error.packet = rtp;
			return this.emit('error', error);
		}

		if (Packet.RTP.HEADERS.ONE_BYTE.every((header, i) => header === data[i])) {
			let rtpHeaderLen = data[2] << 8 | data[3];

			let offset = 4;
			for (let i = 0; i < rtpHeaderLen; i++) {
				const byte = data[offset];
				offset += (byte & Packet.RTP.LOCAL_IDENTIFER) + 2;
				while (data[offset] === 0) {
					offset++; //basically skip the end padding if we reached the end
				}
			}

			data = data.slice(offset);
		}

		this.emit('packet', {data, rtp, userId: this.voiceGateway.ssrcs.audio.get(rtp.ssrc)});

		//console.log(data, data.length, rtp.buffer.length);
		//decode the packet.data now
	}

	onError(error, message)
	{
		console.log('socket error', error, message);
	}

	onClose()
	{
		console.log('socket closed', this.local, this.remote);

		this.connection = false;
	}

	send(packet)
	{
		if (!this.connected || !this.socket) {throw new Error('UDP not connected yet!');}
		this.socket.send(packet, 0, packet.length, this.remote.port, this.remote.ip, (error, bytes) => {
			if (error) {this.emit('error', error);}
			//console.log('sent packet', error, bytes);
		});
	}

	sendEncode(packet, sequence, timestamp)
	{
		this.send(this.encode(packet, sequence, timestamp));
	}

	encode(packet, sequence, timestamp)
	{
		this.header.setSequence(sequence);
		this.header.setTimestamp(timestamp || 960, true); //maybe use framesize

		let raw;
		switch (this.mode) {
			case 'xsalsa20_poly1305_lite': {
				this.header.setNonce();
				raw = [this.crypto.encrypt(packet, this.header.nonce.buffer), this.header.nonce.buffer.slice(0, 4)];
			}; break;
			case 'xsalsa20_poly1305_suffix': {
				const nonce = this.crypto.generateNonce();
				raw = [this.crypto.encrypt(packet, nonce), nonce];
			}; break;
			case 'xsalsa20_poly1305': {
				raw = this.crypto.encrypt(packet, this.header.buffer);
			}; break;
			default: {
				throw new Error(`${this.mode} is not supported for encoding.`);
			};
		}

		if (Array.isArray(raw)) {
			raw = Buffer.concat([this.header.buffer.slice(0, 12)].concat(raw));
		} else {
			raw = Buffer.concat([this.header.buffer.slice(0, 12), raw]);
		}
		return raw;
	}
}

module.exports = VoiceUDP;