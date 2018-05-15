const UrlUtils = require('url');
const os = require('os');
const Zlib = require('zlib');

const Utils = require('./utils');
const BaseSocket = Utils.BaseSocket;
const Constants = Utils.Constants;
const OpCodes = Constants.OpCodes.Gateway;

const VoiceGateway = require('./voicegateway');

const Dependencies = {
	Erlpack: null
};

try {
	Dependencies.Erlpack = require('erlpack');
} catch(e) {}

const defaultOptions = {
	autoReconnect: true,
	compress: true,
	encoding: (Dependencies.Erlpack) ? 'etf' : 'json',
	largeThreshold: 250,
	loadAllMembers: false,
	reconnectDelay: 5,
	shardCount: 1,
	shardId: 0
};

class Gateway extends Utils.EventEmitter
{
	constructor(token, options)
	{
		super();

		this.token = token;
		this.socket = null;

		options = Object.assign({}, defaultOptions, options);
		Object.defineProperties(this, {
			autoReconnect: {writable: false, value: !!options.autoReconnect},
			compress: {writable: false, value: !!options.compress},
			encoding: {writable: false, value: options.encoding.toLowerCase()},
			disabledEvents: {writable: false, value: options.disabledEvents},
			largeThreshold: {writable: false, value: options.largeThreshold},
			loadAllMembers: {writable: false, value: !!options.loadAllMembers},
			reconnectDelay: {writable: false, value: options.reconnectDelay},
			shardCount: {writable: false, value: options.shardCount},
			shardId: {writable: false, value: options.shardId}
		});

		if (!Constants.Gateway.Encoding.includes(this.encoding)) {
			throw new Error(`Invalid Encoding Type, valid: ${JSON.stringify(Constants.Gateway.Encoding)}`);
		}

		if (this.encoding === 'etf' && !Dependencies.Erlpack) {
			throw new Error('Install Erlpack to use the ETF encoding.');
		}

		this.decompressor = null;
		if (this.compress) {
			this.decompressor = new Utils.Decompressor(Constants.Gateway.ZLIB_SUFFIX);
			this.decompressor.on('data', (data) => {
				this.handle(data, true);
			}).on('error', this.emit.bind(this, 'error'));
		}

		this.bucket = new Utils.Bucket(120, 60 * 1000);

		this.url = null;
		this.seq = 0;
		this.sessionId = null;
		this.discordTrace = [];

		this._heartbeat = {
			ack: false,
			lastAck: null,
			interval: null
		};
		
		this.userId = null;
		this.presence = null;

		this.voiceGateways = new Map();
	}

	get initializing() {return !this.socket;}
	get connected() {return this.socket && this.socket.connected;}
	get connecting() {return this.socket && this.socket.connecting;}
	get closed() {return this.socket && this.socket.closed;}
	get closing() {return this.socket && this.socket.closing;}

	send(op, d, cb, direct)
	{
		const packet = {op, d};

		let data;
		try {
			switch (this.encoding) {
				case 'json': data = JSON.stringify(packet); break;
				case 'etf': data = Dependencies.Erlpack.pack(packet); break;
				default: throw new Error(`Invalid encoding: ${encoding}`);
			}
		} catch(e) {this.emit('error', e);}
		if (!data) {return;}

		if (direct) {
			this.socket.send(data, cb);
		} else {
			const func = () => {
				if (this.bucket.locked || !this.connected) {
					if (!this.bucket.locked) {
						this.bucket.lock();
					}
					this.bucket.add(func, true);
					return;
				}
				try {
					this.socket.send(data, cb);
				} catch(e) {this.emit('error', e);}
			};
	
			this.bucket.add(func);
		}
	}

	setPresence(presence)
	{
		presence = Object.assign({}, {since: null, game: null, status: 'online', afk: false}, presence);

		return new Promise((resolve, reject) => {
			if (presence.game) {
				if (presence.game.name === undefined) {
					return reject(new Error('The game name cannot be empty'));
				}
				if (presence.game.type === undefined) {
					return reject(new Error('The game type cannot be empty'));
				}
			}

			this.send(OpCodes.STATUS_UPDATE, presence, (e) => {
				if (e) {return reject(e);}
				this.presence = presence;
				resolve();
			});
		});
	}

