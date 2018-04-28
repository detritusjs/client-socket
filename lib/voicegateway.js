const UrlUtils = require('url');

const Utils = require('./utils');
const BaseSocket = Utils.BaseSocket;
const Constants = Utils.Constants;
const OpCodes = Constants.OpCodes.Voice;

const VoiceUDP = require('./voiceudp');

const defaultOptions = {
	guildId: null,
	userId: null,
	sessionId: null,
	token: null
};

class VoiceGateway extends Utils.EventEmitter
{
	constructor(gateway, options)
	{
		super();

		this.gateway = gateway;
		this.socket = null;

		options = Object.assign({}, defaultOptions, options);
		Object.defineProperties(this, {
			serverId: {writable: false, value: options.serverId},
			userId: {writable: false, value: options.userId}
		});

		this.sessionId = null;
		this.token = null;
		
		this.bucket = new Utils.Bucket(120, 60 * 1000);
		this.endpoint = null;

		this._heartbeat = {
            ack: false,
            lastAck: null,
			interval: null,
			nonce: null
		};

		this.udp = null;

		this.ssrcs = {
			audio: new Map(),
			video: new Map()
		};

		this.waiting = new Set();

		this.ready = false;
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

	resolveWaiting(error)
	{
		for (let promise of this.waiting.values()) {
			this.waiting.delete(promise);
			if (error) {
				promise.reject(error);
			} else {
				promise.resolve();
			}
		}
		this.connect();
	}

	setEndpoint(endpoint)
	{
		this.endpoint = (endpoint) ? `wss://${endpoint.split(':').shift()}` : null;
	}

	setSessionId(sessionId)
	{
		this.sessionId = sessionId;
		if (this.token) {this.resolveWaiting();}
	}

	setToken(token)
	{
		this.token = token;
		if (this.sessionId && !this.identified) {this.resolveWaiting();}
	}

	send(op, d, cb, direct)
	{
		if (!this.connected) {return;}
		const packet = {op, d};

		let data;
		try {
			data = JSON.stringify(packet);
		} catch(e) {this.emit('error', e);}
		if (!data) {return;}

		if (direct) {
			this.socket.send(data, cb);
		} else {
			const func = () => {
				if (this.bucket.locked || !this.ready || !this.socket.connected) {
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

	decode(data)
    {
        try {
            return JSON.parse(data);
        } catch(e) {this.emit('error', e);}
    }

	identify()
	{
        this.send(OpCodes.IDENTIFY, {
			'server_id': this.serverId,
			'user_id': this.userId,
			'session_id': this.sessionId,
			'token': this.token
		}, undefined, true);
	}

	resume()
	{
		this.send(OpCodes.RESUME, {
			'server_id': this.serverId,
			'session_id': this.sessionId,
			'token': this.token
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
		this._heartbeat.nonce = Date.now();
        this.send(OpCodes.HEARTBEAT, this._heartbeat.nonce);
    }

    setHeartbeat(data)
    {
		if (!data || !data.heartbeat_interval) {return;}

		this._heartbeat.ack = true;
		if (this._heartbeat.interval) {
			clearInterval(this._heartbeat.interval);
		}
		this._heartbeat.interval = setInterval(() => {
			this.heartbeat(true);
		}, data.heartbeat_interval);
	}

	handle(data)
	{
		const packet = this.decode(data);
		if (!packet) {return;}

		this.emit('packet', packet);

        switch(packet.op) {
			case OpCodes.READY: {
				this.ready = true;
				this.bucket.unlock();
				this.udpConnect(packet.d);
				this.emit('ready');
				this.identified = true;
				console.log(packet);
			}; break;
			case OpCodes.SESSION_DESCRIPTION: {
				this.udp.crypto.setKey(packet.d.secret_key);
				this.udp.setMode(packet.d.mode);
				//audioCodec, mode, mediaSessionId, videoCodec, secretKey
			}; break;
			case OpCodes.SPEAKING: {
				this.ssrcs.audio.set(packet.d.ssrc, packet.d.user_id);
				console.log(packet);
				//use the bitmasks Constants.Voice.SPEAKING
				//emit it?
				//check to see if it already existed, if not, create decode/encoders
			}; break;
			case OpCodes.HEARTBEAT_ACK: {
				if (packet.d !== this._heartbeat.nonce) {
					this.disconnect(OpCodes.HEARTBEAT_ACK, 'Invalid nonce received by Heartbeat ACK');
					this.connect();
					return;
				}
				this._heartbeat.lastAck = Date.now();
				this._heartbeat.ack = true;
			}; break;
			case OpCodes.HELLO: {
				this.setHeartbeat(packet.d);
				if (this.identified) {
					this.resume();
				} else {
					this.identify();
				}
				this.heartbeat();
			}; break;
			case OpCodes.RESUMED: {
				this.ready = true;
				this.bucket.unlock();
				console.log('resumed correctly lol');
			}; break;
			case OpCodes.CLIENT_CONNECT: {
				this.ssrcs.audio.set(packet.d.audio_ssrc, packet.d.user_id);
				if (packet.d.video_ssrc) {
					this.ssrcs.video.set(packet.d.video_ssrc, packet.d.user_id);
				}
				console.log(packet);
				//start the user id's decode/encoders too
			}; break;
			case OpCodes.CLIENT_DISCONNECT: {
				Object.keys(this.ssrcs).forEach((ssrcType) => {
					const ssrcs = this.ssrcs[ssrcType];
					for (let key of ssrcs.keys()) {
						if (ssrcs.get(key) !== packet.d.user_id) {continue;}
						ssrcs.delete(key);
					}
				});
				console.log(packet);
				//cleanup the user id's decode/encoders too
			}; break;
			default: {console.log(packet);}
        }
	}

	connect(endpoint)
    {
		if (endpoint) {
			this.setEndpoint(endpoint);
		}

		const url = new UrlUtils.URL(this.endpoint);
		url.searchParams.set('v', Constants.ApiVersions.VOICE_GATEWAY);
		url.pathname = url.pathname || '/';
	
        const ws = this.socket = new BaseSocket(url.href);
        ws.on('message', (data) => {
			if (ws !== this.socket) {return;}
			this.handle(data);
		});

		ws.on('open', () => {
			if (ws !== this.socket) {return;} //shouldnt ever happen but whatever
			console.log(this.sessionId, this.token);
			this.emit('open');
			console.log('open');
			this.cleanup();
		});

		ws.on('close', (code, reason) => {
			if (ws !== this.socket) {return;}
			this.emit('close', {code, reason});

			if (code === 4006) {
				this.identified = false;
				this.sessionId = null;
			}

			this.cleanup();
		});

		ws.on('error', (error) => {
			this.emit('error', error);
			console.log('error', error);
		});
		
		if (this.udp) {
			this.udp.connect();
		}
	}

	cleanup()
	{
		this.ready = false;
		this.bucket.lock();

		this.ssrcs.audio.clear();
		this.ssrcs.video.clear();

		if (this._heartbeat.interval) {
			clearInterval(this._heartbeat.interval);
			this._heartbeat.interval = null;
		}

		if (this.udp) {
			this.udp.disconnect();
		}
	}
	
	disconnect(code, reason)
	{
		this.cleanup();

        if (this.connected) {
            if (code === OpCodes.RECONNECT || code === OpCodes.HEARTBEAT_ACK) {
                this.socket.close(4000, reason);
            } else {
                this.socket.close(code, reason);
			}

            //emit the disconnect
		}
	}

	udpConnect(udpinfo)
	{
		this.ssrcs.audio.set(udpinfo.ssrc, this.userId);
		
		if (this.udp) {
			this.udp.disconnect();
		} else {
			this.udp = new VoiceUDP(this);
		}

		for (let mode of udpinfo.modes) {
			if (Constants.Voice.MODES.includes(mode)) {
				udpinfo.mode = mode;
				break;
			}
		}
		if (!udpinfo.mode) {throw new Error(`No supported voice mode found in ${JSON.stringify(udpinfo.modes)}`)}

		this.udp.setSSRC(udpinfo.ssrc);
		this.udp.setMode(udpinfo.mode);
		//maybe store udpinfo.modes
		this.udp.connect(udpinfo.ip, udpinfo.port);
	}
}

module.exports = VoiceGateway;