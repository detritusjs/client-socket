const BaseFeedback = require('./base');

//https://tools.ietf.org/html/rfc4585#section-6.3
class PSFB extends BaseFeedback {
	constructor(buffer) {
		super(buffer);

		if (this.isPLI) {
			//must contain only 1 PLI
		} else if (this.isSLI) {
			//must contain >=1 SLI
		} else if (this.isRPSI) {
			//must contain only 1 RPSI
		}
	}

	get isPLI() {return this.type === 1;}
	get isSLI() {return this.type === 2;}
	get isRPSI() {return this.type === 3;}
	get isAFB() {return this.type === 15;}
}

module.exports = PSFB;