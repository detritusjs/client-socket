const PCrypto = {
	available: {},
	modules: ['sodium-native', 'tweetnacl']
};

for (let mod of PCrypto.modules) {
	try {
		PCrypto.available[mod] = require(mod);
	} catch (e) {continue;}
}

const defaultModule = PCrypto.modules.find((mod) => PCrypto.available[mod]);

module.exports = {
	using: defaultModule,
	get module() {
		if (!defaultModule) {
			throw new Error(`For voice packing/unpacking, please install one of: ${JSON.stringify(PCrypto.modules)}`);
		}
		return PCrypto.available[defaultModule];
	},
	generateNonce(cache) {
		const crypto = this.module;

		let nonce;
		switch (defaultModule) {
			case 'sodium-native': {
				nonce = cache || Buffer.alloc(crypto.crypto_secretbox_NONCEBYTES);
				crypto.randombytes_buf(nonce);
			}; break;
			case 'tweetnacl': {
				nonce = crypto.randomBytes(crypto.box.nonceLength);
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
	},
	encrypt(key, data, nonce, cache) {
		const crypto = this.module;

		let length = 0, packet;
		switch (defaultModule) {
			case 'sodium-native': {
				length += data.length + crypto.crypto_secretbox_MACBYTES;
				if (cache) {
					cache.fill(0, 0, length);
				}

				packet = cache || Buffer.alloc(length);
				crypto.crypto_secretbox_easy(packet, data, nonce, key);
			}; break;
			case 'tweetnacl': {
				length += data.length + crypto.secretbox.overheadLength;

				packet = crypto.secretbox(data, nonce, key);
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
	},
	decrypt(key, data, nonce) {
		const crypto = this.module;

		let packet;
		switch (defaultModule) {
			case 'sodium-native': {
				packet = Buffer.alloc(data.length - crypto.crypto_secretbox_MACBYTES);
				crypto.crypto_secretbox_open_easy(packet, data, nonce, key);
			}; break;
			case 'tweetnacl': {
				packet = crypto.secretbox.open(data, nonce, key);
				packet = packet && Buffer.from(packet);
			}; break;
		}
		return packet;
	}
};