const PacketTypes = require('../../constants').Voice.Packet.RTCPHeader.PacketTypes;

const BaseRTCP = require('./base');

const RTCP = {
	SenderReport: require('./senderreport'),
	ReceiverReport: require('./receiverreport'),
	SourceDescription: require('./sourcedescription'),
	Goodbye: require('./goodbye'),
	APP: require('./app'),
	RTPFB: require('./rtpfb'),
	PSFB: require('./psfb')
};

RTCP.create = function(buffer) {
	const packetType = buffer.readUIntBE(1, 1);

	let RTCPPacket = BaseRTCP;
	switch (packetType) {
		case PacketTypes.SENDER_REPORT: RTCPPacket = RTCP.SenderReport; break;
		case PacketTypes.RECEIVER_REPORT: RTCPPacket = RTCP.ReceiverReport; break;
		case PacketTypes.SOURCE_DESCRIPTION: RTCPPacket = RTCP.SourceDescription; break;
		case PacketTypes.BYE: RTCPPacket = RTCP.Goodbye; break;
		case PacketTypes.APP: RTCPPacket = RTCP.APP; break;
		case PacketTypes.RTPFB: RTCPPacket = RTCP.RTPFB; break;
		case PacketTypes.PSFB: RTCPPacket = RTCP.PSFB; break;
	}
	
	return new RTCPPacket(buffer);
};

module.exports = RTCP;