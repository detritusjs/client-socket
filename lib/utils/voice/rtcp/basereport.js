const BaseRTCP = require('./base');

//https://tools.ietf.org/html/rfc3550#section-6.4
class BaseReport extends BaseRTCP {
	constructor(buffer, type) {
		super(buffer);
		Object.defineProperty(this, 'reportBlocks', {value: []});

		const blockOffset = (type === 'sender') ? 28 : 8;
		const blocks = this.buffer.slice(blockOffset);
		for (let i = 0; i < blocks.length; i += 24) {
			const block = new ReportBlock(this, blocks.slice(i, i + 24));
			this.reportBlocks.push(block);
		}
	}

	get receptionReportCount() {return this.firstByte & 0x1F;}
}

class ReportBlock {
	constructor(report, buffer) {
		Object.defineProperties(this, {
			report: {value: report},
			buffer: {value: buffer}
		});
	}

	get ssrc() {return this.buffer.readUIntBE(0, 4);}

	get fractionsLost() {return this.buffer.readUIntBE(4, 1);}
	get packetsLost() {return this.buffer.readUIntBE(5, 3);}

	//low 16 bits, high 16 bits
	get extendedHighestSequenceNumber() {return this.buffer.readUIntBE(8, 4);}

	get interarrivalJitter() {return this.buffer.readUIntBE(12, 4);}

	get lastSenderReportTimestamp() {return this.buffer.readUIntBE(16, 4);}

	get delaySinceLastSenderReport() {return this.buffer.readUIntBE(20, 4);}
}

module.exports = BaseReport;