import { MaxNumbers } from '../constants';
import { default as RTPCrypto } from './rtpcrypto';

export const ValidRTPVersion = 2;

export function isValidRTPHeader(buffer: Buffer): boolean {
  return ((buffer.readUIntBE(0, 1) >> 6) === 2);
};

export class RTPHeader {
  buffer: Buffer;
  nonce?: Buffer;
  payload?: Buffer;

  constructor(
    options: {
      buffer?: Buffer,
      marker?: boolean,
      payloadType?: number,
      randomize?: boolean,
      ssrc?: number,
      version?: number,
    } = {},
  ) {
    if (options.buffer) {
      this.buffer = options.buffer;
    } else {
      this.buffer = Buffer.alloc(12);
    }
    Object.defineProperty(this, 'buffer', {enumerable: false, writable: false});

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

  get length(): number {
    return this.buffer.length;
  }

  get valid(): boolean {
    return isValidRTPHeader(this.buffer);
  }

  get firstByte(): number {
    return this.buffer.readUIntBE(0, 1);
  }

  get secondByte(): number {
    return this.buffer.readUIntBE(1, 1);
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

  /* header[2, 3] = sequence*/
  get sequence(): number {
    return this.buffer.readUIntBE(2, 2);
  }

  /* header[4, 5, 6, 7] = timestamp*/
  get timestamp(): number {
    return this.buffer.readUIntBE(4, 4);
  }

  /* header[8, 9, 10, 11] = ssrc*/
  get ssrc(): number {
    return this.buffer.readUIntBE(8, 4);
  }

  get nonceNumber(): number {
    if (this.nonce) {
      return this.nonce.readUIntBE(0, 4);
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
      (version << 6 | this.padding << 5 | this.extension << 4 | this.csrcCount),
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
      (this.version << 6 | this.padding << 5 | this.extension << 4 | csrcCount),
      0,
      1,
    );
  }

  setMarker(marker: boolean | number): void {
    this.buffer.writeUIntBE((Number(!!marker) << 7 | this.payloadType), 1, 1);
  }

  setPayloadType(payloadType: number): void {
    this.buffer.writeUIntBE((this.marker << 7 | payloadType), 1, 1);
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
    sequence %= MaxNumbers.UINT16;
    this.buffer.writeUIntBE(sequence, 2, 2);
  }

  setTimestamp(
    timestamp?: number,
    increment: boolean = false,
  ): void {
    if (timestamp === undefined) {
      timestamp = Date.now();
      increment = false;
    }
    if (increment) {
      timestamp += this.timestamp;
    }
    timestamp %= MaxNumbers.UINT32;
    this.buffer.writeUIntBE(timestamp, 4, 4);
  }

  setSSRC(ssrc: number): void {
    if (!Number.isInteger(ssrc)) {
      throw new Error('SSRC must be an integer!');
    }
    if (MaxNumbers.UINT32 < ssrc) {
      throw new Error(`SSRC must not be over ${MaxNumbers.UINT32}`);
    }
    this.buffer.writeUIntBE(ssrc, 8, 4);
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
      nonce %= MaxNumbers.UINT32;
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
  buffer: Buffer;

  constructor(
    options: {
      randomize?: boolean,
    } = {},
  ) {
    this.buffer = Buffer.alloc(24);
    Object.defineProperty(this, 'buffer', {enumerable: false, writable: false});

    if (options.randomize || options.randomize === undefined) {
      this.randomize();
    }
  }

  get number(): number {
    return this.buffer.readUIntBE(0, 4);
  }

  copy(
    target: Buffer,
    targetStart?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): number {
    return this.buffer.copy(target, targetStart, sourceStart, sourceEnd);
  }

  generate(): Buffer {
    return RTPCrypto.generateNonce(this.buffer);
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
    nonce %= MaxNumbers.UINT32;
    this.buffer.writeUIntBE(nonce, 0, 4);
    return this.buffer;
  }
}
