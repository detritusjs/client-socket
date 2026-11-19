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

// `fromBuffer()` reuses this instead of allocating options per packet
const FROM_BUFFER_OPTIONS: RTPHeaderOptions = Object.freeze({buffer: Buffer.alloc(0)});

export class RTPHeader {
  // a private field since `Object.defineProperty()` per packet is slow
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

  // the setters below only change their own bits of the byte

  setVersion(version: number): void {
    this.buffer[0] = (this.buffer[0] & 0x3F) | ((version & 0x03) << 6);
  }

  setPadding(padding: boolean | number): void {
    this.buffer[0] = (this.buffer[0] & 0xDF) | (Number(!!padding) << 5);
  }

  setExtension(extension: boolean | number): void {
    this.buffer[0] = (this.buffer[0] & 0xEF) | (Number(!!extension) << 4);
  }

  setCSRCCount(csrcCount: number): void {
    this.buffer[0] = (this.buffer[0] & 0xF0) | (csrcCount & 0x0F);
  }

  setMarker(marker: boolean | number): void {
    this.buffer[1] = (this.buffer[1] & 0x7F) | (Number(!!marker) << 7);
  }

  setPayloadType(payloadType: number): void {
    this.buffer[1] = (this.buffer[1] & 0x80) | (payloadType & 0x7F);
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
    // keeps the first two bytes (version, flags, marker, payload type)
    this.buffer.fill(0, 2);

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
  // see `RTPHeader`
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
