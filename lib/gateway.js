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
	compress: false,
	encoding: 'json',
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

		this.zlib = {inflate: null, gatewayChunks: [], chunks: [], flushing: false};
		if (this.compress) {
			this.zlib.inflate = Zlib.createInflate({flush: Zlib.constants.Z_SYNC_FLUSH});
			this.zlib.inflate.on('data', (data) => {
				if (!this.connected) {return;}
				this.zlib.chunks.push(data);
			}).on('error', (error) => this.emit('error', error));
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

	get initializing()
	{
		return !this.socket;
	}

	get connected()
	{
		return this.socket && this.socket.connected;
	}

	get connecting()
	{
		return this.socket && this.socket.connecting;
	}

	get closed()
	{
		return this.socket && this.socket.closed;
	}

	get closing()
	{
		return this.socket && this.socket.closing;
	}

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
				if (!this.connected) {
					this.bucket.lock();
					this.bucket.add(func, true);
					this.bucket.sent.amount--;
					return;
				}
				this.socket.send(data, cb);
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

	onFlush(error)
	{
		if (error) {return this.emit('error', error);}
		this.zlib.flushing = false;
		if (!this.zlib.chunks.length) {return;}

		const data = (this.zlib.chunks.length === 1) ? this.zlib.chunks.shift() : Buffer.concat(this.zlib.chunks);
		this.zlib.chunks.length = 0;

		while (this.zlib.gatewayChunks.length) {
			const _data = this.zlib.gatewayChunks.shift();
			this.zlib.inflate.write(_data);
			if (_data.slice(-4).equals(Constants.Gateway.ZLIB_SUFFIX)) {
				this.zlib.flushing = true;
				this.zlib.inflate.flush(Zlib.constants.Z_SYNC_FLUSH, this.onFlush.bind(this));
				break;
			}
		}
		if (this.encoding === 'etf') {
			this.handle(data, true);
		} else {
			this.handle(data.toString('utf8'), true);
		}
	}

	decode(data, uncompressed)
	{
		try {
			if (data instanceof ArrayBuffer) {
				if (this.compress || this.encoding === 'etf') {
					data = Buffer.from(data);
				}
			} else if (Array.isArray(data)) {
				data = Buffer.concat(data);
			}

			if (!uncompressed && this.compress) {
				if (this.zlib.flushing) {
					this.zlib.gatewayChunks.push(data);
				} else {
					this.zlib.inflate.write(data);
					if (data.slice(-4).equals(Constants.Gateway.ZLIB_SUFFIX)) {
						this.zlib.flushing = true;
						this.zlib.inflate.flush(Zlib.constants.Z_SYNC_FLUSH, this.onFlush.bind(this));
					}
				}
				return;
			}

			if (this.encoding === 'etf') {
				return Dependencies.Erlpack.unpack(data);
			} else {
				return JSON.parse(data);
			}
		} catch(e) {this.emit('error', e);}
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
					this.emit('ready');
				} else if (packet.t === 'VOICE_SERVER_UPDATE') {
					const gateway = this.voiceGateways.get(packet.d.guild_id);
					if (gateway) {
						gateway.disconnect();
						gateway.setEndpoint(packet.d.endpoint);
						gateway.setToken(packet.d.token);
					}
				} else if (packet.t === 'VOICE_STATE_UPDATE') {
					const gateway = this.voiceGateways.get(packet.d.guild_id || packet.d.channel_id);
					if (gateway) {
						gateway.setSessionId(packet.d.session_id);
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
			compress: this.compress,
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
			this.zlib.inflate.flush(Zlib.constants.Z_FULL_FLUSH);
			this.zlib.chunks.length = 0;
			this.zlib.gatewayChunks.length = 0;
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
			if (!channelId) {return reject(new Error('ChannelId is required!'));}

			let gateway = this.voiceGateways.get(guildId || channelId);
			if (!gateway) {
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
				const promise = {resolve: res, reject: rej};
				gateway.waiting.add(promise);

				this.send(OpCodes.VOICE_STATE_UPDATE, {
					'guild_id': guildId,
					'channel_id': channelId,
					'self_mute': options.mute,
					'self_deaf': options.deafen
				});
			}).then(() => {
				if (timeout) {clearTimeout(timeout);}
				resolve(gateway);
			}).catch((e) => {
				if (timeout) {clearTimeout(timeout);}
				reject(e);
			});
		});
	}
}

module.exports = Gateway;