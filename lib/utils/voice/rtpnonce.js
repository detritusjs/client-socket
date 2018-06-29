const MaxNumbers = require('../constants').MaxNumbers;
const RTPCrypto = require('./rtpcrypto');

const defaults = {
	randomize: true
};

class RTPNonce {
	constructor(options) {
		Object.defineProperty(this, 'buffer', {value: Buffer.alloc(24)});

		options = Object.assign({}, defaults, options);
		if (options.randomize) {
			this.randomize();
		}
	}

	get number() {
		return this.buffer.readUIntBE(0, 4);
	}

	randomize() {
		return this.set(Math.round(Math.random() * MaxNumbers.UINT32));
	}

	copy(target, targetStart, sourceStart, sourceEnd) {
		return this.buffer.copy(target, targetStart, sourceStart, sourceEnd);
	}

	generate() {
		return RTPCrypto.generateNonce(this.buffer);
	}

	set(nonce, increment) {
		if (!Number.isInteger(nonce)) {
			nonce = 1;
			increment = true;
		}

		nonce = ((increment) ? (this.number + nonce) : nonce) % MaxNumbers.UINT32;
		this.buffer.writeUIntBE(nonce, 0, 4);
		return this.buffer;
	}
}

module.exports = RTPNonce;