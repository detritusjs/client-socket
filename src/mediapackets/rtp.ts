import { MaxNumbers } from '../constants';
import { RTP_NONCE_LENGTH } from './rtpcrypto';

export const ValidRTPVersion = 2;

export function isValidRTPHeader(buffer: Buffer): boolean {
  return ((buffer[0] >> 6) === ValidRTPVersion);
};

export interface RTPHeaderOptions {
  buffer?: Buffer,
  marker?: boolean,
  payloadType?: number,
  randomize?: boolean,
  ssrc?: number,
  version?: number,
}

// `fromBuffer()` passes this instead of allocating options for every received packet, the buffer is swapped right after
const FROM_BUFFER_OPTIONS: RTPHeaderOptions = Object.freeze({buffer: Buffer.alloc(0)});

export class RTPHeader {
  // a private field instead of a non-enumerable, non-writable `buffer` (`Object.defineProperty()` per packet is slow)
  // it stays out of `Object.keys()`/JSON/inspect output and can't be reassigned, same as before
  #buffer: Buffer;
  nonce?: Buffer;
  payload?: Buffer;

  /**
   * Wraps a received packet's header bytes without copying them
   */
  static fromBuffer(buffer: Buffer): RTPHeader {
    const header = new RTPHeader(FROM_BUFFER_OPTIONS);
    header.#buffer = buffer;
    return header;
  }

  constructor(
    options: RTPHeaderOptions = {},
  ) {
    if (options.buffer) {
      this.#buffer = options.buffer;
    } else {
      this.#buffer = Buffer.alloc(12);
    }

    if (!options.buffer && options.version === undefined) {
      options.version = ValidRTPVersion;
    }

    if (options.version !== undefined) {
      this.setVersion(<number> options.version);
    }

    if (options.marker !== undefined) {
      this.setMarker(options.marker);
    }

    if (options.payloadType !== undefined) {
      this.setPayloadType(options.payloadType);
    }

    if (options.ssrc !== undefined) {
      this.setSSRC(options.ssrc);
    }

    if (options.randomize) {
      this.randomizeSequence();
      this.randomizeTimestamp();
    }
  }

  get buffer(): Buffer {
    return this.#buffer;
  }

  get length(): number {
    return this.buffer.length;
  }

  get valid(): boolean {
    return isValidRTPHeader(this.buffer);
  }

  get firstByte(): number {
    return this.buffer[0];
  }

  get secondByte(): number {
    return this.buffer[1];
  }

  get version(): number {
    return this.firstByte >> 6;
  }

  get padding(): number {
    return (this.firstByte >> 5) & 1;
  }

  get extension(): number {
    return (this.firstByte >> 4) & 1;
  }

  get csrcCount(): number {
    return this.firstByte & 0x0F;
  }

  get marker(): number {
    return this.secondByte >> 7;
  }

  get payloadType(): number {
    return this.secondByte & 0x7F;
  }

  get sequence(): number {
    return this.buffer.readUInt16BE(2);
  }

  get timestamp(): number {
    return this.buffer.readUInt32BE(4);
  }

  get ssrc(): number {
    return this.buffer.readUInt32BE(8);
  }

  get nonceNumber(): number {
    if (this.nonce) {
      return this.nonce.readUInt32BE(0);
    }
    return 0;
  }

  randomizeSequence(): void {
    this.setSequence(Math.round(Math.random() * MaxNumbers.UINT16));
  }

  randomizeTimestamp(): void {
    this.setTimestamp(Math.round(Math.random() * MaxNumbers.UINT32));
  }

  randomizeNonce(): void {
    this.setNonce(Math.round(Math.random() * MaxNumbers.UINT32));
  }

  setVersion(version: number): void {
    this.buffer.writeUIntBE(
      ((version & 0x03) << 6 | this.padding << 5 | this.extension << 4 | this.csrcCount),
      0,
      1,
    );
  }

  setPadding(padding: boolean | number): void {
    this.buffer.writeUIntBE(
      (this.version << 6 | Number(!!padding) << 5 | this.extension << 4 | this.csrcCount),
      0,
      1,
    );
  }

  setExtension(extension: boolean | number): void {
    this.buffer.writeUIntBE(
      (this.version << 6 | this.padding << 5 | Number(!!extension) << 4 | this.csrcCount),
      0,
      1,
    );
  }

