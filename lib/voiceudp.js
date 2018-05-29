const dgram = require('dgram');

const Utils = require('./utils');
const Constants = Utils.Constants;

const Codecs = Constants.Voice.Codecs;
const Packet = Constants.Voice.Packet;

const Voice = Utils.Voice;

class VoiceUDP extends Utils.EventEmitter
{
	constructor(voiceGateway)
	{
		super();

		this.remote = {
			ip: null,
			port: null
		};

		this.local = {
			ip: null,
			port: null
		};

		Object.defineProperties(this, {
			voiceGateway: {value: voiceGateway},
			key: {configurable: true, value: null},
			mode: {enumerable: true, configurable: true, value: null},
			ssrc: {enumerable: true, configurable: true, value: null},
			transportId: {enumerable: true, configurable: true, value: null}
		});

		this.socket = null;

		this.crypto = new Voice.PacketCrypto(); //allow pass in for module use

		this.rtpAudioPacket = new Voice.PacketRTP(Buffer.alloc(24), {version: 2});
		this.rtpAudioPacket.randomizeSequence();
		this.rtpAudioPacket.randomizeTimestamp();

		this.caches = {audio: Buffer.alloc(5 * 1024)};
		this.codecs = {audio: null, video: null};

		this.connected = false;
	}

	setAudioCodec(codec)
	{
		if (!codec) {return;}

		if (!Codecs.AUDIO.includes(codec)) {
			this.emit('error', new Error(`Unsupported audio codec received: ${codec}, supported; ${JSON.stringify(Codecs.AUDIO)}`));
			return this.voiceGateway.kill();
		}

		this.rtpAudioPacket.setPayloadType(Packet.RTPHeader.PayloadTypes[codec.toUpperCase()]);
		this.codecs.audio = codec;
	}

	setVideoCodec(codec)
	{
		if (!codec) {return;}
		//VP8/VP9, neither supported yet lol
		this.codecs.video = codec;
	}

	setKey(key)
	{
		Object.defineProperty(this, 'key', {value: key}); //change how crypto works rn, dont make it part of this class
		this.crypto.setKey(key);
	}

	setMode(mode)
	{
		if (!Constants.Voice.MODES.includes(mode)) {throw new Error(`Encryption mode '${mode}' is not supported.`);}
		Object.defineProperty(this, 'mode', {value: mode});
	}

	setSSRC(ssrc)
	{
		Object.defineProperty(this, 'ssrc', {value: ssrc});
		this.rtpAudioPacket.setSSRC(this.ssrc);
	}

	setTransportId(transportId)
	{
		Object.defineProperty(this, 'transportId', {value: transportId});
	}

	connect(ip, port)
	{
		this.remote.ip = ip || this.remote.ip;
		this.remote.port = port || this.remote.port;

		if (this.connected) {this.disconnect();}

		const socket = this.socket = dgram.createSocket('udp4');

		socket.once('message', (packet) => {
			if (this.ssrc !== packet.readUInt32LE(0)) {return this.emit('error', new Error('SSRC mismatch in ip discovery packet'));}

			this.local.ip = packet.slice(4, packet.indexOf(0, 4)).toString();
			this.local.port = packet.readUIntLE(packet.length - 2, 2);

			const codecs = [];
			
			Codecs.AUDIO.forEach((codec, i) => {
				codecs.push({
					name: codec,
					type: 'audio',
					priority: i * 1000,
					payload_type: Packet.RTPHeader.PayloadTypes[codec.toUpperCase()]
				});
			});

			Codecs.VIDEO.forEach((codec, i) => {
				codecs.push({
					name: codec,
					type: 'video',
					priority: i * 1000,
					payload_type: Packet.RTPHeader.PayloadTypes[codec.toUpperCase()]
				});
			});

			const data = {
				address: this.local.ip,
				port: this.local.port,
				mode: this.mode
			};

			this.voiceGateway.sendSelectProtocol('udp', data, codecs);
			this.voiceGateway.sendClientConnect();

			socket.on('message', this.onPacket.bind(this));
			this.emit('ready');
		});
	
		socket.on('close', () => {
			this.connected = false;
			this.emit('close');
		});

		socket.on('error', this.emit.bind(this, 'error'));

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

		this.rtpAudioPacket.reset();

		this.connected = false;
	}

