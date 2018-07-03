class RTCPPacket {
	constructor(buffer) {
		Object.defineProperty(this, 'buffer', {value: buffer});
	}

	get firstByte() {return this.buffer.readUIntBE(0, 1);}

	get version() {return this.firstByte >> 6;}
	get padding() {return (this.firstByte >> 5) & 1;}

	get firstByteEnd() {return this.firstByte & 0x1F;}

	get packetType() {return this.buffer.readUIntBE(1, 1);}
	get length() {return this.buffer.readUIntBE(2, 2);}
	get ssrc() {return this.buffer.readUIntBE(4, 4);}
}

module.exports = RTCPPacket;