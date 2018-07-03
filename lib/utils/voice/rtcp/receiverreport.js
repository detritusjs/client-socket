const BaseReport = require('./basereport');

//https://tools.ietf.org/html/rfc3550#section-6.4.2
class ReceiverReport extends BaseReport {
	constructor(buffer) {
		super(buffer, 'receiver');
	}

	get sourceCount() {return this.firstByte & 0x1F;}
}

module.exports = ReceiverReport;