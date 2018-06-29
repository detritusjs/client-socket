const dgram = require('dgram');

const Utils = require('./utils');
const Constants = Utils.Constants;

const Codecs = Constants.Voice.Codecs;
const Packet = Constants.Voice.Packet;

const Voice = Utils.Voice;

class VoiceUDP extends Utils.EventEmitter {
	constructor(voiceGateway) {
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

<<<<<<< HEAD
		Object.defineProperties(this, {
			headers: {value: {audio: new Voice.RTPHeader({randomize: true})}},
			nonces: {value: {audio: new Voice.RTPNonce({randomize: true})}}
		});
=======
		this.crypto = new Voice.PacketCrypto(); //allow pass in for module use

		Object.defineProperty(this, 'rtpPackets', {
			value: {audio: new Voice.PacketRTP(Buffer.alloc(12), {version: 2, nonce: Buffer.alloc(24)})}
		});

		this.rtpPackets.audio.randomizeSequence();
		this.rtpPackets.audio.randomizeTimestamp();
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d

		this.caches = {audio: Buffer.alloc(5 * 1024)};
		this.codecs = {audio: null, video: null};

		this.connected = false;
	}

<<<<<<< HEAD
	get audioPayloadType() {
		return (this.codecs.audio) ? Packet.RTPHeader.PayloadTypes[this.codecs.audio.toUpperCase()] : null;
	}

=======
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
	setAudioCodec(codec) {
		if (!codec) {return;}

		if (!Codecs.AUDIO.includes(codec)) {
			this.emit('warn', new Error(`Unsupported audio codec received: ${codec}, supported; ${JSON.stringify(Codecs.AUDIO)}`));
			return this.voiceGateway.kill();
		}

<<<<<<< HEAD
=======
		this.rtpPackets.audio.setPayloadType(Packet.RTPHeader.PayloadTypes[codec.toUpperCase()]);
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
		this.codecs.audio = codec;
		this.headers.audio.setPayloadType(this.audioPayloadType);
	}

	setVideoCodec(codec) {
		if (!codec) {return;}
		//VP8/VP9, neither supported here
		this.codecs.video = codec;
	}

	setKey(key) {
<<<<<<< HEAD
		Object.defineProperty(this, 'key', {value: Uint8Array.from(key)});
=======
		Object.defineProperty(this, 'key', {value: key}); //change how crypto works rn, dont make it part of this class
		this.crypto.setKey(key);
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
	}

	setMode(mode) {
		if (!Constants.Voice.MODES.includes(mode)) {throw new Error(`Encryption mode '${mode}' is not supported.`);}
		Object.defineProperty(this, 'mode', {value: mode});
	}

	setSSRC(ssrc) {
		Object.defineProperty(this, 'ssrc', {value: ssrc});
<<<<<<< HEAD
		this.headers.audio.setSSRC(this.ssrc);
=======
		this.rtpPackets.audio.setSSRC(this.ssrc);
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
	}

	setTransportId(transportId) {
		Object.defineProperty(this, 'transportId', {value: transportId});
	}

	connect(ip, port) {
		this.remote.ip = ip || this.remote.ip;
		this.remote.port = port || this.remote.port;

		if (this.connected) {this.disconnect();}

		const socket = this.socket = dgram.createSocket('udp4');

		socket.once('message', (packet) => {
<<<<<<< HEAD
			if (this.ssrc !== packet.readUInt32LE(0)) {
				return this.emit('warn', new Error('SSRC mismatch in ip discovery packet'));
			}
=======
			if (this.ssrc !== packet.readUInt32LE(0)) {return this.emit('warn', new Error('SSRC mismatch in ip discovery packet'));}
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d

			this.local.ip = packet.slice(4, packet.indexOf(0, 4)).toString();
			this.local.port = packet.readUIntLE(packet.length - 2, 2);

			const codecs = [];
			
			Codecs.AUDIO.forEach((codec, i) => {
				codecs.push({
					name: codec,
					type: 'audio',
					priority: (i + 1) * 1000,
					payload_type: Packet.RTPHeader.PayloadTypes[codec.toUpperCase()]
				});
			});

			Codecs.VIDEO.forEach((codec, i) => {
				codecs.push({
					name: codec,
					type: 'video',
					priority: (i + 1) * 1000,
					payload_type: Packet.RTPHeader.PayloadTypes[codec.toUpperCase()]
				});
			});

			const data = {
				address: this.local.ip,
				port: this.local.port,
				mode: this.mode
			};

			this.voiceGateway.sendSelectProtocol(data, codecs);
			this.voiceGateway.sendClientConnect();

			socket.on('message', this.onPacket.bind(this));
			this.emit('ready');
		});
	
		socket.on('close', () => {
			this.connected = false;
			this.emit('close');
		});

		socket.on('error', this.emit.bind(this, 'warn'));

		this.connected = true;

		const ipDiscovery = Buffer.alloc(70);
		ipDiscovery.writeUIntBE(this.ssrc, 0, 4);
		this.send(ipDiscovery);
	}