	onPacket(packet, rinfo)
	{
		if (rinfo.address !== this.remote.ip || rinfo.port !== this.remote.port) {
			const error = new Error('Received a packet from an unknown IP/Port');
			error.rinfo = rinfo;
			return this.emit('error', error);
		}

		if (!Voice.PacketRTP.valid(packet)) {return;}
		//rtp version is not 2

		const header = Buffer.alloc(24);
		packet.copy(header, 0, 0, 12);

		let payload, nonce;
		switch (this.mode) {
			case 'xsalsa20_poly1305_lite': {
				nonce = Buffer.alloc(24);
				packet.copy(nonce, 0, packet.length - 4);
				payload = packet.slice(12, -4);
			}; break;
			case 'xsalsa20_poly1305_suffix': {
				nonce = Buffer.alloc(24);
				packet.copy(nonce, 0, packet.length - 24);
				payload = packet.slice(12, -24);
			}; break;
			case 'xsalsa20_poly1305': {
				nonce = header;
				payload = packet.slice(12);
			}; break;
			default: {
				return this.emit('error', new Error(`${this.mode} is not supported for decoding.`));
			};
		}

		const rtp = new Voice.PacketRTP(header, {payload, nonce});

		if (!Object.values(Packet.RTPHeader.PayloadTypes).includes(rtp.payloadType)) {
			const error = new Error('Unknown RTP Packet Payload Type');
			error.rtp = rtp;
			return this.emit('error', error);
		}

		if (!this.key) {
			const error = new Error('RTP Packet sent before being given the Encryption Key from the Session Description Event');
			error.rtp = rtp;
			return this.emit('error', error);
		}

		let data = this.crypto.decrypt(rtp.payload, rtp.nonce);
		if (!data) {
			const error = new Error('Packet failed to decrypt');
			error.rtp = rtp;
			return this.emit('error', error);
		}

		let packetType;
		switch (rtp.payloadType) {
			case Packet.RTPHeader.PayloadTypes.OPUS: {
				packetType = 'audio';

				if (rtp.padding) {
					//RFC3550 Section 5.1
					data = data.slice(0, data.length - data.readUIntBE(data.length - 1, 1));
					//last byte contains amount of padding, including itself, slice that stuff off
				}
				if (rtp.extension) {
					if (Packet.RTPHeaderExtension.OneByte.HEADER.every((header, i) => header === data[i])) {
						//RFC5285 Section 4.2: One-Byte Header

						const fields = [];
						const fieldAmount = data.readUIntBE(2, 2);
			
						let offset = 4;
						for (let i = 0; i < fieldAmount; i++) {
							const byte = data.readUIntBE(offset++, 1);
							const identifier = byte & Packet.RTPHeaderExtension.OneByte.LOCAL_IDENTIFIER;
							const len = ((byte >> 4) & Packet.RTPHeaderExtension.OneByte.LOCAL_IDENTIFIER) + 1;

							//ignore the data field if identifier === 15 (local identifer)
							if (identifier) {
								fields.push(data.slice(offset, offset + len));
							}
							offset += len;
			
							while (data[offset] === 0) {offset++;} //get rid of padding
						}

						fields.push(data.slice(offset));
						
						data = (fields.length <= 1) ? fields.shift() : Buffer.concat(fields);
						fields.length = 0;
					} else if (Packet.RTPHeaderExtension.TwoByte.HEADER.every((header, i) => header === data[i])) {
						//RFC5285 Section 4.3: Two-Byte Header not received yet, appbits unknown anyways
						//using two bytes, 0x10 and 0x00 instead

						const fields = [];
						const fieldAmount = data.readUIntBE(2, 2);

						let offset = 4;
						for (let i = 0; i < fieldAmount; i++) {
							const identifier = data.readUIntBE(offset++, 1);
							const len = data.readUIntBE(offset++, 1);
							if (!len) {continue;}

							fields.push(data.slice(offset, offset + len));
							offset += len;

							while (data[offset] === 0) {offset++;}
						}

						if (offset !== data.length) {
							fields.push(data.slice(offset));
							//just making sure, dunno tho
						}
						
						data = (fields.length <= 1) ? fields.shift() : Buffer.concat(fields);
						fields.length = 0;
					}
				}
				if (rtp.marker) {
					//RFC3550 Section 5.3: Profile-Specific Modifications to the RTP Header
					//clients send it sometimes, definitely on fresh connects to a server
				}
			}; break;
			default: {
				const error = new Error('Unsupported RTP Packet Payload Type');
				error.rtp = rtp;
				return this.emit('error', error);
			};
		}

		this.emit('packet', {rinfo, data, rtp, userId: this.voiceGateway.ssrcToUserId(rtp.ssrc, packetType)});
	}

