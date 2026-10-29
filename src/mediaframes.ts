import { MediaCodecs } from './constants';


// how long an incomplete frame waits for its missing packets before we give up on it
const FRAME_MAX_AGE = 1000;
// incomplete frames we hold on to per stream, video at 30fps with a few frames of reordering fits easily
const FRAME_MAX_PENDING = 32;
// complete frames stuck behind an incomplete one before we stop waiting for it, a third of a second at 30fps
const FRAME_MAX_BLOCKED = 10;
// how long missing packets get to show up once the sender has moved on to later frames (a nack and its retransmission
// take about a round trip), longer is a loss
const FRAME_REORDER_WAIT = 150;
// annex b start code, what decoders (and DAVE's h264 handling) expect between nal units
const H264_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

export enum H264NalTypes {
  SLICE = 1,
  IDR = 5,
  SEI = 6,
  SPS = 7,
  PPS = 8,
  STAP_A = 24,
  FU_A = 28,
}


export interface DepacketizedPayload {
  // the packet's share of the frame, already in the form the frame is built from (annex b for h264)
  data: Buffer,
  // null when the packet doesn't say (only the first packet of a vp8/vp9 frame does)
  keyframe: boolean | null,
  // vp8/vp9 mark the first packet of a frame, h264 can only tell us a packet could be one
  start: boolean,
}

export interface AssembledFrame {
  data: Buffer,
  keyframe: boolean,
  timestamp: number,
}

export interface AssemblerResult {
  // in order, a packet can complete several frames at once when it was the one holding them back
  frames: Array<AssembledFrame>,
  // a frame was lost (or we joined mid stream), the sender has to send a keyframe before we can decode again
  requestKeyframe: boolean,
}

interface PendingPacket {
  marker: boolean,
  payload: DepacketizedPayload,
  sequence: number,
}

interface PendingFrame {
  // set once every packet is here, it waits for older frames before it's handed out
  assembled: AssembledFrame | null,
  assembledAt: number,
  firstSeen: number,
  lastSeen: number,
  // sequence number of the frame's first packet once it's assembled, before that the oldest one we have
  firstSequence: number,
  markerSequence: null | number,
  packets: Map<number, PendingPacket>,
  timestamp: number,
}


/**
 * How far `b` is ahead of `a`, 16-bit rtp sequence numbers wrap around
 */
export function sequenceDistance(a: number, b: number): number {
  return (b - a) & 0xFFFF;
}

/**
 * If `b` comes after `a`, anything more than half the sequence space ahead is treated as behind
 */
export function isSequenceNewer(a: number, b: number): boolean {
  const distance = sequenceDistance(a, b);
  return distance !== 0 && distance < 0x8000;
}


/**
 * RFC 7741 Section 4.2
 */
export function depacketizeVP8(payload: Buffer): DepacketizedPayload | null {
  if (payload.length < 1) {
    return null;
  }
  const first = payload[0];
  const extended = !!(first & 0x80);
  const start = !!(first & 0x10);
  const partitionIndex = first & 0x07;

  let offset = 1;
  if (extended) {
    if (payload.length < offset + 1) {return null;}
    const flags = payload[offset++];
    const hasPictureId = !!(flags & 0x80);
    const hasTL0PicIndex = !!(flags & 0x40);
    const hasTemporalIndex = !!(flags & 0x20);
    const hasKeyIndex = !!(flags & 0x10);
    if (hasPictureId) {
      if (payload.length < offset + 1) {return null;}
      // M bit picks between a 7 and a 15 bit picture id
      offset += (payload[offset] & 0x80) ? 2 : 1;
    }
    if (hasTL0PicIndex) {
      offset++;
    }
    if (hasTemporalIndex || hasKeyIndex) {
      offset++;
    }
  }
  if (payload.length < offset) {
    return null;
  }

  const data = payload.subarray(offset);
  const frameStart = start && partitionIndex === 0;
  let keyframe: boolean | null = null;
  if (frameStart && data.length) {
    // RFC 6386 Section 9.1, the frame tag's P bit is 0 for keyframes. DAVE leaves this byte unencrypted
    keyframe = (data[0] & 0x01) === 0;
  }
  return {data, keyframe, start: frameStart};
}

/**
 * RFC 9628 Section 4.2
 */