	disconnect() {
		if (this.socket) {
			this.socket.close();
			this.socket = null;
		}

<<<<<<< HEAD
		this.headers.audio.reset();
=======
		this.rtpPackets.audio.reset();
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d

		this.connected = false;
	}

	onPacket(packet, rinfo) {
		if (rinfo.address !== this.remote.ip || rinfo.port !== this.remote.port) {
			const error = new Error('Received a packet from an unknown IP/Port');
			error.rinfo = rinfo;
			return this.emit('warn', error);
		}

		if (packet.length <= 12) {return;}
		//rtp packet is not the right size

		if (!Voice.RTPHeader.valid(packet)) {return;}
		//rtp version is not 2

<<<<<<< HEAD
		const rtp = {};
		rtp.header = new Voice.RTPHeader({buffer: packet.slice(0, 12)});

		if (!Object.values(Packet.RTPHeader.PayloadTypes).includes(rtp.header.payloadType)) {
			const error = new Error('Unknown RTP Packet Payload Type');
			error.rtp = rtp;
			return this.emit('warn', error);
		}

		rtp.nonce = Buffer.alloc(24);
		switch (this.mode) {
			case 'xsalsa20_poly1305_lite': {
				packet.copy(rtp.nonce, 0, packet.length - 4);
				rtp.payload = packet.slice(12, -4);
			}; break;
			case 'xsalsa20_poly1305_suffix': {
				packet.copy(rtp.nonce, 0, packet.length - 24);
				rtp.payload = packet.slice(12, -24);
			}; break;
			case 'xsalsa20_poly1305': {
				packet.copy(rtp.nonce, 0, 0, 12);
				rtp.payload = packet.slice(12);
=======
		const header = packet.slice(0, 12);

		let payload;
		const nonce = Buffer.alloc(24);
		switch (this.mode) {
			case 'xsalsa20_poly1305_lite': {
				packet.copy(nonce, 0, packet.length - 4);
				payload = packet.slice(12, -4);
			}; break;
			case 'xsalsa20_poly1305_suffix': {
				packet.copy(nonce, 0, packet.length - 24);
				payload = packet.slice(12, -24);
			}; break;
			case 'xsalsa20_poly1305': {
				header.copy(nonce);
				payload = packet.slice(12);
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
			}; break;
			default: {
				return this.emit('warn', new Error(`${this.mode} is not supported for decoding.`));
			};
		}

<<<<<<< HEAD
		let data = Voice.RTPCrypto.decrypt(this.key, rtp.payload, rtp.nonce);
=======
		const rtp = new Voice.PacketRTP(header, {payload, nonce});

		if (!Object.values(Packet.RTPHeader.PayloadTypes).includes(rtp.payloadType)) {
			const error = new Error('Unknown RTP Packet Payload Type');
			error.rtp = rtp;
			return this.emit('warn', error);
		}

		if (!this.key) {
			const error = new Error('RTP Packet sent before being given the Encryption Key from the Session Description Event');
			error.rtp = rtp;
			return this.emit('warn', error);
		}

		let data = this.crypto.decrypt(rtp.payload, rtp.nonce);
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
		if (!data) {
			const error = new Error('Packet failed to decrypt');
			error.rtp = rtp;
			return this.emit('warn', error);
		}

		if (rtp.header.padding) {
			//RFC3550 Section 5.1
			data = data.slice(0, data.length - data.readUIntBE(data.length - 1, 1));
			//last byte contains amount of padding, including itself, slice that stuff off
		}
		if (rtp.header.extension) {
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
				//if appbits is all 0s, ignore, so rn ignore this packet

				const error = new Error('Received Two Byte header with appbits being 0, ignoring');
				error.rtp = rtp;
				return this.emit('warn', error);

				/*
				//handle the two byte
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
				*/
			}
		}

		let payloadType, format;
		switch (rtp.header.payloadType) {
			case Packet.RTPHeader.PayloadTypes.OPUS: {
				payloadType = 'opus';
				format = 'audio';
			}; break;
<<<<<<< HEAD
		}
		
		let userId = null;
		if (format) {
			userId = this.voiceGateway.ssrcToUserId(rtp.header.ssrc, format);
		}

		this.emit('packet', {rinfo, rtp, payloadType, format, userId, data});
=======
			default: {
				const error = new Error('Unsupported RTP Packet Payload Type');
				error.rtp = rtp;
				return this.emit('warn', error);
			};
		}

		const codec = this.codecs[packetType] || null;
		const userId = this.voiceGateway.ssrcToUserId(rtp.ssrc, packetType);
		this.emit('packet', {rinfo, rtp, packetType, codec, data, userId});
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
	}