	decode(data, uncompressed)
	{
		try {
			if (data instanceof ArrayBuffer) {
				//data = Buffer.from(data); uws and compression breaks without making uint8array from it first
				data = Buffer.from(new Uint8Array(data));
			} else {
				if (Array.isArray(data)) {
					data = Buffer.concat(data);
				}
			}

			if (!uncompressed && this.compress) {
				return this.decompressor.add(data);
			}

			if (this.encoding === 'etf') {
				return Dependencies.Erlpack.unpack(data);
			} else {
				return JSON.parse(data);
			}
		} catch(e) {console.log(data, uncompressed); this.emit('error', e);}
	}

	handle(data, uncompressed)
	{
		const packet = this.decode(data, uncompressed);
		if (!packet) {return;}
		if (packet.s) {
			if (packet.s > this.seq + 1 && this.socket && !this.socket.resuming) {
				this.seq = packet.s;
				this.resume();
			}
			this.seq = packet.s;
		}

		this.emit('packet', packet);

		switch(packet.op) {
			case OpCodes.HEARTBEAT: {
				this.heartbeat();
			}; break;
			case OpCodes.HEARTBEAT_ACK: {
				this._heartbeat.lastAck = Date.now();
				this._heartbeat.ack = true;
			}; break;
			case OpCodes.HELLO: {
				this.setHeartbeat(packet.d);
				if (this.sessionId) {
					this.resume();
				} else {
					this.identify();
				}
				this.heartbeat();
			}; break;
			case OpCodes.INVALID_SESSION: {
				if (packet.d) {
					this.resume();
				} else {
					this.cleanup(1000);
					this.identify();
				}
			}; break;
			case OpCodes.RECONNECT: {
				this.disconnect(OpCodes.RECONNECT, 'Reconnecting');
				this.connect();
			}; break;
			case OpCodes.DISPATCH: {
				if (packet.t === 'READY') {
					this.bucket.unlock();
					this.userId = packet.d.user.id;
					this.sessionId = data.session_id;
					this.discordTrace = data._trace;
					this.emit('ready');
				} else if (packet.t === 'VOICE_SERVER_UPDATE') {
					const gateway = this.voiceGateways.get(packet.d.guild_id);
					if (gateway) {
						gateway.disconnect();
						gateway.setEndpoint(packet.d.endpoint);
						gateway.setToken(packet.d.token);
					}
				} else if (packet.t === 'VOICE_STATE_UPDATE') {
					if (packet.d.user_id === this.userId) {
						const gateway = this.voiceGateways.get(packet.d.guild_id || packet.d.channel_id);
						if (gateway && gateway.sessionId !== packet.d.session_id) {
							gateway.setSessionId(packet.d.session_id);
						}
					}
				}
			}; break;
		}
	}

	identify()
	{
		const data = {
			token: this.token,
			properties: {
				'$os': `${os.type()} ${os.release()}; ${os.arch()}`,
				'$browser': process.version.replace(/^v/, (process.release.name || 'node') + '/'),
				'$device': `Detritus v${Constants.VERSION}`
			},
			v: Constants.ApiVersions.GATEWAY,
			//compress: this.compress, //payload compression, rather use transport compression
			large_threshold: this.largeThreshold,
			shard: [this.shardId, this.shardCount]
		};
		
		if (this.presence) {
			data.presence = this.presence;
		}

		this.send(OpCodes.IDENTIFY, data, undefined, true);
	}

	resume()
	{
		this.send(OpCodes.RESUME, {
			token: this.token,
			session_id: this.sessionId,
			seq: this.seq
		}, undefined, true);
	}