export function depacketizeVP9(payload: Buffer): DepacketizedPayload | null {
  if (payload.length < 1) {
    return null;
  }
  const first = payload[0];
  const hasPictureId = !!(first & 0x80);
  const interPicturePredicted = !!(first & 0x40);
  const hasLayerIndices = !!(first & 0x20);
  const flexible = !!(first & 0x10);
  const start = !!(first & 0x08);
  const hasScalabilityStructure = !!(first & 0x02);

  let offset = 1;
  if (hasPictureId) {
    if (payload.length < offset + 1) {return null;}
    offset += (payload[offset] & 0x80) ? 2 : 1;
  }
  let spatialId = 0;
  if (hasLayerIndices) {
    if (payload.length < offset + 1) {return null;}
    spatialId = (payload[offset] >> 1) & 0x07;
    offset++;
    if (!flexible) {
      // TL0PICIDX
      offset++;
    }
  }
  if (flexible && interPicturePredicted) {
    // up to 3 reference indices, the N bit says if another follows
    for (let i = 0; i < 3; i++) {
      if (payload.length < offset + 1) {return null;}
      const more = payload[offset++] & 0x01;
      if (!more) {break;}
    }
  }
  if (hasScalabilityStructure) {
    if (payload.length < offset + 1) {return null;}
    const ss = payload[offset++];
    const spatialLayers = (ss >> 5) + 1;
    const hasResolutions = !!(ss & 0x10);
    const hasGroups = !!(ss & 0x08);
    if (hasResolutions) {
      offset += spatialLayers * 4;
    }
    if (hasGroups) {
      if (payload.length < offset + 1) {return null;}
      const groups = payload[offset++];
      for (let i = 0; i < groups; i++) {
        if (payload.length < offset + 1) {return null;}
        const references = (payload[offset++] >> 2) & 0x03;
        offset += references;
      }
    }
  }
  if (payload.length < offset) {
    return null;
  }

  const data = payload.subarray(offset);
  let keyframe: boolean | null = null;
  if (start) {
    keyframe = !interPicturePredicted && spatialId === 0;
  }
  return {data, keyframe, start};
}

/**
 * RFC 6184 Section 5.6 - 5.8, single nal units, STAP-A and FU-A (the only modes discord uses)
 * Returns the packet's nal units as annex b
 */
export function depacketizeH264(payload: Buffer): DepacketizedPayload | null {
  if (payload.length < 1) {
    return null;
  }
  const nalType = payload[0] & 0x1F;
  switch (nalType) {
    case H264NalTypes.STAP_A: {
      const parts: Array<Buffer> = [];
      let keyframe = false;
      let offset = 1;
      while (offset + 2 <= payload.length) {
        const size = payload.readUInt16BE(offset);
        offset += 2;
        if (!size || payload.length < offset + size) {
          return null;
        }
        const nal = payload.subarray(offset, offset + size);
        if ((nal[0] & 0x1F) === H264NalTypes.IDR) {
          keyframe = true;
        }
        parts.push(H264_START_CODE, nal);
        offset += size;
      }
      if (!parts.length) {
        return null;
      }
      return {data: Buffer.concat(parts), keyframe, start: true};
    };
    case H264NalTypes.FU_A: {
      if (payload.length < 2) {
        return null;
      }
      const header = payload[1];
      const start = !!(header & 0x80);
      const fragmentType = header & 0x1F;
      const data = payload.subarray(2);
      if (start) {
        // the original nal header is split between the fu indicator (F + NRI) and the fu header (type)
        const nalHeader = Buffer.from([(payload[0] & 0xE0) | fragmentType]);
        return {
          data: Buffer.concat([H264_START_CODE, nalHeader, data]),
          keyframe: fragmentType === H264NalTypes.IDR,
          start: true,
        };
      }
      return {data, keyframe: (fragmentType === H264NalTypes.IDR) || null, start: false};
    };
  }
  if (nalType === 0 || 24 <= nalType) {
    // reserved, STAP-B, MTAP and FU-B
    return null;
  }
  return {
    data: Buffer.concat([H264_START_CODE, payload]),
    keyframe: nalType === H264NalTypes.IDR,
    start: true,
  };
}

export function depacketize(codec: MediaCodecs | string, payload: Buffer): DepacketizedPayload | null {
  switch (codec) {
    case MediaCodecs.H264: return depacketizeH264(payload);
    case MediaCodecs.VP8: return depacketizeVP8(payload);
    case MediaCodecs.VP9: return depacketizeVP9(payload);
  }
  return null;
}


