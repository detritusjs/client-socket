const PCrypto = {
	available: {},
	modules: ['sodium-native', 'tweetnacl']
};

for (let mod of PCrypto.modules) {
	try {
		PCrypto.available[mod] = require(mod);
	} catch (e) {continue;}
}

class PacketCrypto
{
	constructor(key, mod)
	{
		this.key = null;
		this.mod = null;

		this.setKey(key);
		this.setMod(mod || PCrypto.modules.find((m) => m in PCrypto.available));
	}

	get module()
	{
		if (!this.mod) {throw new Error('Module missing, cannot encrypt/decrypt.');}
		return PCrypto.available[this.mod];
	}

	setMod(mod)
	{
		if (!mod) {
			throw new Error(`For voice packing/unpacking, please install one of: ${JSON.stringify(PCrypto.modules)}`);
		}
		if (!PCrypto.modules.includes(mod)) {
			throw new Error(`Invalid module '${mod}', please use one of: ${JSON.stringify(PCrypto.modules)}`);
		}
		if (!(mod in PCrypto.available)) {
			throw new Error(`Module '${mod} is not installed, use one of: ${JSON.stringify(PCrypto.modules)}`);
		}
		this.mod = mod;
	}

	setKey(key)
	{
		//assume its an array passed in by the websocket
		if (!key) {return;}
		this.key = new Uint8Array(new ArrayBuffer(key.length));
		for (let i = 0; i < this.key.length; i++) {
			this.key[i] = key[i];
		}
	}

	generateNonce(cache)
	{
		let nonce;
		switch (this.mod) {
			case 'sodium-native': {
				nonce = cache || Buffer.alloc(this.module.crypto_secretbox_NONCEBYTES);
				this.module.randombytes_buf(nonce);
			}; break;
			case 'tweetnacl': {
				nonce = this.module.randomBytes(this.module.box.nonceLength);
				if (cache) {
					for (let i = 0; i < nonce.length; i++) {
						cache[i] = nonce[i];
					}
					nonce = cache;
				} else {
					nonce = Buffer.from(nonce);
				}
			}; break;
		}
		return nonce;
	}

	encrypt(buf, nonce, cache)
	{
		let length = 0;
		let packet;
		switch (this.mod) {
			case 'sodium-native': {
				length += buf.length + this.module.crypto_secretbox_MACBYTES;
				if (cache) {
					cache.fill(0, 0, length);
				}

				packet = cache || Buffer.alloc(length);
				this.module.crypto_secretbox_easy(packet, buf, nonce, this.key);
			}; break;
			case 'tweetnacl': {
				length += buf.length + this.module.secretbox.overheadLength;

				packet = this.module.secretbox(buf, nonce, this.key);
				if (packet) {
					if (cache) {
						cache.fill(0, 0, length);
						for (let i = 0; i < length; i++) {
							cache[i] = packet[i];
						}
						packet = cache;
					} else {
						packet = Buffer.from(packet);
					}
				}
			}; break;
		}
		return {packet, length};
	}

	decrypt(buf, nonce)
	{
		let packet;
		switch (this.mod) {
			case 'sodium-native': {
				packet = Buffer.alloc(buf.length - this.module.crypto_secretbox_MACBYTES);
				this.module.crypto_secretbox_open_easy(packet, buf, nonce, this.key);
			}; break;
			case 'tweetnacl': {
				packet = this.module.secretbox.open(buf, nonce, this.key);
				packet = packet && Buffer.from(packet);
			}; break;
		}
		return packet;
	}
}

module.exports = PacketCrypto;