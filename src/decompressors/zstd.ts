import { EventSpewer } from 'detritus-utils';

const DependencyTypes = Object.freeze({
  ZUCC: 'zucc',
});

const ZSTD: {
  module: any,
  type: null | string,
} = {
  module: null,
  type: null,
};

for (let type of [DependencyTypes.ZUCC]) {
  try {
    ZSTD.module = require(type);
    ZSTD.type = type;
  } catch(e) {}
}


export class ZstdDecompressor extends EventSpewer {
  closed: boolean = false;
  stream: any | null = null;

  constructor() {
    super();
    this.initialize();
  }

  close(): void {
    this.closed = true;

    if (this.stream) {
      switch (ZSTD.type) {
        case DependencyTypes.ZUCC: {
          this.stream.free();
        }; break;
      }
    }
    this.stream = null;
  }

  feed(data: Buffer): void {
    if (!this.closed && this.stream) {
      switch (ZSTD.type) {
        case DependencyTypes.ZUCC: {
          try {
            const decompressed = Buffer.from(this.stream.decompress(data));
            this.emit('data', decompressed);
          } catch(error) {
            this.emit('error', error);
          }
        }; break;
      }
    }
  }

  initialize(): void {
    this.close();
    switch (ZSTD.type) {
      case DependencyTypes.ZUCC: {
        this.stream = new ZSTD.module.DecompressStream();
      }; break;
      default: {
        throw new Error(`Unable to use any ${JSON.stringify(Object.values(DependencyTypes))}`);
      };
    }

    this.closed = false;
  }

  reset(): void {
    this.initialize();
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: 'data', listener: (data: Buffer) => any): this;
  on(event: 'error', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }

  static isSupported(): boolean {
    return !!ZSTD.module;
  }
}
