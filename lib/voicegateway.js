const UrlUtils = require('url');

const Utils = require('./utils');
const BaseSocket = Utils.BaseSocket;
const Constants = Utils.Constants;
const OpCodes = Constants.Discord.OpCodes.Voice;

const VoiceUDP = require('./voiceudp');

const defaultOptions = {
	serverId: null,
	userId: null,
	token: null,
	videoEnabled: false
};

class VoiceGateway extends Utils.EventEmitter {
	constructor(gateway, options) {
		super();

		Object.defineProperty(this, 'gateway', {value: gateway});

		this.socket = null;

		options = Object.assign({}, defaultOptions, options);
		Object.defineProperties(this, {
			serverId: {enumerable: true, value: options.serverId},
			userId: {enumerable: true, value: options.userId}
		});

		Object.defineProperties(this, {
			channelId: {enumerable: true, configurable: true, value: options.channelId},
			token: {enumerable: true, configurable: true, value: null}
		});
		
		this.videoEnabled = !!options.videoEnabled;

		this.bucket = new Utils.Buckets.Bucket(120, 60 * 1000);
		this.endpoint = null;

		this.udp = null;

		this.ssrcs = {
			audio: new Map(),
			video: new Map()
		};

		this.promises = new Set();

		this.identified = false;
		Object.defineProperties(this, {
			ready: {enumerable: true, configurable: true, value: false},
			killed: {enumerable: true, configurable: true, value: false},
			_heartbeat: {
				value: {
					ack: false,
					lastAck: null,
					lastSent: null,
					interval: null,
					intervalTime: null,
					nonce: null
				}
			}
		});
	}

	get guildId() {
		return (this.inDm) ? null : this.serverId;
	}

	get initializing() {return !this.socket;}
	get connected() {return this.socket && this.socket.connected;}
	get connecting() {return this.socket && this.socket.connecting;}
	get closed() {return this.socket && this.socket.closed;}
	get closing() {return this.socket && this.socket.closing;}

	get inDm() {return this.serverId === this.channelId;}

	get sessionId() {
		return this.gateway.sessionId;
	}

	get audioSSRC() {return (this.udp) ? this.udp.ssrc : 0;}
	get videoSSRC() {return this.audioSSRC + 1;}
	get rtxSSRC() {return this.videoSSRC + 1;}

	ping(timeout) {
		return (this.connected) ? this.socket.ping(timeout) : Promise.reject(new Error('Socket not connected at the moment.'));
	}

	resolvePromises(error) {
		this.promises.forEach((promise) => {
			this.promises.delete(promise);
			return (error) ? promise.reject(error) : promise.resolve();
		});
	}

	setChannelId(channelId) {
		Object.defineProperty(this, 'channelId', {value: channelId});
	}

	setEndpoint(endpoint) {
		this.endpoint = (endpoint) ? `wss://${endpoint.split(':').shift()}` : null;
		this.identified = false;
		if (this.connected) {
			this.connect();
		}
	}

	setToken(token) {
		Object.defineProperty(this, 'token', {value: token});
		if (!this.identified) {
			this.resolvePromises();
			this.connect();
		}
	}

	ssrcToUserId(ssrc, type) {
		if (!this.ssrcs[type]) {throw new Error('Invalid SSRC Type!');}

		return this.ssrcs[type].get(ssrc);
	}

	userIdToSSRC(userId, type) {
		if (!this.ssrcs[type]) {throw new Error('Invalid SSRC Type!');}

		for (let [ssrc, uid] of this.ssrcs[type].entries()) {
			if (userId === uid) {
				return ssrc;
			}
		}
	}

	send(op, d, cb, direct) {
		if (!this.connected) {return;}
		const packet = {op, d};

		const data = this.encode(packet);
		if (!data) {return;}
		if (direct) {
			this.socket.send(data, cb);
		} else {
			const func = () => {
				if (this.bucket.locked || !this.identified || !this.connected) {
					if (!this.bucket.locked) {
						this.bucket.lock();
					}
					this.bucket.add(func, true);
					return;
				}
				try {
					this.socket.send(data, cb);
				} catch(e) {this.emit('warn', e);}
			};
	
			this.bucket.add(func);
		}
	}

	encode(data) {
		try {
			return JSON.stringify(data);
		} catch(e) {this.emit('warn', e);}
	}

	decode(data) {
		try {
			return JSON.parse(data);
		} catch(e) {this.emit('warn', e);}
	}

