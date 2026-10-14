import * as os from 'os';

import { EventSpewer } from 'detritus-utils';


// opus' rtp clock rate is always 48khz, regardless of the decoded sample rate
const RTP_CLOCK_RATE = 48000;
const RTP_TIMESTAMP_RANGE = 0x100000000;
const RTP_TIMESTAMP_HALF_RANGE = 0x80000000;

// 16-bit pcm
const BYTE_DEPTH = 2;
const PCM_MAX = 32767;
const PCM_MIN = -32768;

// how many recent rtp timestamps to remember per source to drop duplicate packets
const RECENT_TIMESTAMPS_SIZE = 16;
// if the event loop stalls for longer than this many frames, skip ahead instead of emitting a burst
const MAX_CATCH_UP_FRAMES = 10;

// typed arrays use the platform's byte order, the pcm is always little-endian
const IS_LITTLE_ENDIAN = (os.endianness() === 'LE');


/**
 * Reads the first `length` 16-bit little-endian samples of `pcm` as an Int16Array, without copying when possible
 */
function pcmToInt16Array(pcm: Buffer, length: number): Int16Array {
  if (IS_LITTLE_ENDIAN) {
    if (!(pcm.byteOffset % BYTE_DEPTH)) {
      return new Int16Array(pcm.buffer, pcm.byteOffset, length);
    }
    // an Int16Array view has to start on a 2-byte boundary, copy the bytes into an aligned one
    const samples = new Int16Array(length);
    new Uint8Array(samples.buffer).set(pcm.subarray(0, length * BYTE_DEPTH));
    return samples;
  }
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = pcm.readInt16LE(i * BYTE_DEPTH);
  }
  return samples;
}


export interface AudioMixerFormat {
  channels: number,
  frameDuration: number,
  frameSize: number,
  sampleRate: number,
  sampleSize: number,
  samplesPerFrame: number,
}

export interface AudioMixerOptions {
  /** Defaults to 2 */
  channels?: number,
  /** Length (in ms) of each emitted frame, defaults to 20 */
  frameDuration?: number,
  /** Defaults to 48000 */
  sampleRate?: number,
  /** How much audio (in ms) can be buffered ahead of the output, defaults to 1000 */
  bufferDuration?: number,
  /** How long (in ms) to hold audio before mixing, to absorb network jitter, defaults to 60 */
  delay?: number,
  /** Don't emit frames that are complete silence, defaults to false */
  skipSilence?: boolean,
  /** Forget a source after this long (in ms) without packets, defaults to 5000 */
  sourceTimeout?: number,
  /** Users to mix, defaults to everyone (see `isMixing()`) */
  userIds?: Iterable<string>,
}

export interface AudioMixerSource {
  anchorPosition: number,
  anchorTimestamp: null | number,
  lastPacketAt: number,
  latestTimestamp: null | number,
  nextPosition: number,
  recentTimestamps: Array<number>,
}


/**
 * Mixes multiple PCM sources (e.g. each user's decoded voice) into one continuous stream
 * Packets are placed using their RTP timestamps, so jitter and bursts don't smear the audio
 * Emits `data` with one mixed PCM frame (of `format.frameDuration`) at a steady rate while running
 * Only signed 16-bit little-endian interleaved PCM is supported (what opus decoders output)
 */
export class AudioMixer extends EventSpewer {
  buffer: Int32Array;
  bufferSamples: number;
  delaySamples: number;
  format: AudioMixerFormat;
  /** Sample position (per channel) of the next frame to be emitted */
  position: number = 0;
  running: boolean = false;
  skipSilence: boolean;
  sources = new Map<string, AudioMixerSource>();
  sourceTimeout: number;
  startedAt: number = 0;
  ticks: number = 0;
  timeout: null | ReturnType<typeof setTimeout> = null;
  /** Users to mix, null means everyone. `push()` doesn't check this, check `isMixing()` before pushing */
  userIds: null | Set<string> = null;

  constructor(options: AudioMixerOptions = {}) {
    super();
    const channels = options.channels || 2;
    const frameDuration = options.frameDuration || 20;
    const sampleRate = options.sampleRate || RTP_CLOCK_RATE;
    const samplesPerFrame = Math.round((sampleRate / 1000) * frameDuration);
    const sampleSize = BYTE_DEPTH * channels;
    this.format = {
      channels,
      frameDuration,
      frameSize: samplesPerFrame * sampleSize,
      sampleRate,
      sampleSize,
      samplesPerFrame,
    };

    const bufferDuration = Math.max(options.bufferDuration || 1000, this.format.frameDuration * 4);
    const delay = (options.delay === undefined) ? 60 : Math.max(options.delay, 0);
    if (bufferDuration <= delay + this.format.frameDuration) {
      throw new Error('AudioMixer bufferDuration must be larger than delay + frameDuration');
    }

    this.bufferSamples = this.msToSamples(bufferDuration);
    this.buffer = new Int32Array(this.bufferSamples * this.format.channels);
    this.delaySamples = this.msToSamples(delay);
    this.skipSilence = !!options.skipSilence;
    this.sourceTimeout = (options.sourceTimeout === undefined) ? 5000 : options.sourceTimeout;
    if (options.userIds) {
      this.setUserIds(options.userIds);
    }
  }

