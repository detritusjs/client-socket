class PacketRTP
{
	constructor(packet, mode)
	{
		this.buffer = packet;
		this.header = Buffer.alloc(24);
		this.buffer.copy(this.header, 0, 0, 12);

		this.sequence = this.header.readUIntBE(2, 2);
		this.timestamp = this.header.readUIntBE(4, 4);
		this.ssrc = this.header.readUIntBE(8, 4);

		switch (mode) {
			case 'xsalsa20_poly1305_lite': {
				this.nonce = Buffer.alloc(24);
				this.buffer.copy(this.nonce, 0, this.buffer.length - 4);
				this.data = this.buffer.slice(12, -4);
			}; break;
			case 'xsalsa20_poly1305_suffix': {
				this.nonce = Buffer.alloc(24);
				this.buffer.copy(this.nonce, 0, this.buffer.length - 24);
				this.data = this.buffer.slice(12, -24);
			}; break;
			case 'xsalsa20_poly1305': {
				this.nonce = this.header;
				this.data = this.buffer.slice(12);
			}; break;
			case undefined: {
				this.nonce = null;
				this.data = null;
			}; break;
			default: {
				throw new Error(`${mode} is not supported for decoding.`);
			};
		}
	}
}

module.exports = PacketRTP;