// rtp payload budget per packet, leaves room for the rtp header, the auth tag and the nonce in a ~1200 byte udp packet
export const MAX_PAYLOAD_LENGTH = 1100;

export interface PacketizeOptions {
  keyframe: boolean,
  // vp8/vp9 picture id, 15 bits, goes up by one per frame
  pictureId: number,
}

/**
 * If an encoded frame is a keyframe, works on e2e encrypted frames too (DAVE leaves these bytes unencrypted)
 */
export function isKeyframe(codec: MediaCodecs | string, frame: Buffer): boolean {
  if (!frame.length) {
    return false;
  }
  switch (codec) {
    // RFC 6386 Section 9.1, the frame tag's P bit is 0 for keyframes
    case MediaCodecs.VP8: return (frame[0] & 0x01) === 0;
    // profile 0/1 frame header, show_existing_frame and frame_type are both 0 for keyframes
    case MediaCodecs.VP9: return ((frame[0] >> 2) & 0x03) === 0;
    case MediaCodecs.H264: {
      return splitAnnexB(frame).some((unit) => (unit[0] & 0x1F) === H264NalTypes.IDR);
    };
  }
  return false;
}

/**
 * RFC 7741 Section 4.2, X=1 | S on a frame's first packet, I=1, then M=1 and a 15 bit picture id
 */
export function packetizeVP8(frame: Buffer, options: PacketizeOptions): Array<Buffer> {
  const packets: Array<Buffer> = [];
  const chunkLength = MAX_PAYLOAD_LENGTH - 4;
  for (let offset = 0; offset < frame.length; offset += chunkLength) {
    const descriptor = Buffer.from([
      0x80 | ((offset === 0) ? 0x10 : 0x00),
      0x80,
      0x80 | ((options.pictureId >> 8) & 0x7F),
      options.pictureId & 0xFF,
    ]);
    packets.push(Buffer.concat([descriptor, frame.subarray(offset, offset + chunkLength)]));
  }
  return packets;
}

/**
 * RFC 9628 Section 4.2, non-flexible mode without layers, I=1 | P on inter frames | B on the first packet | E on the last
 */
export function packetizeVP9(frame: Buffer, options: PacketizeOptions): Array<Buffer> {
  const packets: Array<Buffer> = [];
  const chunkLength = MAX_PAYLOAD_LENGTH - 3;
  for (let offset = 0; offset < frame.length; offset += chunkLength) {
    const descriptor = Buffer.from([
      0x80 | ((options.keyframe) ? 0x00 : 0x40) | ((offset === 0) ? 0x08 : 0x00) | ((frame.length <= offset + chunkLength) ? 0x04 : 0x00),
      0x80 | ((options.pictureId >> 8) & 0x7F),
      options.pictureId & 0xFF,
    ]);
    packets.push(Buffer.concat([descriptor, frame.subarray(offset, offset + chunkLength)]));
  }
  return packets;
}

/**
 * An annex b frame's nal units, without their start codes (3 or 4 bytes)
 */
