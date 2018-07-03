const BaseFeedback = require('./base');

//https://tools.ietf.org/html/rfc4585#section-6.2
class RTPFB extends BaseFeedback {
	constructor(buffer) {
		super(buffer);

		if (this.isNack) {
			for (let i = 12; i < this.buffer.length; i += 4) {
				const field = new NackField(this, this.buffer.slice(i, i + 4));
				this.fci.push(field);
			}
		}
	}

	get isNack() {return this.type === 1;}
}

class NackField {
	constructor(rtpfb, buffer) {
		Object.defineProperty(this, {
			rtpfb: {value: rtpfb},
			buffer: {value: buffer}
		});
		//bitmask is 2-4, https://tools.ietf.org/html/rfc4585#section-6.2.1
	}

	get packetId() {return this.buffer.readUIntBE(0, 2);}
	get bitmask() {return this.buffer.readUIntBE(2, 2);}
}

module.exports = RTPFB;