	heartbeat(fromInterval)
	{
		if (fromInterval) {
			if (!this._heartbeat.ack) {
				this.disconnect(OpCodes.HEARTBEAT_ACK, 'Heartbeat ACK never arrived.');
				this.connect();
				return;
			}
		}
		this._heartbeat.ack = false;
		this.send(OpCodes.HEARTBEAT, this.seq);
	}

	setHeartbeat(data)
	{
		if (data && data.heartbeat_interval > 0) {
			this._heartbeat.ack = true;
			if (this._heartbeat.interval) {
				clearInterval(this._heartbeat.interval);
			}
			this._heartbeat.interval = setInterval(() => {
				this.heartbeat(true);
			}, data.heartbeat_interval);
		}
		this.discordTrace = data._trace;
	}


	connect(url)
	{
		if (this.connected) {this.disconnect();}

		this.url = url || this.url;

		url = new UrlUtils.URL(this.url);
		url.searchParams.set('encoding', this.encoding);
		url.searchParams.set('v', Constants.ApiVersions.GATEWAY);
		url.pathname = url.pathname || '/';

		if (this.compress) {
			url.searchParams.set('compress', 'zlib-stream');
		}

		const ws = this.socket = new BaseSocket(url.href);
		ws.on('message', (data) => {
			if (ws !== this.socket) {return;}
			this.handle(data);
		});

		ws.on('open', () => {
			if (ws !== this.socket) {return;} //shouldnt ever happen but whatever
			this.emit('open');
		});

		ws.on('close', (code, reason) => {
			if (ws !== this.socket) {return;}
			this.disconnect(code, reason);
			this.emit('close', {code, reason});
		});

		ws.on('error', (error) => {
			this.emit('error', error);
		});
	}
	
	cleanup(code)
	{
		this.bucket.lock();
		this.user = null;
		if (this.compress) {
			this.decompressor.cleanup();
		}

		if (code === 1000 || code === 1001) {
			this.seq = 0;
			this.sessionId = null;
		}

		if (this._heartbeat.interval) {
			clearInterval(this._heartbeat.interval);
			this._heartbeat.interval = null;
		}
	}

	disconnect(code, reason)
	{
		this.cleanup(code);

		if (this.connected) {
			if (code === OpCodes.RECONNECT || code === OpCodes.HEARTBEAT_ACK) {
				this.socket.close(4000, reason);
			} else {
				this.socket.close(code, reason);
			}

			//emit the disconnect
		}
	}

	voiceConnect(guildId, channelId, options)
	{
		options = options || {};
		options.timeout = options.timeout || 30000;
		options.mute = !!options.mute;
		options.deafen = !!options.deafen;

		return new Promise((resolve, reject) => {
			if (!guildId && !channelId) {return reject(new Error('A GuildID or a ChannelID is required!'));}

			let gateway = this.voiceGateways.get(guildId || channelId);
			if (!gateway && channelId) {
				gateway = new VoiceGateway(this, {
					serverId: guildId || channelId,
					userId: this.userId
				});
				this.voiceGateways.set(guildId || channelId, gateway);
			}

			let timeout;
			if (options.timeout) {
				timeout = setTimeout(() => {
					this.voiceGateways.delete(guildId || channelId);
					reject(new Error(`Voice Gateway took longer than ${options.timeout}ms to connect.`));
				}, options.timeout);
			}

			new Promise((res, rej) => {
				if (channelId) {
					const promise = {resolve: res, reject: rej};
					gateway.waiting.add(promise);
				} else {
					if (this.voiceGateways.has(guildId)) {
						this.voiceGateways.get(guildId).disconnect(1000);
						this.voiceGateways.delete(guildId);
					}
					res();
				}

				this.send(OpCodes.VOICE_STATE_UPDATE, {
					'guild_id': guildId,
					'channel_id': channelId,
					'self_mute': options.mute,
					'self_deaf': options.deafen
				});
			}).then(() => {
				if (timeout) {clearTimeout(timeout);}
				resolve((channelId) ? gateway : null);
			}).catch((e) => {
				if (timeout) {clearTimeout(timeout);}
				reject(e);
			});
		});
	}
}

module.exports = Gateway;