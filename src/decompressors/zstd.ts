import * as zlib from 'zlib';

import { EventSpewer } from 'detritus-utils';


const NODE_MAJOR_VERSION = parseInt(process.versions.node.split('.')[0]);

// node 22.15/23.8 added zstd as experimental, only use it from node 24 on
export const ZSTD_SUPPORTED = (
  (24 <= NODE_MAJOR_VERSION) &&
  (typeof((zlib as any).createZstdDecompress) === 'function')
);

const ErrorCodes = Object.freeze({
  ERR_ZLIB_BINDING_CLOSED: 'ERR_ZLIB_BINDING_CLOSED',
});


/**
 * `zstd-stream` keeps one zstd context for the whole connection,
 * every websocket message is one whole gateway payload (unlike zlib, there is no suffix to wait for)
 */
export class ZstdDecompressor extends EventSpewer {
  dataChunks: Array<Buffer> = [];
  chunks: Array<Buffer> = [];
  chunkSize: number;
  closed: boolean = false;
  flushing: boolean = false;
  stream: zlib.ZstdDecompress | null = null;

  constructor(chunkSize: number = 64 * 1024) {
    super();

    if (!ZSTD_SUPPORTED) {
      throw new Error('Zstd decompression requires Node 24 or higher');
    }

    this.chunkSize = chunkSize;
    this.initialize();
  }

  close(): void {
    this.closed = true;
    this.chunks.length = 0;
    this.dataChunks.length = 0;
    this.flushing = false;

    if (this.stream) {
      this.stream.close();
      this.stream.removeAllListeners();
    }
    this.stream = null;
  }

  feed(chunk: Buffer): void {
    if (!this.closed && this.stream) {
      this.chunks.push(chunk);
      this.write();
    }
  }

  initialize(): void {
    this.close();
    this.stream = zlib.createZstdDecompress({chunkSize: this.chunkSize, flush: zlib.constants.ZSTD_e_flush});
    this.stream.on('data', this.onData.bind(this));
    this.stream.on('error', this.onError.bind(this));
    this.closed = false;
  }

  reset(): void {
    this.initialize();
  }

  write(): void {
    if (
      (this.closed) ||
      (!this.stream) ||
      (!this.chunks.length) ||
      (this.flushing)
    ) {
      return;
    }

    const chunk = this.chunks.shift()!;

    // each message is a whole payload, the stream flushes every write so its callback means all of the payload's data was emitted
    this.flushing = true;
    const stream = this.stream;
    stream.write(chunk, () => {
      // ignore a write from a stream that was replaced by reset() while it was flushing
      if (stream === this.stream) {
        this.onFlush();
      }
    });
  }

  onData(data: Buffer): void {
    this.dataChunks.push(data);
  }

  onError(error: any): void {
    if (error.code === ErrorCodes.ERR_ZLIB_BINDING_CLOSED) {
      // zstd was flushing when we called .close on it
      return;
    }
    this.emit('error', error);
  }

  onFlush(): void {
    try {
      if (this.dataChunks.length) {
        const chunk = (this.dataChunks.length === 1) ? this.dataChunks.shift() : Buffer.concat(this.dataChunks);
        this.dataChunks.length = 0;
        this.emit('data', chunk);
      }
    } finally {
      // a throwing listener shouldn't leave us stuck as flushing, every later payload would just queue up
      this.flushing = false;
      this.write();
    }
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: 'data', listener: (data: Buffer) => any): this;
  on(event: 'error', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