	identify() {
		this.send(OpCodes.IDENTIFY, {
			server_id: this.serverId,
			user_id: this.userId,
			session_id: this.sessionId,
			token: this.token,
			video: this.videoEnabled
		}, undefined, true);
	}

	resume() {
		this.send(OpCodes.RESUME, {
			server_id: this.serverId,
			session_id: this.sessionId,
			token: this.token
		}, undefined, true);
	}

	heartbeat(fromInterval) {
		if (fromInterval && (this._heartbeat.lastSent && !this._heartbeat.ack)) {
			this.disconnect(OpCodes.HEARTBEAT_ACK, 'Heartbeat ACK never arrived.');
			return this.connect();
		}
		this._heartbeat.ack = false;
		this._heartbeat.nonce = Date.now();
		this.send(OpCodes.HEARTBEAT, this._heartbeat.nonce, () => {
			this._heartbeat.lastSent = Date.now();
		});
	}

	setHeartbeat(data) {
		if (!data || !data.heartbeat_interval) {return;}

		this.heartbeat();
		this._heartbeat.ack = true;
		this._heartbeat.lastAck = Date.now();
		this._heartbeat.intervalTime = data.heartbeat_interval;
		if (this._heartbeat.interval) {
			clearInterval(this._heartbeat.interval);
		}
		this._heartbeat.interval = setInterval(this.heartbeat.bind(this, true), data.heartbeat_interval);
	}

	handle(data) {
		const packet = this.decode(data);
		if (!packet) {return;}

		this.emit('packet', packet);

		switch(packet.op) {
			case OpCodes.READY: {
				Object.defineProperty(this, 'ready', {value: true});
				this.identified = true;
				this.bucket.unlock();
				this.udpConnect(packet.d);
				this.emit('ready');

				this.sendSpeaking({voice: true});
				//This causes clients who connect to the voice channel to receive a speaking event while the bot is talking
				//The speaking event gives the client the SSRC and allows the bot to start talking on their end
				//Allows us to not send in speaking = false events /shrug
			}; break;
			case OpCodes.SESSION_DESCRIPTION: {
				this.udp.setAudioCodec(packet.d.audio_codec);
				this.udp.setVideoCodec(packet.d.video_codec);
				this.udp.setKey(packet.d.secret_key);
				this.udp.setMode(packet.d.mode);
				this.udp.setTransportId(packet.d.media_session_id);
				//audioCodec, mode, mediaSessionId, videoCodec, secretKey, sdp
			}; break;
			case OpCodes.SPEAKING: {
				this.ssrcs.audio.set(packet.d.ssrc, packet.d.user_id);
				//use the bitmasks Constants.Discord.SpeakingFlags
				//emit it?
				//check to see if it already existed, if not, create decode/encoders
			}; break;
			case OpCodes.HEARTBEAT_ACK: {
				if (packet.d !== this._heartbeat.nonce) {
					this.disconnect(OpCodes.HEARTBEAT_ACK, 'Invalid nonce received by Heartbeat ACK');
					return this.connect();
				}
				this._heartbeat.lastAck = Date.now();
				this._heartbeat.ack = true;
			}; break;
			case OpCodes.HELLO: {
				this.setHeartbeat(packet.d);
			}; break;
			case OpCodes.RESUMED: {
				Object.defineProperty(this, 'ready', {value: true});
				this.bucket.unlock();
			}; break;
			case OpCodes.CLIENT_CONNECT: {
				this.ssrcs.audio.set(packet.d.audio_ssrc, packet.d.user_id);
				if (packet.d.video_ssrc) {
					this.ssrcs.video.set(packet.d.video_ssrc, packet.d.user_id);
				}
				//start the user id's decode/encoders too
			}; break;
			case OpCodes.CLIENT_DISCONNECT: {
				const audioSSRC = this.userIdToSSRC(packet.d.user_id, 'audio');
				const videoSSRC = this.userIdToSSRC(packet.d.user_id, 'video');
				
				this.ssrcs.audio.delete(audioSSRC);
				this.ssrcs.video.delete(videoSSRC);
			}; break;
			case OpCodes.SIGNAL: {
				this.sendSignal(packet.d);
				//? lol
			}; break;
			case OpCodes.CODECS: {
				this.udp.setAudioCodec(packet.d.audio_codec);
				this.udp.setVideoCodec(packet.d.video_codec);
				this.udp.setTransportId(packet.d.media_session_id);
			}; break;
		}
	}

