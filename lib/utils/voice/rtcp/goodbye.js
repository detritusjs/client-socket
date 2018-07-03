const BaseRTCP = require('./base');

//https://tools.ietf.org/html/rfc3550#section-6.6
class Goodbye extends BaseRTCP {
	get sourceCount() {return this.firstByteEnd;}
}

module.exports = Goodbye;