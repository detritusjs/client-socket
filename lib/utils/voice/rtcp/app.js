const BaseRTCP = require('./base');

//https://tools.ietf.org/html/rfc3550#section-6.7
class APP extends BaseRTCP {
	get subtype() {return this.firstByteEnd;}

	get name() {return String.fromCharCode(this.readUIntBE(8, 4));}
}

module.exports = APP;