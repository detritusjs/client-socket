import { CryptoModules } from '../constants';

const PCrypto: {
  available: {[key: string]: any},
  modules: Array<CryptoModules>,
  using: CryptoModules | null,
} = {
  available: {},
  modules: [
    CryptoModules.SODIUM,
    CryptoModules.LIBSODIUM_WRAPPERS,
    CryptoModules.TWEETNACL,
  ],
  using: null,
};
// order in preference

(async () => {
  for (let name of PCrypto.modules) {
    try {
      const crypto = PCrypto.available[name] = require(name);
      switch (name) {
        case CryptoModules.LIBSODIUM_WRAPPERS: {
          if (crypto.ready) {
            await crypto.ready;
          }
        }; break;
      }
      break;
    } catch(error) {
      continue;
    }
  }
  PCrypto.using = PCrypto.modules.find((mod) => (mod in PCrypto.available)) || null;
})();


function Uint8ArrayToBuffer(array: Uint8Array, cache?: Buffer | null): Buffer {
  if (cache) {
    for (let i = 0; i < array.length; i++) {
      cache[i] = array[i];
    }
    return cache;
  }
  return Buffer.from(array);
}

export default {
  get using(): CryptoModules {
    if (!PCrypto.using) {
      throw new Error(`For media (video/voice) packing/unpacking, please install one of: ${JSON.stringify(PCrypto.modules)}`);
    }
    return PCrypto.using;
  },
  get module(): any {
    const crypto = PCrypto.available[this.using];
    switch (this.using) {
      case CryptoModules.SODIUM: {
        return crypto.api;
      };
    }
    return crypto;
  },
  generateNonce(cache?: Buffer | null): Buffer {
    const crypto = this.module;

    let nonce: Buffer;
    switch (this.using) {
      case CryptoModules.LIBSODIUM_WRAPPERS: {
        const generated: Uint8Array = crypto.randombytes_buf(crypto.crypto_secretbox_NONCEBYTES);
        nonce = Uint8ArrayToBuffer(generated, cache);
      }; break;
      case CryptoModules.SODIUM: {
        nonce = cache || Buffer.alloc(crypto.crypto_secretbox_NONCEBYTES);
        crypto.randombytes_buf(nonce);
      }; break;
      case CryptoModules.TWEETNACL: {
        const generated: Uint8Array = crypto.randomBytes(crypto.box.nonceLength);
        nonce = Uint8ArrayToBuffer(generated, cache);
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
    switch (this.using) {
      case CryptoModules.LIBSODIUM_WRAPPERS: {
        length += data.length + crypto.crypto_secretbox_MACBYTES;
        if (cache) {
          cache.fill(0, 0, length);
        }
        const generated: Uint8Array = crypto.crypto_secretbox_easy(data, nonce, key);
        packet = Uint8ArrayToBuffer(generated, cache);
      }; break;
      case CryptoModules.SODIUM: {
        length += data.length + crypto.crypto_secretbox_MACBYTES;
        if (cache) {
          cache.fill(0, 0, length);
        }
        packet = crypto.crypto_secretbox_easy(data, nonce, key);
        if (cache) {
          packet.copy(cache);
          packet = cache;
        }
      }; break;
      case CryptoModules.TWEETNACL: {
        length += data.length + crypto.secretbox.overheadLength;

        const generated: Uint8Array = crypto.secretbox(data, nonce, key);
        packet = Uint8ArrayToBuffer(generated, cache);
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
    switch (this.using) {
      case CryptoModules.LIBSODIUM_WRAPPERS: {
        const generated: null | Uint8Array = crypto.crypto_secretbox_open_easy(data, nonce, key);
        if (generated) {
          packet = Uint8ArrayToBuffer(generated);
        }
      }; break;
      case CryptoModules.SODIUM: {
        packet = crypto.crypto_secretbox_open_easy(data, nonce, key);
      }; break;
      case CryptoModules.TWEETNACL: {
        const generated: null | Uint8Array = crypto.secretbox.open(data, nonce, key);
        if (generated) {
          packet = Uint8ArrayToBuffer(generated);
        }
      }; break;
    }
    return packet;
  },
}
