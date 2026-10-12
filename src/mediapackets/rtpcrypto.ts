import * as crypto from 'crypto';

import { CryptoModules, MediaEncryptionModes } from '../constants';

const PCrypto: {
  available: {[key: string]: any},
  modules: Array<CryptoModules>,
  using: CryptoModules | null,
} = {
  available: {},
  modules: [
    CryptoModules.SODIUM_NATIVE,
    CryptoModules.LIBSODIUM_WRAPPERS,
  ],
  using: null,
};
// order in preference, only needed for `aead_xchacha20_poly1305_rtpsize`

(async () => {
  for (let name of PCrypto.modules) {
    try {
      const module = PCrypto.available[name] = require(name);
      switch (name) {
        case CryptoModules.LIBSODIUM_WRAPPERS: {
          if (module.ready) {
            await module.ready;
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


export const AEAD_TAG_LENGTH = 16;
export const RTP_NONCE_LENGTH = 4;

const NonceLengths: {[key: string]: number} = Object.freeze({
  [MediaEncryptionModes.AEAD_AES256_GCM_RTPSIZE]: 12,
  [MediaEncryptionModes.AEAD_XCHACHA20_POLY1305_RTPSIZE]: 24,
});

function createNonce(mode: string, nonce: Buffer): Buffer {
  if (!(mode in NonceLengths)) {
    throw new Error(`${mode} is not a supported encryption mode`);
  }
  // the 32-bit incremental nonce sits at the start, the rest is zero-padded
  const buffer = Buffer.alloc(NonceLengths[mode]);
  nonce.copy(buffer, 0, 0, RTP_NONCE_LENGTH);
  return buffer;
}

export default {
  get using(): CryptoModules | null {
    return PCrypto.using;
  },
  get module(): any {
    return (PCrypto.using) ? PCrypto.available[PCrypto.using] : null;
  },
  isModeAvailable(mode: MediaEncryptionModes | string): boolean {
    switch (mode) {
      case MediaEncryptionModes.AEAD_AES256_GCM_RTPSIZE: {
        return crypto.getCiphers().includes('aes-256-gcm');
      };
      case MediaEncryptionModes.AEAD_XCHACHA20_POLY1305_RTPSIZE: {
        return !!PCrypto.using;
      };
    }
    return false;
  },
  /**
   * Encrypts `data` using `header` as the additional data
   * Returns the ciphertext with the auth tag appended (the 4 byte nonce still has to be appended to the packet)
   */
  encrypt(
    mode: MediaEncryptionModes | string,
    key: Uint8Array,
    header: Buffer,
    data: Buffer,
    nonce: Buffer,
  ): Buffer {
    const fullNonce = createNonce(mode, nonce);
    switch (mode) {
      case MediaEncryptionModes.AEAD_AES256_GCM_RTPSIZE: {
        const cipher = crypto.createCipheriv('aes-256-gcm', key, fullNonce);
        cipher.setAAD(header);
        return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
      };
      case MediaEncryptionModes.AEAD_XCHACHA20_POLY1305_RTPSIZE: {
        const sodium = this.module;
        switch (this.using) {
          case CryptoModules.SODIUM_NATIVE: {
            const packet = Buffer.alloc(data.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
            sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(packet, data, header, null, fullNonce, key);
            return packet;
          };
          case CryptoModules.LIBSODIUM_WRAPPERS: {
            const packet: Uint8Array = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(data, header, null, fullNonce, key);
            return Buffer.from(packet);
          };
        }
        throw new Error(`For ${mode}, please install one of: ${JSON.stringify(PCrypto.modules)}`);
      };
    }
    throw new Error(`${mode} is not supported for encoding.`);
  },
  /**
   * Decrypts `data` (ciphertext with the auth tag appended) using `header` as the additional data
   * Returns null if the packet failed to authenticate
   */
  decrypt(
    mode: MediaEncryptionModes | string,
    key: Uint8Array,
    header: Buffer,
    data: Buffer,
    nonce: Buffer,
  ): Buffer | null {
    if (data.length < AEAD_TAG_LENGTH) {
      return null;
    }
    const fullNonce = createNonce(mode, nonce);
    try {
      switch (mode) {
        case MediaEncryptionModes.AEAD_AES256_GCM_RTPSIZE: {
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, fullNonce);
          decipher.setAAD(header);
          decipher.setAuthTag(data.subarray(data.length - AEAD_TAG_LENGTH));
          return Buffer.concat([decipher.update(data.subarray(0, data.length - AEAD_TAG_LENGTH)), decipher.final()]);
        };
        case MediaEncryptionModes.AEAD_XCHACHA20_POLY1305_RTPSIZE: {
          const sodium = this.module;
          switch (this.using) {
            case CryptoModules.SODIUM_NATIVE: {
              const packet = Buffer.alloc(data.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
              sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(packet, null, data, header, fullNonce, key);
              return packet;
            };
            case CryptoModules.LIBSODIUM_WRAPPERS: {
              const packet: Uint8Array = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, data, header, fullNonce, key);
              return Buffer.from(packet);
            };
          }
        }; break;
      }
    } catch(error) {
      // failed authentication
    }
    return null;
  },
}
