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
		this.cache = Buffer.alloc(1024 * 4);

		this.connected = false;

		this.listening = false;
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

			this.voiceGateway.send(OpCodes.SELECT_PROTOCOL, {
				'protocol': 'udp',
				'data': {
					'address': this.local.ip,
					'port': this.local.port,
					'mode': this.mode
				}
			});
			this.socket.on('message', this.onPacket.bind(this));
		});
		this.socket.on('error', this.onError.bind(this));
		this.socket.on('close', this.onClose.bind(this));

		this.connected = true;

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

		this.cache.fill(0);
		this.header.setup();
		//reset the packets

		this.connected = false;
	}

	onPacket(packet, rinfo)
	{
		if (rinfo.address !== this.remote.ip || rinfo.port !== this.remote.port) {
			const error = new Error('Received a packet from an unknown IP/Port');
			error.rinfo = rinfo;
			return this.emit('error', error);
		}
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
	}

	onError(error, message)
	{
		this.emit('error', error, message);
	}

	onClose()
	{
		this.connected = false;
		this.emit('close');
	}

	send(packet)
	{
		if (!this.connected || !this.socket) {throw new Error('UDP not connected yet!');}
		this.socket.send(packet, 0, packet.length, this.remote.port, this.remote.ip, (error, bytes) => {
			if (error) {this.emit('error', error);}
		});
	}

	//uses the cache, send this quick lol
	sendFrame(packet, sequence, timestamp, options)
	{
		options = options || {};
		this.header.setSequence(sequence, options.incrementSequence);
		this.header.setTimestamp(timestamp, options.incrementTimestamp); //maybe use framesize

		const cache = this.cache.slice(12);

		let raw;
		switch (this.mode) {
			case 'xsalsa20_poly1305_lite': {
				this.header.setNonce();
				raw = [this.crypto.encrypt(packet, this.header.nonce.buffer, cache), this.header.nonce.buffer.slice(0, 4)];
			}; break;
			case 'xsalsa20_poly1305_suffix': {
				const nonce = this.crypto.generateNonce(this.header.nonce.buffer);
				raw = [this.crypto.encrypt(packet, nonce, cache), nonce];
			}; break;
			case 'xsalsa20_poly1305': {
				raw = [this.crypto.encrypt(packet, this.header.buffer, cache)];
			}; break;
			default: {
				throw new Error(`${this.mode} is not supported for encoding.`);
			};
		}

		let total = 12;
		this.header.buffer.copy(this.cache, 0, 0, total);
		raw.forEach((buffer) => {
			const start = total;
			total += buffer.length;
			if (buffer.packet) {return;} //do nothing since its already overwritten in the cache
			buffer.copy(this.cache, 0, start, total);
		});

		this.send(this.cache.slice(0, total));
	}
}

module.exports = VoiceUDP;