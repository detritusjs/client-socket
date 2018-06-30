const Inflate = {
	type: 'zlib',
	module: require('zlib')
};

Inflate.flushCode = Inflate.module.constants.Z_SYNC_FLUSH;

try {
	Inflate.module = require('pako');
	Inflate.type = 'pako';
} catch(e) {}

const EventEmitter = require('./eventemitter');

class Decompressor extends EventEmitter {
	constructor(suffix, chunkSize) {
		super();

		this.suffix = suffix;
		this.chunkSize = chunkSize || 64 * 1024;

		this.closed = false;
		this.flushing = false;

		this.chunks = [];
		this.dataChunks = [];

		this.inflate = null;
		this.initialize();
	}

	initialize() {
		switch (Inflate.type) {
			case 'zlib': {
				this.inflate = Inflate.module.createInflate({flush: Inflate.flushCode, chunkSize: this.chunkSize});
				this.inflate.on('data', this.onData.bind(this));
				this.inflate.on('error', this.onError.bind(this));
			}; break;
			case 'pako': {
				this.inflate = new Inflate.module.Inflate({chunkSize: this.chunkSize});
			}; break;
		}
		this.chunks.length = 0;
		this.dataChunks.length = 0;
		this.flushing = false;
		this.closed = false;
	}

	close() {
		this.closed = true;
		this.chunks.length = 0;
		this.dataChunks.length = 0;
		this.flushing = false;
		switch (Inflate.type) {
			case 'zlib': {
				this.inflate.close();
				this.inflate.removeAllListeners('data');
			}; break;
		}
		this.inflate = null;
	}

	reset() {
		this.close();
		this.initialize();
	}

	onData(data) {
		switch (Inflate.type) {
			case 'zlib': this.dataChunks.push(data); break;
			case 'pako': this.emit('data', Buffer.from(data)); break;
		}
	}

	onError(error) {
		if (error.code === 'ERR_ZLIB_BINDING_CLOSED') {return;} //zlib was flushing when we called .close on it
		this.emit('error', error);
	}

	onFlush(error) {
		if (error) {return;}

		if (this.dataChunks.length) {
			this.emit('data', (this.dataChunks.length === 1) ? this.dataChunks.shift() : Buffer.concat(this.dataChunks));
		}

		this.dataChunks.length = 0;
		this.flushing = false;

		this.write();
	}

	add(chunk) {
		if (this.closed || !this.inflate) {return;}

		this.chunks.push(chunk);
		this.write();
	}

	write() {
		if (this.closed || !this.inflate || !this.chunks.length || this.flushing) {return;}

		const chunk = this.chunks.shift();
		const isEnd = (chunk.length >= this.suffix.length && chunk.slice(-this.suffix.length).equals(this.suffix));

		switch (Inflate.type) {
			case 'zlib': {
				this.inflate.write(chunk);
				if (isEnd) {
					this.flushing = true;
					this.inflate.flush(Inflate.flushCode, this.onFlush.bind(this));
					return;
				}
			}; break;
			case 'pako': {
				this.inflate.push(chunk, isEnd && Inflate.flushCode);
				if (isEnd) {
					if (this.inflate.err) {
						const error = new Error(this.inflate.msg);
						error.code = this.inflate.err;
						this.onError(error);
					} else {
						this.onData(this.inflate.result);
					}
				}
			}; break;
		}

		this.write();
	}
}

module.exports = Decompressor;