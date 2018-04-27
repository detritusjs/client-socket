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

    get connected()
    {
        return this.OPEN;
    }

    get connecting()
    {
        return this.CONNECTING;
	}
	
	get closed()
	{
		return this.CLOSED;
	}

	get closing()
	{
		return this.CLOSING;
	}

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
}

module.exports = BaseSocket;