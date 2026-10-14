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

// one zero-padded scratch nonce per mode, every encrypt/decrypt is synchronous so they can be reused for every packet
const NonceBuffers: {[key: string]: Buffer} = {
  [MediaEncryptionModes.AEAD_AES256_GCM_RTPSIZE]: Buffer.alloc(NonceLengths[MediaEncryptionModes.AEAD_AES256_GCM_RTPSIZE]),
  [MediaEncryptionModes.AEAD_XCHACHA20_POLY1305_RTPSIZE]: Buffer.alloc(NonceLengths[MediaEncryptionModes.AEAD_XCHACHA20_POLY1305_RTPSIZE]),
};

function createNonce(mode: string, nonce: Buffer): Buffer {
  const buffer = NonceBuffers[mode];
  if (!buffer) {
    throw new Error(`${mode} is not a supported encryption mode`);
  }
  // the 32-bit incremental nonce sits at the start, the rest stays zero-padded
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
   * Builds the whole rtpsize packet in one buffer: `header | encrypted data + auth tag | 4 byte nonce`
   */
  encryptPacket(
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
        const encrypted = cipher.update(data);
        // gcm never has anything left over in final(), it's only needed for the auth tag
        cipher.final();
        const tag = cipher.getAuthTag();

        const packet = Buffer.allocUnsafe(header.length + encrypted.length + tag.length + RTP_NONCE_LENGTH);
        let offset = header.copy(packet, 0);
        offset += encrypted.copy(packet, offset);
        offset += tag.copy(packet, offset);
        nonce.copy(packet, offset, 0, RTP_NONCE_LENGTH);
        return packet;
      };
      case MediaEncryptionModes.AEAD_XCHACHA20_POLY1305_RTPSIZE: {
        if (this.using === CryptoModules.SODIUM_NATIVE) {
          const sodium = this.module;
          const encryptedLength = data.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
          const packet = Buffer.allocUnsafe(header.length + encryptedLength + RTP_NONCE_LENGTH);
          header.copy(packet, 0);
          // encrypt straight into the packet
          sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            packet.subarray(header.length, header.length + encryptedLength),
            data,
            header,
            null,
            fullNonce,
            key,
          );
          nonce.copy(packet, header.length + encryptedLength, 0, RTP_NONCE_LENGTH);
          return packet;
        }
        const encrypted = this.encrypt(mode, key, header, data, nonce);
        return Buffer.concat([header, encrypted, nonce.subarray(0, RTP_NONCE_LENGTH)]);
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
          const decrypted = decipher.update(data.subarray(0, data.length - AEAD_TAG_LENGTH));
          // throws if the auth tag doesn't match, gcm never has anything left over in it
          decipher.final();
          return decrypted;
        };
        case MediaEncryptionModes.AEAD_XCHACHA20_POLY1305_RTPSIZE: {
          const sodium = this.module;
          switch (this.using) {
            case CryptoModules.SODIUM_NATIVE: {
              const packet = Buffer.allocUnsafe(data.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
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