  /**
   * Only mix these users, pass null to mix everyone
   */
  setUserIds(userIds: null | Iterable<string>): void {
    this.userIds = (userIds) ? new Set(userIds) : null;
    if (this.userIds) {
      for (let sourceId of this.sources.keys()) {
        if (!this.userIds.has(sourceId)) {
          this.removeSource(sourceId);
        }
      }
    }
  }

  addUserId(userId: string): void {
    if (this.userIds) {
      this.userIds.add(userId);
    }
  }

  removeUserId(userId: string): void {
    if (!this.userIds) {
      throw new Error('Mixer is mixing everyone, use setUserIds() to choose which users to mix');
    }
    this.userIds.delete(userId);
    this.removeSource(userId);
  }

  isMixing(userId: string): boolean {
    return !this.userIds || this.userIds.has(userId);
  }

  msToSamples(ms: number): number {
    return Math.round((this.format.sampleRate / 1000) * ms);
  }

  now(): number {
    return performance.now();
  }

  /**
   * Adds a PCM frame from a source into the mix
   * `rtpTimestamp` is optional, without it the frame is placed right after the source's previous frame
   */
  push(sourceId: string, pcm: Buffer, rtpTimestamp?: number): void {
    if (!this.running) {
      return;
    }
    const sampleSize = this.format.sampleSize;
    const samples = Math.floor(pcm.length / sampleSize);
    if (!samples) {
      return;
    }

    let source = this.sources.get(sourceId);
    if (!source) {
      source = {
        anchorPosition: 0,
        anchorTimestamp: null,
        lastPacketAt: 0,
        latestTimestamp: null,
        nextPosition: 0,
        recentTimestamps: [],
      };
      this.sources.set(sourceId, source);
      this.anchor(source, rtpTimestamp);
    }
    source.lastPacketAt = this.now();

    let position: number;
    if (rtpTimestamp !== undefined && source.anchorTimestamp !== null) {
      if (source.recentTimestamps.includes(rtpTimestamp)) {
        // duplicate packet
        return;
      }
      position = source.anchorPosition + this.timestampToSamples(this.timestampDiff(rtpTimestamp, source.anchorTimestamp));
    } else {
      position = source.nextPosition;
      if (rtpTimestamp !== undefined) {
        source.anchorPosition = position;
        source.anchorTimestamp = rtpTimestamp;
      }
    }

    if (position + samples <= this.position) {
      // entirely late
      const isOlder = (
        rtpTimestamp !== undefined &&
        source.latestTimestamp !== null &&
        this.timestampDiff(rtpTimestamp, source.latestTimestamp) < 0
      );
      if (isOlder) {
        // a reordered straggler, its slot was already emitted
        return;
      }
      // the source fell behind (clock drift, a stall, or it started talking again), re-anchor it
      position = this.anchor(source, rtpTimestamp);
    } else if (this.position + this.bufferSamples < position + samples) {
      // too far ahead to fit in the buffer (e.g. a big timestamp jump), re-anchor it
      position = this.anchor(source, rtpTimestamp);
    }

    if (rtpTimestamp !== undefined) {
      source.recentTimestamps.push(rtpTimestamp);
      if (RECENT_TIMESTAMPS_SIZE < source.recentTimestamps.length) {
        source.recentTimestamps.shift();
      }
      if (source.latestTimestamp === null || 0 < this.timestampDiff(rtpTimestamp, source.latestTimestamp)) {
        source.latestTimestamp = rtpTimestamp;
      }
    }
    source.nextPosition = Math.max(source.nextPosition, position + samples);

    const channels = this.format.channels;
    // skip whatever part of the frame was already emitted, and drop its newest samples if it doesn't fit in the buffer
    // (writing past the end of the buffer would wrap around onto the slots that are about to be emitted)
    const start = Math.max(this.position - position, 0);
    const end = Math.min(samples, this.position + this.bufferSamples - position);
    if (start < end) {
      const buffer = this.buffer;
      const values = pcmToInt16Array(pcm, end * channels);
      // the range never covers more than the whole ring buffer, so it's at most two contiguous parts, the second one wrapping around to the start
      const length = (end - start) * channels;
      const index = ((position + start) % this.bufferSamples) * channels;
      const firstLength = Math.min(length, buffer.length - index);
      let offset = start * channels;
      for (let i = 0; i < firstLength; i++) {
        buffer[index + i] += values[offset + i];
      }
      offset += firstLength;
      for (let i = 0, wrapped = length - firstLength; i < wrapped; i++) {
        buffer[i] += values[offset + i];
      }
    }
  }

