// "expand 32-byte k", the chacha constants
const SIGMA_0 = 0x61707865;
const SIGMA_1 = 0x3320646e;
const SIGMA_2 = 0x79622d32;
const SIGMA_3 = 0x6b206574;

export const HCHACHA20_KEY_LENGTH = 32;
export const HCHACHA20_NONCE_LENGTH = 16;
export const HCHACHA20_OUTPUT_LENGTH = 32;

// reused for every call, it's all synchronous
const state = new Uint32Array(16);

function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function quarterRound(a: number, b: number, c: number, d: number): void {
  state[a] += state[b]; state[d] = rotl(state[d] ^ state[a], 16);
  state[c] += state[d]; state[b] = rotl(state[b] ^ state[c], 12);
  state[a] += state[b]; state[d] = rotl(state[d] ^ state[a], 8);
  state[c] += state[d]; state[b] = rotl(state[b] ^ state[c], 7);
}

/**
 * HChaCha20 (draft-irtf-cfrg-xchacha), turns a key and the first 16 bytes of an xchacha20 nonce into the key
 * that regular chacha20 is then used with. Node's crypto has chacha20-poly1305 but not this step
 * Writes the 32 byte key into `output`
 */
export function hchacha20(
  key: Uint8Array,
  nonce: Uint8Array,
  output: Buffer,
): Buffer {
  if (key.length !== HCHACHA20_KEY_LENGTH) {
    throw new Error(`HChaCha20 needs a ${HCHACHA20_KEY_LENGTH} byte key`);
  }
  if (nonce.length < HCHACHA20_NONCE_LENGTH) {
    throw new Error(`HChaCha20 needs a ${HCHACHA20_NONCE_LENGTH} byte nonce`);
  }

  state[0] = SIGMA_0;
  state[1] = SIGMA_1;
  state[2] = SIGMA_2;
  state[3] = SIGMA_3;
  // little endian words
  for (let i = 0; i < 8; i++) {
    const offset = i * 4;
    state[4 + i] = key[offset] | (key[offset + 1] << 8) | (key[offset + 2] << 16) | (key[offset + 3] << 24);
  }
  for (let i = 0; i < 4; i++) {
    const offset = i * 4;
    state[12 + i] = nonce[offset] | (nonce[offset + 1] << 8) | (nonce[offset + 2] << 16) | (nonce[offset + 3] << 24);
  }

  // 20 rounds, a column round then a diagonal round each time
  for (let i = 0; i < 10; i++) {
    quarterRound(0, 4, 8, 12);
    quarterRound(1, 5, 9, 13);
    quarterRound(2, 6, 10, 14);
    quarterRound(3, 7, 11, 15);
    quarterRound(0, 5, 10, 15);
    quarterRound(1, 6, 11, 12);
    quarterRound(2, 7, 8, 13);
    quarterRound(3, 4, 9, 14);
  }

  // unlike chacha20 the starting state isn't added back, the key is the first and last rows
  for (let i = 0; i < 4; i++) {
    output.writeUInt32LE(state[i], i * 4);
    output.writeUInt32LE(state[12 + i], 16 + i * 4);
  }
  return output;
}
