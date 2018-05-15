'use strict';

const Dependencies = {
	WebSocket: null
};

const sockets = ['ws', 'uws'];
sockets.forEach((dependency) => {
	try {
		Dependencies.WebSocket = require(dependency);
	} catch(e) {}
});

if (!Dependencies.WebSocket) {
	throw new Error(`Missing a WebSocket Dependency, pick one: ${JSON.stringify(sockets)}`);
}

const Constants = require('./constants');

class BaseSocket extends Dependencies.WebSocket
{
    constructor(url)
    {
        super(url, {});
		
		this.pings = new Map();

		this.on('pong', (data) => {
			try {
				data = JSON.parse(data.toString());
				if (this.pings.has(data.nonce)) {
					this.pings.get(data.nonce).resolve();
					this.pings.delete(data.nonce);
				}
			} catch(e) {} //malformed ping?
		});
    }

	get connected() {return this.readyState === this.OPEN;}
	get connecting() {return this.readyState === this.CONNECTING;}
	get closed() {return this.readyState === this.CLOSED;}
	get closing() {return this.readyState === this.CLOSING;}

    send(data, cb)
    {
		if (!this.connected) {return;}
		return super.send.call(this, data, {}, cb);
    }

    close(code, reason)
    {
		if (!this.connected) {return;}
		super.close.call(this, code, reason);

        //cleanup here
	}
	
	ping(timeout)
	{
		if (timeout === undefined) {timeout = 1000;}

		return new Promise((resolve, reject) => {
			if (!this.connected) {return reject(new Error('Socket isn\'t connected.'));}
			const data = {nonce: `${Date.now()}.${Math.random().toString(36)}`};

			let expire;
			if (expire) {
				expire = setTimeout(() => {
					reject(new Error(`Pong took longer than ${timeout}ms.`));
					this.socket.pings.delete(data.nonce);
				}, timeout);
			}

			const now = Date.now();
			return new Promise((res, rej) => {
				this.pings.set(data.nonce, {resolve: res});
				super.ping.call(this, JSON.stringify(data));
			}).then(() => {
				if (expire) {clearTimeout(expire);}
				resolve(Math.round(Date.now() - now));
			});
		});
	}
}

module.exports = BaseSocket;