	connect(endpoint) {
		if (this.killed) {return;}

		if (endpoint) {this.setEndpoint(endpoint);}

		const url = new UrlUtils.URL(this.endpoint);
		url.searchParams.set('v', Constants.ApiVersions.VOICE_GATEWAY);
		url.pathname = url.pathname || '/';
	
		const ws = this.socket = new BaseSocket(url.href);
		ws.on('open', () => {
			this.emit('open');

			if (this.identified && this.udp) {
				this.resume();
			} else {
				this.identify();
			}
		});

		ws.on('close', (code, reason) => {
			this.emit('close', {code, reason});
			if (this.socket && this.socket !== ws) {return;}
			this.cleanup(code);

			if (!this.killed) {
				setTimeout(this.connect.bind(this), this.gateway.reconnectDelay);
			}
		});

		ws.on('message', this.handle.bind(this));
		ws.on('error', this.emit.bind(this, 'warn'));
	}

	cleanup(code) {
		Object.defineProperty(this, 'ready', {value: false});
		this.bucket.lock();
		this.bucket.clear();

		this.ssrcs.audio.clear();
		this.ssrcs.video.clear();

		if (code === 1000 || (4000 <= code && code <= 4016)) {
			this.identified = false;
		}

		if (this._heartbeat.interval) {
			clearInterval(this._heartbeat.interval);
			this._heartbeat.interval = null;
		}

		this._heartbeat.ack = false;
		this._heartbeat.lastAck = null;
		this._heartbeat.lastSent = null;
		this._heartbeat.intervalTime = null;
		this._heartbeat.nonce = null;
	}
	
	disconnect(code, reason) {
		this.cleanup(code);

		if (this.socket) {
			if (code === OpCodes.RECONNECT || code === OpCodes.HEARTBEAT_ACK) {
				this.socket.close(4000, reason);
			} else {
				this.socket.close(code, reason);
			}
		}
		this.socket = null;
	}

	kill(error) {
		if (this.killed) {return;}

		this.gateway.voiceStateUpdate((this.inDm) ? null : this.serverId, null);

		Object.defineProperty(this, 'killed', {value: true});
		this.gateway.voiceGateways.delete(this.serverId);
		this.disconnect(1000);
		if (this.udp) {
			this.udp.disconnect();
			this.udp = null;
		}
		this.resolvePromises(error || new Error('Voice Gateway was killed.'));

		this.emit('killed');
	}

	udpConnect(udpinfo) {
		this.ssrcs.audio.set(udpinfo.ssrc, this.gateway.userId);
		
		if (!this.udp) {
			this.udp = new VoiceUDP(this);
		} else if (this.udp.connected) {
			this.udp.disconnect();
		}

		for (let mode of udpinfo.modes) {
			if (Constants.Voice.MODES.includes(mode)) {
				udpinfo.mode = mode;
				break;
			}
		}
		if (!udpinfo.mode) {
			this.udp.disconnect();
			this.udp = null;
			return this.emit('warn', new Error(`No supported voice mode found in ${JSON.stringify(udpinfo.modes)}`));
		}

		this.udp.setMode(udpinfo.mode);
		this.udp.setSSRC(udpinfo.ssrc);
		this.udp.connect(udpinfo.ip, udpinfo.port);

		this.emit('udpReady', {udp: this.udp});
	}

	sendSelectProtocol(data, codecs, cb) {
		this.send(OpCodes.SELECT_PROTOCOL, {protocol: 'udp', data, codecs}, cb);
	}

	sendSpeaking(options, delay=0, cb) {
		if (!this.udp) {throw new Error('UDP is not initialized yet! We need the SSRC from it!');}
		options = Object.assign({}, options);

		let speaking = Constants.Discord.SpeakingFlags.NONE;
		if (options.voice) {
			speaking |= Constants.Discord.SpeakingFlags.VOICE;
		}
		if (options.soundshare) {
			speaking |= Constants.Discord.SpeakingFlags.SOUNDSHARE;
		}

		this.send(OpCodes.SPEAKING, {speaking, delay, ssrc: this.udp.ssrc}, cb);
	}

	sendClientConnect(cb) {
		if (!this.udp) {throw new Error('UDP not initialized');}
		this.send(OpCodes.CLIENT_CONNECT, {
			audio_ssrc: this.audioSSRC,
			video_ssrc: this.videoSSRC,
			rtx_ssrc: this.rtxSSRC
		}, cb);
	}

	sendSignal(userId, options, cb) {
		//??
		this.send(OpCodes.SIGNAL, {
			user_id: userId
		}, cb);
	}

	sendStateUpdate(options, cb) {
		this.gateway.voiceStateUpdate(this.guildId, this.channelId, options, cb);
	}
}

module.exports = VoiceGateway;