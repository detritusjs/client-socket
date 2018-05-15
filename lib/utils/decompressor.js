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

class Decompressor extends EventEmitter
{
	constructor(suffix, chunkSize)
	{
		super();

		chunkSize = chunkSize || 64 * 1024;

		this.suffix = suffix;

		this.inflate = null;
		switch (Inflate.type) {
			case 'zlib': {
				this.inflate = Inflate.module.createInflate({flush: Inflate.flushCode, chunkSize});
				this.inflate.on('data', this.onData.bind(this));
				this.inflate.on('error', this.onError.bind(this));
			}; break;
			case 'pako': {
				this.inflate = new Inflate.module.Inflate({chunkSize});
			}; break;
		}

		this.flushing = false;

		this.chunks = [];
		this.dataChunks = [];
	}

	onData(data)
	{
		switch (Inflate.type) {
			case 'zlib': this.dataChunks.push(data); break;
			case 'pako': this.emit('data', Buffer.from(data)); break;
		}
	}

	onError(error) {this.emit('error', error);}

	onFlush(error)
	{
		if (error) {
			this.emit('error', error);
		} else {
			if (this.dataChunks.length) {
				this.emit('data', (this.dataChunks.length === 1) ? this.dataChunks.shift() : Buffer.concat(this.dataChunks));
			}
		}

		this.dataChunks.length = 0;

		this.flushing = false;

		this.write();
	}

	add(chunk)
	{
		this.chunks.push(chunk);
		this.write();
	}

	write()
	{
		if (!this.chunks.length) {return;}
		if (this.flushing) {return;}

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
						this.onError(this.inflate.err);
					} else {
						this.onData(this.inflate.result);
					}
				}
			}; break;
		}

		this.write();
	}

	close()
	{
		this.cleanup();
		switch (Inflate.type) {
			case 'zlib': this.inflate.close(); break;
		}
	}

	cleanup()
	{
		this.chunks.length = 0;
		this.dataChunks.length = 0;

		switch (Inflate.type) {
			case 'zlib': this.inflate.flush(Inflate.flushCode, this.write.bind(this)); break;
		}
	}
}

module.exports = Decompressor;