	send(packet) {
		if (!this.connected || !this.socket) {throw new Error('UDP not connected yet!');}

		this.socket.send(packet, 0, packet.length, this.remote.port, this.remote.ip, (error, bytes) => {
			if (error) {this.emit('warn', error);}
		});
	}

	sendAudioFrame(packet, options) {
		if (!this.connected) {return;}

		options = Object.assign({useCache: true}, options);

<<<<<<< HEAD
		const rtp = {};

		if (options.useCache) {
			rtp.header = this.headers.audio;
			rtp.nonce = this.nonces.audio;
		} else {
			rtp.header = new Voice.RTPHeader({payloadType: this.audioPayloadType});
			rtp.nonce = new Voice.RTPNonce({randomize: true});
		}

		if (!options.useCache) {
			if (options.sequence === undefined) {
				options.sequence = this.headers.audio.sequence;
				options.incrementSequence = false;
			}
			if (options.timestamp === undefined) {
				options.timestamp = this.headers.audio.timestamp;
=======
		const rtpPacket = (options.useCache) ? this.rtpPackets.audio : new Voice.PacketRTP(Buffer.alloc(12), {
			version: 2,
			payloadType: Packet.RTPHeader.PayloadTypes[this.codecs.audio.toUpperCase()],
			nonce: Buffer.alloc(24)
		});

		if (!options.useCache) {
			if (options.sequence === undefined) {
				options.sequence = this.rtpPackets.audio.sequence;
				options.incrementSequence = false;
			}
			if (options.timestamp === undefined) {
				options.timestamp = this.rtpPackets.audio.timestamp;
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
				options.incrementTimestamp = false;
			}
		}

		rtp.header.setSequence(options.sequence, options.incrementSequence);
		rtp.header.setTimestamp(options.timestamp, options.incrementTimestamp);

		const cache = (options.useCache) ? this.caches.audio.slice(12) : null;

		const data = [];

		let nonce;
		switch (this.mode) {
			case 'xsalsa20_poly1305_lite': {
				if (!options.useCache && options.nonce === undefined) {
					throw new Error(`You must use cache if you do not send in an incrementing nonce with the Encryption mode being ${this.mode}`);
				}
				nonce = rtp.nonce.set(options.nonce, options.incrementNonce);
				data.push(nonce.slice(0, 4));
			}; break;
			case 'xsalsa20_poly1305_suffix': {
				nonce = rtp.nonce.generate();
				data.push(nonce);
			}; break;
			case 'xsalsa20_poly1305': {
<<<<<<< HEAD
				rtp.header.copy(rtp.nonce.buffer);
				nonce = rtp.nonce.buffer;
=======
				rtpPacket.header.copy(rtpPacket.nonce);
				data.push(this.crypto.encrypt(packet, rtpPacket.nonce, cache));
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
			}; break;
			default: {
				throw new Error(`${this.mode} is not supported for encoding.`);
			};
		}

		data.unshift(Voice.RTPCrypto.encrypt(this.key, packet, nonce, cache));
		
		if (options.useCache) {
<<<<<<< HEAD
			let total = rtp.header.length;
			rtp.header.copy(this.caches.audio);
=======
			let total = rtpPacket.header.length;
			rtpPacket.header.copy(this.caches.audio);
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
			data.forEach((buffer) => {
				const start = total;
				total += buffer.length;
				if (buffer.packet) {return;}
				buffer.copy(this.caches.audio, start);
			});

			this.send(this.caches.audio.slice(0, total));
		} else {
<<<<<<< HEAD
			this.send(Buffer.concat([rtp.header.buffer].concat(data).map((b) => (b.packet) ? b.packet : b)));
=======
			this.send(Buffer.concat([rtpPacket.header].concat(data).map((b) => (b.packet) ? b.packet : b)));
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
		}
	}
}

module.exports = VoiceUDP;