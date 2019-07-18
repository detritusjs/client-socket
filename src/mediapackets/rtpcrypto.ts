export const CryptoModules = {
  SODIUM_NATIVE: 'sodium-native',
  TWEETNACL: 'tweetnacl',
};

const PCrypto: {
  available: {[key: string]: any},
  modules: Array<string>,
} = {
  available: {},
  modules: [
    CryptoModules.SODIUM_NATIVE,
    CryptoModules.TWEETNACL,
  ],
};

for (let name of PCrypto.modules) {
  try {
    PCrypto.available[name] = require(name);
  } catch(error) {
    continue;
  }
}

const defaultModule = PCrypto.modules.find((mod) => PCrypto.available[mod]);

export default {
  using: defaultModule,
  get module(): any {
    if (!defaultModule) {
      throw new Error(`For media (video/voice) packing/unpacking, please install one of: ${JSON.stringify(PCrypto.modules)}`);
    }
    return PCrypto.available[defaultModule];
  },
  generateNonce(
    cache?: Buffer | null,
  ): Buffer {
    const crypto = this.module;

    let nonce: Buffer;
    switch (defaultModule) {
      case CryptoModules.SODIUM_NATIVE: {
        nonce = cache || Buffer.alloc(crypto.crypto_secretbox_NONCEBYTES);
        crypto.randombytes_buf(nonce);
      }; break;
      case CryptoModules.TWEETNACL: {
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
      default: {
        throw new Error(`For media (video/voice) packing/unpacking, please install one of: ${JSON.stringify(PCrypto.modules)}`);
      };
    }
    return nonce;
  },
  encrypt(
    key: Uint8Array,
    data: Buffer,
    nonce: Buffer,
    cache?: Buffer | null,
  ): {
    length: number,
    packet: Buffer,
  } {
    const crypto = this.module;

    let length = 0;
    let packet: Buffer;
    switch (defaultModule) {
      case CryptoModules.SODIUM_NATIVE: {
        length += data.length + crypto.crypto_secretbox_MACBYTES;
        if (cache) {
          cache.fill(0, 0, length);
        }

        packet = cache || Buffer.alloc(length);
        crypto.crypto_secretbox_easy(packet, data, nonce, key);
      }; break;
      case CryptoModules.TWEETNACL: {
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
      default: {
        throw new Error(`For media (video/voice) packing/unpacking, please install one of: ${JSON.stringify(PCrypto.modules)}`);
      };
    }
    return {length, packet};
  },
  decrypt(
    key: Uint8Array,
    data: Buffer,
    nonce: Buffer,
  ): Buffer | null {
    const crypto = this.module;

    let packet: Buffer | null = null;
    switch (defaultModule) {
      case CryptoModules.SODIUM_NATIVE: {
        packet = Buffer.alloc(data.length - crypto.crypto_secretbox_MACBYTES);
        crypto.crypto_secretbox_open_easy(packet, data, nonce, key);
      }; break;
      case CryptoModules.TWEETNACL: {
        packet = crypto.secretbox.open(data, nonce, key);
        if (packet) {
          packet = Buffer.from(packet);
        }
      }; break;
    }
    return packet;
  },
}
