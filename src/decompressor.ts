import { EventEmitter } from 'detritus-utils';

import { InflateError } from './errors';

const DependencyTypes = Object.freeze({
  PAKO: 'pako',
  ZLIB: 'zlib',
});

const ErrorCodes = Object.freeze({
  ERR_ZLIB_BINDING_CLOSED: 'ERR_ZLIB_BINDING_CLOSED',
});

const Inflate = {
  flushCode: 0,
  module: require(DependencyTypes.ZLIB),
  type: DependencyTypes.ZLIB,
};

Inflate.flushCode = Inflate.module.constants.Z_SYNC_FLUSH;

try {
  Inflate.module = require(DependencyTypes.PAKO);
  Inflate.type = DependencyTypes.PAKO;
} catch(e) {}

export class Decompressor extends EventEmitter {
  dataChunks: Array<Buffer>;
  chunks: Array<Buffer>;
  chunkSize: number;
  closed: boolean;
  flushing: boolean;
  inflate: any;
  suffix: Buffer;

  constructor(
    suffix: Buffer,
    chunkSize: number = 64 * 1024,
  ) {
    super();

    this.dataChunks = [];
    this.chunks = [];
    this.chunkSize = chunkSize;
    this.closed = false;
    this.flushing = false;
    this.inflate = null;
    this.suffix = suffix;
    this.initialize();
  }

  feed(chunk: Buffer): void {
    if (!this.closed && this.inflate) {
      this.chunks.push(chunk);
      this.write();
    }
  }

  close(): void {
    this.closed = true;
    this.chunks.length = 0;
    this.dataChunks.length = 0;
    this.flushing = false;
    switch (Inflate.type) {
      case DependencyTypes.ZLIB: {
        this.inflate.close();
        this.inflate.removeAllListeners('data');
      }; break;
    }
    this.inflate = null;
  }

  initialize(): void {
    switch (Inflate.type) {
      case DependencyTypes.PAKO: {
        this.inflate = new Inflate.module.Inflate({
          chunkSize: this.chunkSize,
        });
      }; break;
      case DependencyTypes.ZLIB: {
        this.inflate = Inflate.module.createInflate({
          chunkSize: this.chunkSize,
          flush: Inflate.flushCode,
        });
        this.inflate.on('data', this.onData.bind(this));
        this.inflate.on('error', this.onError.bind(this));
      }; break;
      default: {
        throw new Error(`Unable to use any ${JSON.stringify(Object.values(DependencyTypes))}`);
      };
    }

    this.dataChunks.length = 0;
    this.chunks.length = 0;
    this.flushing = false;
    this.closed = false;
  }

  reset(): void {
    this.close();
    this.initialize();
  }

  write(): void {
    if (
      (this.closed) ||
      (!this.inflate) ||
      (!this.chunks.length) ||
      (this.flushing)
    ) {
      return;
    }

    const chunk = <Buffer> this.chunks.shift();
    const isEnd = (
      (this.suffix.length <= chunk.length) &&
      (chunk.slice(-this.suffix.length).equals(this.suffix))
    );

    switch (Inflate.type) {
      case DependencyTypes.PAKO: {
        this.inflate.push(chunk, isEnd && Inflate.flushCode);
        if (isEnd) {
          if (this.inflate.err) {
            const error = new InflateError(this.inflate.msg, this.inflate.err);
            this.onError(error);
          } else {
            this.onData(this.inflate.result);
          }
        }
      }; break;
      case DependencyTypes.ZLIB: {
        this.inflate.write(chunk);
        if (isEnd) {
          this.flushing = true;
          this.inflate.flush(Inflate.flushCode, this.onFlush.bind(this));
          return;
        }
      }; break;
    }
    this.write();
  }

  onData(
    data: any,
  ): void {
    switch (Inflate.type) {
      case DependencyTypes.PAKO: {
        this.emit('data', Buffer.from(data));
      }; break
      case DependencyTypes.ZLIB: {
        this.dataChunks.push(<Buffer> data);
      }; break;
    }
  }

  onError(
    error: any,
  ): void {
    if (error.code === ErrorCodes.ERR_ZLIB_BINDING_CLOSED) {
      // zlib was flushing when we called .close on it
      return;
    }
    this.emit('error', error);
  }

  onFlush(
    error: any,
  ): void {
    if (error) {
      return;
    }
    if (this.dataChunks.length) {
      const chunk = (this.dataChunks.length === 1) ? this.dataChunks.shift() : Buffer.concat(this.dataChunks);
      this.dataChunks.length = 0;
      this.emit('data', chunk);
    }
    this.flushing = false;
    this.write();
  }
}
