const BaseReport = require('./basereport');

//https://tools.ietf.org/html/rfc3550#section-6.4.1
class SenderReport extends BaseReport {
	constructor(buffer) {
		super(buffer, 'sender');
	}

	get mostNTPTimestamp() {return this.buffer.readUIntBE(8, 4);}//dunno
	get leastNTPTimestamp() {return this.buffer.readUIntBE(12, 4);}//dunno

	get rtpTimestamp() {return this.buffer.readUIntBE(16, 4);}

	get sendersPacketCount() {return this.buffer.readUIntBE(20, 4);}
	get sendersOctetCount() {return this.buffer.readUIntBE(24, 4);}
}

module.exports = SenderReport;