export function splitAnnexB(frame: Buffer): Array<Buffer> {
  const units: Array<Buffer> = [];
  let start = -1;
  let i = 0;
  while (i + 3 <= frame.length) {
    if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1) {
      if (start !== -1) {
        // a 4 byte start code leaves its leading zero on the previous unit
        units.push(frame.subarray(start, (frame[i - 1] === 0) ? i - 1 : i));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start !== -1) {
    units.push(frame.subarray(start));
  }
  return units.filter((unit) => unit.length);
}

/**
 * RFC 6184 Section 5.6/5.8, a single nal unit per packet when it fits, FU-A fragments when it doesn't. Takes annex b
 */
export function packetizeH264(frame: Buffer): Array<Buffer> {
  const packets: Array<Buffer> = [];
  for (let unit of splitAnnexB(frame)) {
    if (unit.length <= MAX_PAYLOAD_LENGTH) {
      packets.push(unit);
      continue;
    }
    const indicator = (unit[0] & 0xE0) | H264NalTypes.FU_A;
    const type = unit[0] & 0x1F;
    const body = unit.subarray(1);
    const chunkLength = MAX_PAYLOAD_LENGTH - 2;
    for (let offset = 0; offset < body.length; offset += chunkLength) {
      const start = (offset === 0) ? 0x80 : 0x00;
      const end = (body.length <= offset + chunkLength) ? 0x40 : 0x00;
      packets.push(Buffer.concat([Buffer.from([indicator, start | end | type]), body.subarray(offset, offset + chunkLength)]));
    }
  }
  return packets;
}

/**
 * Splits an encoded frame into rtp payloads, the inverse of `depacketize`
 */
export function packetize(codec: MediaCodecs | string, frame: Buffer, options: PacketizeOptions): Array<Buffer> {
  switch (codec) {
    case MediaCodecs.H264: return packetizeH264(frame);
    case MediaCodecs.VP8: return packetizeVP8(frame, options);
    case MediaCodecs.VP9: return packetizeVP9(frame, options);
  }
  throw new Error(`Cannot packetize ${codec}`);
}




/**
 * Puts one video stream's (ssrc's) rtp packets back together into frames
 * Packets of a frame share a timestamp and the last one has the marker bit set, a frame is complete once every
 * sequence number from its first packet to its marker packet is here. Frames come out in order, a complete frame waits
 * for older incomplete ones (packets get reordered) until they finish or are given up on.
 * After a loss, frames that depend on the lost one would only decode as garbage, so they're held back until a keyframe
 */
export class MediaFrameAssembler {
  codec: MediaCodecs;
  frames = new Map<number, PendingFrame>();
  // sequence number of the last packet of the last frame we handed out (or gave up on)
  lastSequence: null | number = null;
  // sequence numbers of packets without any media (padding), so they don't look like losses
  paddingSequences = new Set<number>();
  waitingForKeyframe: boolean = true;

  constructor(codec: MediaCodecs) {
    this.codec = codec;
  }

  push(
    sequence: number,
    timestamp: number,
    marker: boolean,
    payload: Buffer,
    now: number = Date.now(),
  ): AssemblerResult {
    const result: AssemblerResult = {frames: [], requestKeyframe: false};
    if (this.lastSequence !== null && !isSequenceNewer(this.lastSequence, sequence)) {
      // late or duplicate, its frame is already gone
      return result;
    }

    if (!payload.length) {
      this.paddingSequences.add(sequence);
      this.skipPadding();
      this.drain(now, result);
      return result;
    }

    const depacketized = depacketize(this.codec, payload);
    if (!depacketized) {
      return result;
    }

    let pending = this.frames.get(timestamp);
    if (!pending) {
      pending = {
        assembled: null,
        assembledAt: 0,
        firstSeen: now,
        lastSeen: now,
        firstSequence: sequence,
        markerSequence: null,
        packets: new Map(),
        timestamp,
      };
      this.frames.set(timestamp, pending);
    } else if (pending.assembled) {
      return result;
    }
    pending.packets.set(sequence, {marker, payload: depacketized, sequence});
    pending.lastSeen = now;
    if (isSequenceNewer(sequence, pending.firstSequence)) {
      pending.firstSequence = sequence;
    }
    if (marker) {
      pending.markerSequence = sequence;
    }

    // h264 frames can only be told apart by the packet before them, which might be the one that just came in
    for (let other of this.frames.values()) {
      if (!other.assembled && other.markerSequence !== null) {
        this.assemble(other, now);
      }
    }
    this.drain(now, result);
    return result;
  }

  protected assemble(pending: PendingFrame, now: number): void {
    // walk back from the marker packet, every packet of the frame has to be part of one unbroken run
    let firstSequence = pending.markerSequence!;
    while (pending.packets.has((firstSequence - 1) & 0xFFFF)) {
      firstSequence = (firstSequence - 1) & 0xFFFF;
    }
    if (sequenceDistance(firstSequence, pending.markerSequence!) + 1 !== pending.packets.size) {
      return;
    }

    const first = pending.packets.get(firstSequence)!;
    if (!first.payload.start) {
      return;
    }
    if (this.codec === MediaCodecs.H264 && !this.isFrameBoundary(firstSequence, pending.timestamp)) {
      // h264 has no frame start flag, a missing slice at the front would go unnoticed otherwise
      return;
    }

    const parts: Array<Buffer> = [];
    let keyframe = false;
    for (let i = 0; i < pending.packets.size; i++) {
      const packet = pending.packets.get((firstSequence + i) & 0xFFFF)!;
      parts.push(packet.payload.data);
      if (packet.payload.keyframe) {
        keyframe = true;
      }
    }
    pending.firstSequence = firstSequence;
    pending.assembled = {data: Buffer.concat(parts), keyframe, timestamp: pending.timestamp};
    pending.assembledAt = now;
  }

  /**
   * Hands out complete frames from the oldest one on, stops at an incomplete frame unless we've given up on it
   */
  protected drain(now: number, result: AssemblerResult): void {
    while (this.frames.size) {
      let oldest: PendingFrame | null = null;
      for (let pending of this.frames.values()) {
        if (!oldest || isSequenceNewer(pending.firstSequence, oldest.firstSequence)) {
          oldest = pending;
        }
      }
      oldest = oldest!;

      let blocked = 0;
      let keyframeBlocked = false;
      for (let pending of this.frames.values()) {
        if (pending !== oldest && pending.assembled) {
          blocked++;
          keyframeBlocked = keyframeBlocked || pending.assembled.keyframe;
        }
      }
      const overflowing = (
        FRAME_MAX_BLOCKED <= blocked ||
        FRAME_MAX_PENDING < this.frames.size ||
        // nothing after a keyframe depends on what came before it
        keyframeBlocked
      );

      if (oldest.assembled) {
        // a whole frame can be late, we wouldn't know about it yet besides the sequence numbers it leaves free
        const gap = this.lastSequence !== null && this.hasGap(this.lastSequence, oldest.firstSequence);
        if (!gap || oldest.assembled.keyframe || overflowing || FRAME_REORDER_WAIT <= now - oldest.assembledAt) {
          this.emit(oldest, result);
          continue;
        }
        break;
      }

      // the sender is on to later frames and the missing packets didn't follow
      const movedOn = 1 < this.frames.size && FRAME_REORDER_WAIT <= now - oldest.lastSeen;
      if (!overflowing && !movedOn && now - oldest.firstSeen < FRAME_MAX_AGE) {
        break;
      }
      this.drop(oldest, result);
    }
  }

  protected emit(pending: PendingFrame, result: AssemblerResult): void {
    const frame = pending.assembled!;
    this.frames.delete(pending.timestamp);
    const lost = this.lastSequence !== null && this.hasGap(this.lastSequence, pending.firstSequence);
    this.lastSequence = pending.markerSequence;
    this.skipPadding();

    if (frame.keyframe) {
      this.waitingForKeyframe = false;
    } else {
      if (lost) {
        this.waitingForKeyframe = true;
      }
      if (this.waitingForKeyframe) {
        result.requestKeyframe = result.requestKeyframe || !this.hasKeyframeQueued();
        return;
      }
    }
    result.frames.push(frame);
  }

  protected drop(pending: PendingFrame, result: AssemblerResult): void {
    this.frames.delete(pending.timestamp);
    // late packets of it shouldn't start a new frame
    for (let sequence of pending.packets.keys()) {
      if (this.lastSequence === null || isSequenceNewer(this.lastSequence, sequence)) {
        this.lastSequence = sequence;
      }
    }
    this.skipPadding();
    this.waitingForKeyframe = true;
    result.requestKeyframe = result.requestKeyframe || !this.hasKeyframeQueued();
  }

  /**
   * If a complete keyframe is already waiting its turn, asking the sender for another one would be pointless
   */
  protected hasKeyframeQueued(): boolean {
    for (let pending of this.frames.values()) {
      if (pending.assembled && pending.assembled.keyframe) {
        return true;
      }
    }
    return false;
  }

  /**
   * If the packet before `sequence` ended an earlier frame (or there's nothing before it to compare with)
   */
  protected isFrameBoundary(sequence: number, timestamp: number): boolean {
    const previous = (sequence - 1) & 0xFFFF;
    if (previous === this.lastSequence || this.paddingSequences.has(previous)) {
      return true;
    }
    for (let other of this.frames.values()) {
      if (other.timestamp !== timestamp && other.packets.has(previous)) {
        return true;
      }
    }
    if (this.lastSequence === null) {
      // the first frame we see, fine as long as nothing older is waiting
      for (let other of this.frames.values()) {
        if (other.timestamp !== timestamp && isSequenceNewer(other.firstSequence, sequence)) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  /**
   * If any packet between `from` and `to` (exclusive) is missing, padding doesn't count
   */
  protected hasGap(from: number, to: number): boolean {
    for (let sequence = (from + 1) & 0xFFFF; sequence !== to; sequence = (sequence + 1) & 0xFFFF) {
      if (!this.paddingSequences.has(sequence)) {
        return true;
      }
    }
    return false;
  }

  protected skipPadding(): void {
    if (this.lastSequence !== null) {
      while (this.paddingSequences.has((this.lastSequence + 1) & 0xFFFF)) {
        this.lastSequence = (this.lastSequence + 1) & 0xFFFF;
      }
      for (let sequence of this.paddingSequences) {
        if (!isSequenceNewer(this.lastSequence, sequence)) {
          this.paddingSequences.delete(sequence);
        }
      }
    }
    if (FRAME_MAX_PENDING * 4 < this.paddingSequences.size) {
      // padding we couldn't place, it only matters for the next few frames
      this.paddingSequences.clear();
    }
  }

  reset(): void {
    this.frames.clear();
    this.lastSequence = null;
    this.paddingSequences.clear();
    this.waitingForKeyframe = true;
  }
}


// how long a missing packet is worth asking for, by then its frame has been given up on
const NACK_MAX_AGE = 1000;
// asking again when a retransmission didn't show up within about a round trip
const NACK_RETRY_INTERVAL = 120;
const NACK_MAX_ATTEMPTS = 3;
// a jump in sequence numbers this big is a restarted stream, not loss
const NACK_MAX_GAP = 250;

interface MissingPacket {
  attempts: number,
  lastSent: number,
  missedAt: number,
}

/**
 * Notices holes in one stream's sequence numbers and says which ones to nack (RFC 4585 Section 6.2.1)
 */
export class MediaNackTracker {
  highest: null | number = null;
  missing = new Map<number, MissingPacket>();

  /**
   * Returns the sequence numbers to nack now, new holes right away and older ones again after a while
   */
  push(sequence: number, now: number = Date.now()): Array<number> {
    if (this.highest === null) {
      this.highest = sequence;
      return [];
    }

    if (isSequenceNewer(this.highest, sequence)) {
      const gap = sequenceDistance(this.highest, sequence) - 1;
      if (NACK_MAX_GAP < gap) {
        this.missing.clear();
      } else {
        for (let i = 1; i <= gap; i++) {
          this.missing.set((this.highest + i) & 0xFFFF, {attempts: 0, lastSent: 0, missedAt: now});
        }
      }
      this.highest = sequence;
    } else {
      // late or retransmitted
      this.missing.delete(sequence);
    }

    const sequences: Array<number> = [];
    for (let [missingSequence, missing] of this.missing) {
      if (NACK_MAX_AGE <= now - missing.missedAt || NACK_MAX_ATTEMPTS <= missing.attempts) {
        this.missing.delete(missingSequence);
        continue;
      }
      if (!missing.attempts || NACK_RETRY_INTERVAL <= now - missing.lastSent) {
        missing.attempts++;
        missing.lastSent = now;
        sequences.push(missingSequence);
      }
    }
    return sequences;
  }

  reset(): void {
    this.highest = null;
    this.missing.clear();
  }
}


// what we keep of each sent video packet to answer nacks with, a second at a few mbps is a few hundred packets
const HISTORY_MAX_AGE = 1000;
const HISTORY_MAX_PACKETS = 1024;
// a viewer nacking the same packet again before our retransmission could've reached it
const HISTORY_RESEND_INTERVAL = 50;

export interface HistoryPacket {
  marker: boolean,
  // the rtp payload before transport encryption (after e2e encryption)
  payload: Buffer,
  payloadType: number,
  resentAt: number,
  sentAt: number,
  timestamp: number,
}

/**
 * The video packets we sent recently, keyed by sequence number
 */
export class MediaPacketHistory {
  packets = new Map<number, HistoryPacket>();

  add(
    sequence: number,
    packet: {marker: boolean, payload: Buffer, payloadType: number, timestamp: number},
    now: number = Date.now(),
  ): void {
    // keep insertion order matching send order, a reused sequence number goes to the end
    this.packets.delete(sequence);
    this.packets.set(sequence, {...packet, resentAt: -Infinity, sentAt: now});
    for (let [oldSequence, old] of this.packets) {
      if (this.packets.size <= HISTORY_MAX_PACKETS && now - old.sentAt < HISTORY_MAX_AGE) {
        break;
      }
      this.packets.delete(oldSequence);
    }
  }

  /**
   * The packet to retransmit, null if it's gone or was just retransmitted
   */
  take(sequence: number, now: number = Date.now()): HistoryPacket | null {
    const packet = this.packets.get(sequence);
    if (!packet || HISTORY_MAX_AGE <= now - packet.sentAt || now - packet.resentAt < HISTORY_RESEND_INTERVAL) {
      return null;
    }
    packet.resentAt = now;
    return packet;
  }

  clear(): void {
    this.packets.clear();
  }
}