	send(packet)
	{
		if (!this.connected || !this.socket) {throw new Error('UDP not connected yet!');}

		this.socket.send(packet, 0, packet.length, this.remote.port, this.remote.ip, (error, bytes) => {
			if (error) {this.emit('error', error);}
		});
	}

	sendAudioFrame(packet, options)
	{
		if (!this.connected) {return;}

		options = Object.assign({useCache: true}, options);

		const rtpPacket = (options.useCache) ? this.rtpAudioPacket : new Voice.PacketRTP(Buffer.alloc(24), {
			version: 2,
			payloadType: Packet.RTPHeader.PayloadTypes[this.codecs.audio.toUpperCase()]
		});

		if (!options.useCache) {
			if (options.sequence === undefined) {
				options.sequence = this.rtpAudioPacket.sequence;
				options.incrementSequence = false;
			}
			if (options.timestamp === undefined) {
				options.timestamp = this.rtpAudioPacket.timestamp;
				options.incrementTimestamp = false;
			}
		}

		rtpPacket.setSequence(options.sequence, options.incrementSequence);
		rtpPacket.setTimestamp(options.timestamp, options.incrementTimestamp);

		const cache = (options.useCache) ? this.caches.audio.slice(12) : null;
		const data = [];
		switch (this.mode) {
			case 'xsalsa20_poly1305_lite': {
				if (!options.useCache && options.nonce === undefined) {
					throw new Error(`You must use cache if you do not send in an incrementing nonce with the Encryption mode being ${this.mode}`);
				}
				rtpPacket.setNonce(options.nonce, options.incrementNonce);
				data.push(this.crypto.encrypt(packet, rtpPacket.nonce, cache));
				data.push(rtpPacket.nonce.slice(0, 4));
			}; break;
			case 'xsalsa20_poly1305_suffix': {
				const nonce = this.crypto.generateNonce(rtpPacket.nonce);
				data.push(this.crypto.encrypt(packet, nonce, cache));
				data.push(nonce);
			}; break;
			case 'xsalsa20_poly1305': {
				data.push(this.crypto.encrypt(packet, rtpPacket.header, cache));
			}; break;
			default: {
				throw new Error(`${this.mode} is not supported for encoding.`);
			};
		}
		
		if (options.useCache) {
			let total = 12;
			rtpPacket.header.copy(this.caches.audio, 0, 0, total);
			data.forEach((buffer) => {
				const start = total;
				total += buffer.length;
				if (buffer.packet) {return;}
				buffer.copy(this.caches.audio, start);
			});

			this.send(this.caches.audio.slice(0, total));
		} else {
			this.send(Buffer.concat([rtpPacket.header.slice(0, 12)].concat(data).map((b) => (b.packet) ? b.packet : b)));
		}
	}
}

module.exports = VoiceUDP;