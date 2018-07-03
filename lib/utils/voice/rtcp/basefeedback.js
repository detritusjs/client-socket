const BaseRTCP = require('./basertcp');

//https://tools.ietf.org/html/rfc4585#section-6.1
class BaseFeedback extends BaseRTCP {
	constructor(buffer) {
		super(buffer);
		Object.defineProperty(this, 'fci', {value: []});
	}

	get type() {return this.firstByteEnd;}
	get ssrcOfMediaSource() {return this.buffer.readUIntBE(8, 4);}
}

module.exports = BaseFeedback;