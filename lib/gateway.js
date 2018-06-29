const UrlUtils = require('url');
const os = require('os');
const Zlib = require('zlib');

const Utils = require('./utils');
const BaseSocket = Utils.BaseSocket;
const Constants = Utils.Constants;
const OpCodes = Constants.OpCodes.Gateway;

const VoiceGateway = require('./voicegateway');

const Dependencies = {Erlpack: null};

try {
	Dependencies.Erlpack = require('erlpack');
} catch(e) {}

const defaultOptions = {
	autoReconnect: true,
	compress: true,
	encoding: (Dependencies.Erlpack) ? 'etf' : 'json',
	largeThreshold: 250,
	presence: null,
	reconnectDelay: 5000,
	shardCount: 1,
	shardId: 0
};

class Gateway extends Utils.EventEmitter {
	constructor(token, options) {
		super();

		this.socket = null;

		options = Object.assign({}, defaultOptions, options);
		Object.defineProperties(this, {
			token:          {enumerable: true, value: token},
			autoReconnect:  {enumerable: true, value: !!options.autoReconnect},
			compress:       {enumerable: true, value: !!options.compress},
			encoding:       {enumerable: true, value: options.encoding.toLowerCase()},
			disabledEvents: {enumerable: true, value: options.disabledEvents},
			largeThreshold: {enumerable: true, value: options.largeThreshold},
			reconnectDelay: {enumerable: true, value: options.reconnectDelay},
			shardCount:     {enumerable: true, value: options.shardCount},
			shardId:        {enumerable: true, value: options.shardId}
		});

		if (this.shardCount <= this.shardId) {
			throw new Error('Shard count cannot be less than or equal to the Shard ID!');
		}

		if (!Constants.Gateway.ENCODING.includes(this.encoding)) {
			throw new Error(`Invalid Encoding Type, valid: ${JSON.stringify(Constants.Gateway.ENCODING)}`);
		}

		if (this.encoding === 'etf' && !Dependencies.Erlpack) {
			throw new Error('Install Erlpack to use the ETF encoding.');
		}

		this.decompressor = null;
		if (this.compress) {
			this.decompressor = new Utils.Decompressor(Buffer.from(Constants.Gateway.ZLIB_SUFFIX));
			this.decompressor.on('data', (data) => {
				this.handle(data, true);
			}).on('error', (error) => {
				this.disconnect(OpCodes.RECONNECT, 'Invalid data received, reconnecting.');
				this.emit('warn', error);
			});
		}

		this.bucket = new Utils.Bucket(120, 60 * 1000);

		this.url = null;
		this.seq = 0;
		this.sessionId = null;
		this.discordTrace = [];
		this.resuming = false;
		
		this.userId = null;
		
		this.presence = null;
		if (options.presence) {
			this.presence = Object.assign({
				since: null,
				game: null,
				status: Constants.Gateway.Status.ONLINE,
				afk: false
			}, options.presence);
		}

		this.voiceGateways = new Map();

		Object.defineProperties(this, {
			killed: {enumerable: true, configurable: true, value: false},
			_heartbeat: {
				value: {
					ack: false,
					lastAck: null,
					lastSent: null,
					interval: null,
					intervalTime: null
				}
			}
		});
	}

	get initializing() {return !this.socket;}
	get connected() {return this.socket && this.socket.connected;}
	get connecting() {return this.socket && this.socket.connecting;}
	get closed() {return this.socket && this.socket.closed;}
	get closing() {return this.socket && this.socket.closing;}

	ping(timeout) {return (this.connected) ? this.socket.ping(timeout) : Promise.reject(new Error('Socket not connected at the moment.'));}

	send(op, d, cb, direct) {
		const packet = {op, d};

		let data;
		try {
			switch (this.encoding) {
				case 'json': data = JSON.stringify(packet); break;
				case 'etf': data = Dependencies.Erlpack.pack(packet); break;
				default: throw new Error(`Invalid encoding: ${encoding}`);
			}
		} catch(e) {this.emit('warn', e);}
		if (!data) {return;}

		if (direct) {
			if (this.connected) {
				this.socket.send(data, cb);
			} else {
				this.emit('warn', new Error('Socket isn\'t connected, dropping packet to send'));
			}
		} else {
			const func = () => {
				if (this.bucket.locked || !this.connected) {
					if (!this.bucket.locked) {
						this.bucket.lock();
					}
					this.bucket.add(func, true);
				} else {
					try {
						this.socket.send(data, cb);
					} catch(e) {this.emit('warn', e);}
				}
			};
	
			this.bucket.add(func);
		}
	}

