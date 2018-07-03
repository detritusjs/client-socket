const BaseRTCP = require('./base');

//https://tools.ietf.org/html/rfc3550#section-6.5
class SourceDescription extends BaseRTCP {
	constructor(buffer) {
		super(buffer);

		Object.defineProperty(this, 'chunks', {value: []});

		let offset = 8;
		for (let i = 0; i < this.sourceCount; i++) {
			const buffer = this.buffer.slice(offset);
			//get item and add to the offset
		}
	}

	get sourceCount() {return this.firstByteEnd;}
}

class SourceChunk {
	constructor(sourceDescription, buffer, items) {
		Object.defineProperties(this, {
			sourceDescription: {value: sourceDescription},
			buffer: {value: buffer},
			items: {value: items}
		});
	}

	get ssrc() {return this.buffer.readUIntBE(0, 4);}
	get csrc() {return this.ssrc;}
}

module.exports = SourceDescription;