  setCSRCCount(csrcCount: number): void {
    this.buffer.writeUIntBE(
      (this.version << 6 | this.padding << 5 | this.extension << 4 | (csrcCount & 0x0F)),
      0,
      1,
    );
  }

  setMarker(marker: boolean | number): void {
    this.buffer.writeUIntBE((Number(!!marker) << 7 | this.payloadType), 1, 1);
  }

  setPayloadType(payloadType: number): void {
    this.buffer.writeUIntBE((this.marker << 7 | (payloadType & 0x7F)), 1, 1);
  }

  setSequence(
    sequence?: number,
    increment: boolean = false,
  ): void {
    if (sequence === undefined) {
      sequence = 1;
      increment = true;
    }
    if (increment) {
      sequence += this.sequence;
    }
    sequence %= (MaxNumbers.UINT16 + 1);
    this.buffer.writeUInt16BE(sequence, 2);
  }

  setTimestamp(
    timestamp?: number,
    increment: boolean = false,
  ): void {
    if (timestamp === undefined) {
      timestamp = Math.round(Math.random() * MaxNumbers.UINT32);
      increment = false;
    }
    if (increment) {
      timestamp += this.timestamp;
    }
    timestamp %= (MaxNumbers.UINT32 + 1);
    this.buffer.writeUInt32BE(timestamp, 4);
  }

  setSSRC(ssrc: number): void {
    if (!Number.isInteger(ssrc)) {
      throw new Error('SSRC must be an integer!');
    }
    if (MaxNumbers.UINT32 < ssrc) {
      throw new Error(`SSRC must not be over ${MaxNumbers.UINT32}`);
    }
    this.buffer.writeUInt32BE(ssrc, 8);
  }

  setPayload(
    payload: Buffer,
    replace: boolean = false,
  ): void {
    if (replace) {
      this.payload = payload;
    } else {
      if (!this.payload) {
        throw new Error('Cannot overwrite a non-existant payload on this packet');
      }
      this.payload.fill(0);
      payload.copy(this.payload);
    }
  }

  setNonce(
    nonce?: Buffer | number,
    increment: boolean = false,
  ): void {
    if (Buffer.isBuffer(nonce)) {
      if (this.nonce) {
        this.nonce.fill(0);
        nonce.copy(this.nonce);
      } else {
        this.nonce = nonce;
      }
    } else {
      if (!this.nonce) {
        this.nonce = Buffer.alloc(24);
        this.randomizeNonce();
      }
      if (nonce === undefined) {
        nonce = 1;
        increment = true;
      }
      if (increment) {
        nonce += this.nonceNumber;
      }
      nonce %= (MaxNumbers.UINT32 + 1);
      this.nonce.writeUIntBE(nonce, 0, 4);
    }
  }

  reset(): void {
    const firstByte = this.firstByte;
    const secondByte = this.secondByte;

    this.buffer.fill(0);
    this.buffer.writeUIntBE(firstByte, 0, 1);
    this.buffer.writeUIntBE(secondByte, 1, 1);

    if (this.payload) {
      this.payload.fill(0);
    }

    this.randomizeSequence();
    this.randomizeTimestamp();
  }

  copy(
    target: Buffer,
    targetStart?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): number {
    return this.buffer.copy(target, targetStart, sourceStart, sourceEnd);
  }
}

export class RTPNonce {
  // see `RTPHeader`, a private field keeps `buffer` non-enumerable and read-only without a `defineProperty()` per instance
  #buffer: Buffer;

  constructor(
    options: {
      randomize?: boolean,
    } = {},
  ) {
    this.#buffer = Buffer.alloc(RTP_NONCE_LENGTH);

    if (options.randomize || options.randomize === undefined) {
      this.randomize();
    }
  }

  get buffer(): Buffer {
    return this.#buffer;
  }

  get number(): number {
    return this.buffer.readUInt32BE(0);
  }

  copy(
    target: Buffer,
    targetStart?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): number {
    return this.buffer.copy(target, targetStart, sourceStart, sourceEnd);
  }

  randomize(): Buffer {
    return this.set(Math.round(Math.random() * MaxNumbers.UINT32));
  }

  set(
    nonce?: number,
    increment: boolean = false,
  ): Buffer {
    if (nonce === undefined) {
      nonce = 1;
      increment = true;
    }
    if (increment) {
      nonce = this.number + nonce;
    }
    nonce %= (MaxNumbers.UINT32 + 1);
    this.buffer.writeUInt32BE(nonce, 0);
    return this.buffer;
  }
}
