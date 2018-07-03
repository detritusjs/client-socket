class VP8Descriptor {
	constructor(buffer) {
		Object.defineProperty(this, 'buffer', {value: buffer});
	}

	get firstByte() {return this.buffer.readUIntBE(0, 1);}
	get secondByte() {return this.buffer.readUIntBE(1, 1);}
	get thirdByte() {return this.buffer.readUIntBE(2, 1);}
	get fourthByte() {return this.buffer.readUIntBE(3, 1);}
	get fifthByte() {return this.buffer.readUIntBE(4, 1);}
	get sixthByte() {return this.buffer.readUIntBE(5, 1);}

	get extendedControl() {return this.firstByte >> 7;}
	//get reserved() {return (this.firstByte >> 6) & 1;}
	get nonReferenced() {return (this.firstByte >> 5) & 1;}
	get start() {return (this.firstByte >> 4) & 1;}
	//get reserved() {return (this.firstByte >> 3) & 1;}
	get partitionIndex() {return this.firstByte & 0x7;}

	get pictureIdPresent() {return this.secondByte >> 7;}
	get tl0picIdxPresent() {return (this.secondByte >> 6) & 1;}
	get tidPresent() {return (this.secondByte >> 5) & 1;}
	get keyIdxPresent() {return (this.secondByte >> 4) & 1;}
	get rsv() {return this.secondByte & 0x0F;}

	get m() {return this.thirdByte >> 7;}
	get pictureId() {return this.thirdByte & 0x7F;}

	get tl0picIdx() {return this.fourthByte;}

	get tid() {return this.fifthByte >> 6;}
	get y() {return (this.fifthByte >> 5) & 1;}
	get keyIdx() {return this.fifthByte & 0x1F;}
}

class VP8Header {
	constructor(buffer) {
		Object.defineProperty(this, 'buffer', {value: buffer});
	}

	get firstByte() {return this.buffer.readUIntBE(0, 1);}
	get secondByte() {return this.buffer.readUIntBE(1, 1);}
	get thirdByte() {return this.buffer.readUIntBE(2, 1);}

	get size0() {return this.firstByte >> 5;}
	get h() {return (this.firstByte >> 4) & 1;}
	get version() {return (this.firstByte >> 1) & 0x7;}
	get isKeyFrame() {return this.firstByte & 1;}

	get size1() {return this.secondByte;}
	get size2() {return this.thirdByte;}
}

//rfc7741 section-4.1
class VP8Payload {
	constructor(payload) {
		Object.defineProperties(this, {
			descriptor: {value: new VP8Descriptor(payload.slice(0, 6))},
			header: {value: new VP8Header(payload.slice(6, 9))},
			payload: {value: payload.slice(9)},
			buffer: {value: payload}
		});
	}
}

module.exports = VP8Payload;