  removeSource(sourceId: string): void {
    this.sources.delete(sourceId);
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.buffer.fill(0);
    this.position = 0;
    this.ticks = 0;
    this.startedAt = this.now();
    this.schedule();
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.buffer.fill(0);
    this.sources.clear();
  }

  protected anchor(source: AudioMixerSource, rtpTimestamp?: number): number {
    const position = this.position + this.delaySamples;
    source.anchorPosition = position;
    source.anchorTimestamp = (rtpTimestamp === undefined) ? null : rtpTimestamp;
    source.latestTimestamp = source.anchorTimestamp;
    source.nextPosition = position;
    source.recentTimestamps.length = 0;
    return position;
  }

  protected schedule(): void {
    const target = this.startedAt + (this.ticks + 1) * this.format.frameDuration;
    this.timeout = setTimeout(() => this.tick(), Math.max(target - this.now(), 0));
  }

  protected tick(): void {
    this.timeout = null;
    if (!this.running) {
      return;
    }

    let due = Math.floor((this.now() - this.startedAt) / this.format.frameDuration) - this.ticks;
    if (MAX_CATCH_UP_FRAMES < due) {
      // the event loop stalled, drop the missed audio instead of emitting a burst
      const skip = due - 1;
      const skipSamples = skip * this.format.samplesPerFrame;
      if (this.bufferSamples <= skipSamples) {
        this.buffer.fill(0);
      } else {
        this.clear(this.position, skipSamples);
      }
      this.position += skipSamples;
      this.ticks += skip;
      due = 1;
    }

    while (0 < due--) {
      const frame = this.read();
      this.ticks++;
      if (frame) {
        this.emit('data', frame);
      }
    }

    if (this.sourceTimeout) {
      const expired = this.now() - this.sourceTimeout;
      for (let [sourceId, source] of this.sources) {
        if (source.lastPacketAt < expired) {
          this.sources.delete(sourceId);
        }
      }
    }

    this.schedule();
  }

  protected read(): Buffer | null {
    const buffer = this.buffer;
    const samples = this.format.samplesPerFrame;

    // a frame is at most two contiguous parts of the ring buffer, the second one wrapping around to the start
    const length = samples * this.format.channels;
    const index = (this.position % this.bufferSamples) * this.format.channels;
    const firstLength = Math.min(length, buffer.length - index);
    const wrapped = length - firstLength;
    this.position += samples;

    let silent = true;
    for (let i = index, last = index + firstLength; i < last; i++) {
      if (buffer[i]) {
        silent = false;
        break;
      }
    }
    if (silent) {
      for (let i = 0; i < wrapped; i++) {
        if (buffer[i]) {
          silent = false;
          break;
        }
      }
    }
    if (silent) {
      // the slots are already zeroed
      return (this.skipSilence) ? null : Buffer.alloc(this.format.frameSize);
    }

    // every sample gets written below, and `allocUnsafeSlow()` keeps the frame on its own ArrayBuffer like `alloc()` (not the shared pool)
    const frame = Buffer.allocUnsafeSlow(this.format.frameSize);
    const values = (IS_LITTLE_ENDIAN) ? new Int16Array(frame.buffer, frame.byteOffset, length) : new Int16Array(length);
    for (let i = 0; i < firstLength; i++) {
      const sample = buffer[index + i];
      values[i] = (sample < PCM_MIN) ? PCM_MIN : ((PCM_MAX < sample) ? PCM_MAX : sample);
    }
    for (let i = 0; i < wrapped; i++) {
      const sample = buffer[i];
      values[firstLength + i] = (sample < PCM_MIN) ? PCM_MIN : ((PCM_MAX < sample) ? PCM_MAX : sample);
    }
    buffer.fill(0, index, index + firstLength);
    if (wrapped) {
      buffer.fill(0, 0, wrapped);
    }
    if (!IS_LITTLE_ENDIAN) {
      for (let i = 0; i < length; i++) {
        frame.writeInt16LE(values[i], i * BYTE_DEPTH);
      }
    }
    return frame;
  }

  protected clear(position: number, samples: number): void {
    const channels = this.format.channels;
    for (let i = 0; i < samples; i++) {
      const index = ((position + i) % this.bufferSamples) * channels;
      this.buffer.fill(0, index, index + channels);
    }
  }

  protected timestampDiff(a: number, b: number): number {
    // signed difference, accounting for the 32-bit wraparound
    let diff = (a - b) % RTP_TIMESTAMP_RANGE;
    if (diff < 0) {
      diff += RTP_TIMESTAMP_RANGE;
    }
    if (RTP_TIMESTAMP_HALF_RANGE <= diff) {
      diff -= RTP_TIMESTAMP_RANGE;
    }
    return diff;
  }

  protected timestampToSamples(diff: number): number {
    return Math.round(diff * (this.format.sampleRate / RTP_CLOCK_RATE));
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: 'data', listener: (frame: Buffer) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
