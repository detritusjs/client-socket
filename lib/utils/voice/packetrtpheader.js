const MAX = require('../constants').MAX;

class PacketRTPHeader
{
    constructor(type, version)
    {
        this.buffer = Buffer.alloc(24);

        this.nonce = {
			number: 0,
			buffer: Buffer.alloc(24)
		};

		this.type = type;
		this.version = version;

        this.sequence = 0;
        this.timestamp = 0;
		this.ssrc = 0;

		this.setup();
	}
	
	setup()
	{
		this.buffer.fill(0);
		this.buffer[0] = this.type;
		this.buffer[1] = this.version;

		this.nonce.number = 0;
		this.nonce.buffer.fill(0);

		this.sequence = Math.round(Math.random() * MAX.UINT16);
        this.timestamp = Math.round(Math.random() * MAX.UINT32);
	}

    setNonce(nonce, add)
    {
		if (nonce === undefined || nonce === null) {
			nonce = 1;
			add = true;
		}
        if (add) {
            this.nonce.number = (this.nonce.number + nonce) % MAX.UINT32;
        } else {
            this.nonce.number = nonce % MAX.UINT32;
		}

		this.nonce.buffer.writeUIntBE(this.nonce.number, 0, 4);
    }

    setSequence(sequence, add)
    {
		if (sequence === undefined || sequence === null) {
			sequence = 1;
			add = true;
		}
        if (add) {
            this.sequence = (this.sequence + sequence) % MAX.UINT16;
        } else {
            this.sequence = sequence % MAX.UINT16;
        }

        this.buffer.writeUIntBE(this.sequence, 2, 2);
    }

    setTimestamp(timestamp, add)
    {
		if (timestamp === undefined || timestamp === null) {
			timestamp = Date.now();
			add = false;
		}

        if (add) {
            this.timestamp = (this.timestamp + timestamp) % MAX.UINT32;
        } else {
            this.timestamp = timestamp % MAX.UINT32;
        }

        this.buffer.writeUIntBE(this.timestamp, 4, 4);
    }

    setSSRC(ssrc)
    {
        if (ssrc > MAX.UINT32) {throw new Error(`SSRC is over ${MAX.UINT32}`);}
        this.ssrc = ssrc;

        this.buffer.writeUIntBE(this.ssrc, 8, 4);
    }
}

module.exports = PacketRTPHeader;