const Utils = require('detritus-utils');

module.exports = Object.assign({}, Utils, {
	BaseSocket: require('./basesocket'),
	Constants: require('./constants'),
	Decompressor: require('./decompressor'),
	Voice: require('./voice')
});