	setPresence(presence) {
		presence = Object.assign({
			since: null,
			game: null,
			status: Constants.Gateway.Status.ONLINE,
			afk: false
		}, presence);

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

	decode(data, uncompressed) {
		try {
			if (data instanceof ArrayBuffer) {
				data = Buffer.from(new Uint8Array(data)); //uws and compression breaks without making a Uint8Array view
			} else if (Array.isArray(data)) {
				data = Buffer.concat(data);
			}

			if (!uncompressed && this.compress) {
				return this.decompressor.add(data);
			}

			switch (this.encoding) {
				case 'etf': return Dependencies.Erlpack.unpack(data);
				case 'json': return JSON.parse(data);
			}
		} catch(e) {this.emit('warn', e);}
	}

	handle(data, uncompressed) {
		const packet = this.decode(data, uncompressed);
		if (!packet) {return;}
		if (packet.s) {
			const oldSeq = this.seq;
			const newSeq = packet.s;
			if (newSeq > oldSeq + 1 && !this.resuming) {
				return this.resume();
			}
			this.seq = newSeq;
		}

		this.emit('packet', packet);

		switch(packet.op) {
			case OpCodes.HEARTBEAT: {
				this.heartbeat();
			}; break;
			case OpCodes.HEARTBEAT_ACK: {
				this._heartbeat.ack = true;
				this._heartbeat.lastAck = Date.now();
			}; break;
			case OpCodes.HELLO: {
				this.setHeartbeat(packet.d);
				if (this.sessionId) {
					this.resume();
				} else {
					this.identify();
				}
			}; break;
			case OpCodes.INVALID_SESSION: {
				setTimeout(() => {
					if (packet.d) {
						this.resume();
					} else {
						this.seq = 0;
						this.sessionId = null;
						this.identify();
					}
				}, Math.floor(Math.random() * 5 + 1) * 1000);
			}; break;
			case OpCodes.RECONNECT: {
				this.disconnect(OpCodes.RECONNECT, 'Reconnecting');
				this.connect();
			}; break;
			case OpCodes.DISPATCH: {
				this.handleDispatch(packet.t, packet.d);
			}; break;
		}
	}

	handleDispatch(name, data) {
		switch (name) {
			case 'READY': {
				this.bucket.unlock();
				this.userId = data.user.id;
<<<<<<< HEAD
				this.sessionId = data.session_id;
=======
				this.sessionId = data.sessionId;
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
				this.discordTrace = data._trace;
				this.emit('ready');
			}; break;
			case 'RESUMED': {
				this.resuming = false;
			}; break;
			case 'GUILD_DELETE': {
				const serverId = data.id;
				if (this.voiceGateways.has(serverId)) {
					const vGateway = this.voiceGateways.get(serverId);
					if (data.unavailable) {
<<<<<<< HEAD
						vGateway.kill(new Error('The guild this voice was connected to became unavailable'));
=======
						vGateway.kill(new Error('The guild this voice was connect to became unavailable'));
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
					} else {
						vGateway.kill(new Error('Left the guild this voice was connected to'));
					}
				}
			}; break;
			case 'VOICE_SERVER_UPDATE': {
<<<<<<< HEAD
				const serverId = data.guild_id;
				if (this.voiceGateways.has(serverId)) {
					const gateway = this.voiceGateways.get(serverId);
					gateway.setEndpoint(data.endpoint);
					gateway.setToken(data.token);
				}
=======
				if (!this.voiceGateways.has(data.guild_id)) {return;}
				const gateway = this.voiceGateways.get(data.guild_id);
				gateway.disconnect();
				gateway.setEndpoint(data.endpoint);
				gateway.setToken(data.token);
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
			}; break;
			case 'VOICE_STATE_UPDATE': {
				if (data.user_id !== this.userId) {return;}
				const serverId = data.guild_id || data.channel_id;
				if (this.voiceGateways.has(serverId)) {
					const gateway = this.voiceGateways.get(serverId);
					if (!data.channel_id) {
						gateway.kill();
<<<<<<< HEAD
					} else if (gateway.sessionId !== data.session_id) {
						gateway.kill();
					} else {
						gateway.setChannelId(data.channel_id);
						gateway.resolvePromises();
=======
					} else {
						gateway.setChannelId(data.channel_id);
						if (gateway.sessionId !== data.sessionId) {
							gateway.setSessionId(data.session_id);
						} else {
							gateway.resolvePromises();
						}
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
					}
				}
			}; break;
		}
	}

	identify() {
		const data = {
			token: this.token,
			properties: {
				'$os': `${os.type()} ${os.release()}; ${os.arch()}`,
				'$browser': process.version.replace(/^v/, (process.release.name || 'node') + '/'),
				'$device': `Detritus v${Constants.VERSION}`
			},
			v: Constants.ApiVersions.GATEWAY,
			compress: this.compress, //payload compression, rather use transport compression, using the get params overrides this
			large_threshold: this.largeThreshold,
			shard: [this.shardId, this.shardCount]
		};
		
		if (this.presence) {
			data.presence = this.presence;
		}

		this.send(OpCodes.IDENTIFY, data, undefined, true);
	}

	resume() {
		this.resuming = true;
		this.send(OpCodes.RESUME, {
			token: this.token,
			session_id: this.sessionId,
			seq: (this.seq) ? this.seq : null
		}, undefined, true);
	}

	heartbeat(fromInterval) {
		if (fromInterval && !this._heartbeat.ack) {
			this.disconnect(OpCodes.HEARTBEAT_ACK, 'Heartbeat ACK never arrived.');
			this.connect();
		} else {
			this._heartbeat.ack = false;
			this._heartbeat.lastSent = Date.now();
			this.send(OpCodes.HEARTBEAT, (this.seq) ? this.seq : null);
		}
	}

	setHeartbeat(data) {
		if (!data) {return;}

		this.heartbeat();
		this._heartbeat.ack = true;
		this._heartbeat.lastAck = Date.now();
		this._heartbeat.intervalTime = data.heartbeat_interval;
		if (this._heartbeat.interval) {
			clearInterval(this._heartbeat.interval);
		}
		this._heartbeat.interval = setInterval(this.heartbeat.bind(this, true), data.heartbeat_interval);

		this.discordTrace = data._trace;
	}


	connect(url) {
		if (this.killed) {return;}

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

		ws.on('open', this.emit.bind(this, 'open'));
		ws.on('error', this.emit.bind(this, 'warn'));

		ws.on('message', (data) => {
			if (ws !== this.socket) {return;}
			this.handle(data);
		});

		ws.on('close', (code, reason) => {
			this.emit('close', {code, reason});
			if (this.socket && ws !== this.socket) {return;}
			this.disconnect(code, reason);
			if (this.autoReconnect && !this.killed) {
				setTimeout(this.connect.bind(this), this.reconnectDelay);
			}
		});
	}
	
	cleanup(code) {
		this.bucket.clear();
		this.bucket.lock();
		if (this.decompressor) {
			this.decompressor.reset();
		}

		if (code === 1000 || code === 1001) {
			this.seq = 0;
			this.sessionId = null;
		}

		if (this._heartbeat.interval) {
			clearInterval(this._heartbeat.interval);
			this._heartbeat.interval = null;
		}
		this._heartbeat.ack = false;
		this._heartbeat.lastAck = null;
		this._heartbeat.lastSent = null;
		this._heartbeat.intervalTime = null;
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
		this.resuming = false;
	}

	kill() {
		if (this.killed) {return;}

		Object.defineProperty(this, 'killed', {value: true});
		this.disconnect(1000);
		for (let vGateway of this.voiceGateways.values()) {vGateway.kill();}
		this.emit('killed');
	}

	voiceStateUpdate(guildId, channelId, options, cb) {
		options = options || {};
		this.send(OpCodes.VOICE_STATE_UPDATE, {
			guild_id: guildId,
			channel_id: channelId,
			self_mute: !!options.mute,
			self_deaf: !!options.deaf,
			self_video: !!options.video
		}, cb);
	}

	voiceServerPing() {
		this.send(OpCodes.VOICE_SERVER_PING, null);
	}

	requestGuildMembers(guildId, options, cb) {
		options = options || {};
		this.send(OpCodes.REQUEST_GUILD_MEMBERS, {
			guild_id: guildId,
			query: options.query,
			limit: options.limit,
			user_ids: options.userIds,
			presences: options.presences
		}, cb);
	}

	callConnect(channelId, cb) {
		this.send(OpCodes.CALL_CONNECT, {channel_id: channelId}, cb); //on CALL_CONNECT events, call this
	}

	updateGuildSubscriptions(guildId, options, cb) {
		options = options || {};
		this.send(OpCodes.GUILD_SUBSCRIPTION, {
			guild_id: guildId,
			channels: options.channels, //channels: {id: [[0, 99]]}
			members: options.members, //members: [id, id, ..]
			activities: options.activities, //bool
			typing: options.typing, //bool
			presences: options.presences //bool
		}, cb);
	}

	voiceConnect(guildId, channelId, options) {
		options = Object.assign({timeout: 30000}, options);

		return new Promise((resolve, reject) => {
			if (!guildId && !channelId) {return reject(new Error('A GuildID or a ChannelID is required!'));}

			const serverId = guildId || channelId;
			let gateway;
			if (this.voiceGateways.has(serverId)) {
				gateway = this.voiceGateways.get(serverId);
				if (!channelId) {
					return resolve(gateway.kill());
				}
				if (channelId === gateway.channelId) {
					return resolve(gateway);
				}
			} else {
				if (!channelId) {
					return resolve(this.voiceStateUpdate(guildId, channelId, options));
				}
				gateway = new VoiceGateway(this, {serverId, channelId, userId: this.userId});
				this.voiceGateways.set(serverId, gateway);
			}

			let timeout;
			if (options.timeout) {
				timeout = setTimeout(() => {
					gateway.kill(new Error(`Voice Gateway took longer than ${options.timeout}ms to connect.`));
					timeout = null;
				}, options.timeout);
			}

			return new Promise((res, rej) => {
				gateway.promises.add({resolve: res, reject: rej});
				this.voiceStateUpdate(guildId, channelId, options);
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