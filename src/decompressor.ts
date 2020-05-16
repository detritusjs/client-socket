import { EventSpewer } from 'detritus-utils';

import { CompressTypes, ZLIB_SUFFIX } from './constants';
import { ZlibDecompressor } from './decompressors';


export interface DecompresserOptions {
  type: string,
}

export class Decompressor extends EventSpewer {
  closed: boolean = false;
  decompressor!: ZlibDecompressor;
  type: string;

  constructor(options: DecompresserOptions) {
    super();

    this.type = options.type;
    switch (this.type) {
      case CompressTypes.ZLIB: {
        this.decompressor = new ZlibDecompressor(Buffer.from(ZLIB_SUFFIX));
        this.decompressor.on('data', (data) => this.emit('data', data));
        this.decompressor.on('error', (error) => this.emit('error', error));
      }; break;
      default: {
        throw new Error(`Invalid Compress Type: ${this.type}`);
      };
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.decompressor.close();
      this.decompressor.removeAllListeners();
      this.removeAllListeners();
    }
  }

  feed(data: Buffer): void {
    this.decompressor.feed(data);
  }

  reset(): void {
    this.decompressor.reset();
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: 'data', listener: (data: Buffer) => any): this;
  on(event: 'error', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }

  static supported(): Array<string> {
    const supported: Array<string> = [CompressTypes.ZLIB];
    return supported;
  }
}
