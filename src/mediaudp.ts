import * as dgram from 'dgram';

import { EventSpewer, Timers } from 'detritus-utils';

import {
  MediaCodecs,
  MediaCodecTypes,
  MediaEncryptionModes,
  MediaProtocols,
  MediaSilencePacket,
  MediaSSRCTypes,
  RTCPPacketTypes,
  RTCPPayloadFeedbackTypes,
  RTCPTransportFeedbackTypes,
  RTPPayloadTypes,
  SocketEvents,
  SocketInternalCloseCodes,
  MEDIA_CODECS_AUDIO,
  MEDIA_CODECS_VIDEO,
  MEDIA_ENCRYPTION_MODES,
  RTCP_HEADER_VERSION,
  RTP_PAYLOAD_TYPES,
  RTCP_PACKET_TYPES,
} from './constants';
import {
  MediaPacketError,
  MediaRTPError,
} from './errors';
import { Socket as MediaSocket } from './media';
import {
  MediaFrameAssembler,
  MediaNackTracker,
  MediaPacketHistory,
  isKeyframe,
  packetize,
  sequenceDistance,
} from './mediaframes';
import {
  isValidRTPHeader,
  RTPHeader,
  RTPNonce,
} from './mediapackets/rtp';
import RTPCrypto, { RTP_NONCE_LENGTH } from './mediapackets/rtpcrypto';


const IP_DISCOVERY_ATTEMPTS = 5;
const IP_DISCOVERY_INTERVAL = 1000;

// 20ms of 48kHz opus, the rtp timestamp step for one audio frame
const AUDIO_FRAME_SAMPLES = 960;
// keeps the NAT mapping open while we aren't sending any audio (receive-only/idle), same as discord.js
const KEEPALIVE_INTERVAL = 5000;
// while a video stream can't be decoded, how often we ask its sender for a keyframe
const KEYFRAME_REQUEST_INTERVAL = 500;
// rtpsize modes leave the rtcp header and the sender's ssrc unencrypted, same as the 12 byte header of rtp packets
const RTCP_HEADER_LENGTH = 8;
const KEEPALIVE_PACKET_LENGTH = 8;

// `Object.values()` of a numeric enum also has the enum's names in it, keep the numbers in sets for the per packet lookups
const RTCP_PACKET_TYPE_SET = new Set<number>((RTCP_PACKET_TYPES as ReadonlyArray<any>).filter((x) => typeof(x) === 'number'));
const RTP_PAYLOAD_TYPE_SET = new Set<number>((RTP_PAYLOAD_TYPES as ReadonlyArray<any>).filter((x) => typeof(x) === 'number'));
// we advertise each video codec's retransmission (rtx) payload type as its payload type + 1
const RTP_RTX_PAYLOAD_TYPE_SET = new Set<number>([RTPPayloadTypes.VP8 + 1, RTPPayloadTypes.VP9 + 1, RTPPayloadTypes.H264 + 1]);
// frames are sent every 20ms, most without options, don't allocate an empty object for each (the options are only read)
const DEFAULT_FRAME_OPTIONS: FrameOptions = Object.freeze({});

export interface FrameOptions {
  incrementNonce?: boolean,
  incrementSequence?: boolean,
  incrementTimestamp?: boolean,
  nonce?: number,
  sequence?: number,
  timestamp?: number,
  type?: string,
  useCache?: boolean,
}

export interface IpInformation {
  ip: null | string,
  port: null | number,
};

export interface RTPPayload {
  header: RTPHeader,
  nonce?: Buffer,
  payload?: Buffer,
}

export interface TransportPacket {
  codec: MediaCodecs | null,
  data: Buffer,
  format: MediaCodecTypes | null,
  from: UDPFrom,
  rtp?: RTPPayload,
  // the stream the packet belongs to, there's a user id once discord tells us whose it is (SPEAKING)
  ssrc: number,
  userId: null | string,
}

export interface MediaCodecDescription {
  decode?: boolean,
  encode?: boolean,
  name: string,
  payload_type: number,
  priority: number,
  rtx_payload_type?: number,
  type: string,
}

export interface TransportFrame {
  codec: MediaCodecs,
  // the encoded frame, e2e decrypted. h264 comes as annex b (start code prefixed nal units), ready for a decoder
  data: Buffer,
  keyframe: boolean,
  ssrc: number,
  // rtp timestamp, video runs on a 90kHz clock
  timestamp: number,
  userId: null | string,
}

export interface UDPFrom {
  address: string,
  family: string,
  port: number,
  size: number,
}


export class Socket extends EventSpewer {
  codecs: {
    audio: null | string,
    video: null | string,
  };
  connected: boolean;
  // keyed by ssrc, one per incoming video stream
  frameAssemblers = new Map<number, MediaFrameAssembler>();
  // keyed by ssrc, when we last asked that stream's sender for a keyframe
  keyframeRequests = new Map<number, number>();
  // keyed by ssrc, the holes in each incoming video stream we're asking retransmissions for
  nackTrackers = new Map<number, MediaNackTracker>();
  // the vp8/vp9 picture id `sendVideo` gives the next frame
  pictureId: number = Math.floor(Math.random() * 0x7FFF);
  // the video codec we'd like to send, it goes first in the codecs we give the voice server
  preferredVideoCodec: MediaCodecs | null = null;
  // the video packets we sent recently, to retransmit the ones viewers nack
  sendHistory = new MediaPacketHistory();
  headers: {
    audio: RTPHeader,
    // retransmissions go out as their own stream (RFC 4588), with their own sequence numbers
    rtx?: RTPHeader,
    video?: RTPHeader,
  };
  key: null | Uint8Array;
  keepAlive = {
    counter: 0,
    interval: new Timers.Interval(),
    intervalTime: KEEPALIVE_INTERVAL,
  };
  local: IpInformation;
  mediaGateway: MediaSocket;
  mode: null | string;
  nonces: {
    audio: RTPNonce,
    video?: RTPNonce,
  };
  remote: IpInformation;
  socket: dgram.Socket | null;
  ssrc: number;
  transportId: null | string;

  constructor(mediaGateway: MediaSocket) {
    super();

    this.mediaGateway = mediaGateway;
    this.onSend = this.onSend.bind(this);

    this.connected = false;
    this.key = null;
    this.mode = null;
    this.socket = null;
    this.ssrc = 0;
    this.transportId = null;

    Object.defineProperty(this, 'mediaGateway', {
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(this, 'keepAlive', {enumerable: false, writable: false});
    // a keepalive alone shouldn't keep the process running
    this.keepAlive.interval.unref();

    this.headers = {audio: new RTPHeader({randomize: true})};
    this.nonces = {audio: new RTPNonce({randomize: true})};

    if (this.videoEnabled) {
      this.headers.rtx = new RTPHeader({randomize: true});
      this.headers.video = new RTPHeader({randomize: true});
      this.nonces.video = new RTPNonce({randomize: true});
    }

    this.codecs = {
      audio: null,
      video: null,
    };
    this.local = {
      ip: null,
      port: null,
    };
    this.remote = {
      ip: null,
      port: null,
    };
  }

  get audioSSRC(): number {
    return this.mediaGateway.audioSSRC;
  }

  get videoSSRC(): number {
    return this.mediaGateway.videoSSRC;
  }

  get rtxSSRC(): number {
    return this.mediaGateway.rtxSSRC;
  }

  get rtpAudioPayloadType(): null | number {
    switch (this.codecs.audio) {
      case MediaCodecs.OPUS: {
        return RTPPayloadTypes.OPUS;
      };
    }
    return null;
  }

  get rtpVideoPayloadType(): null | number {
    switch (this.codecs.video) {
      case MediaCodecs.VP8: {
        return RTPPayloadTypes.VP8;
      };
      case MediaCodecs.VP9: {
        return RTPPayloadTypes.VP9;
      };
      case MediaCodecs.H264: {
        return RTPPayloadTypes.H264;
      };
    }
    return null;
  }

  get rtpRTXPayloadType(): null | number {
    const payloadType = this.rtpVideoPayloadType;
    if (payloadType !== null) {
      return payloadType + 1;
    }
    return null;
  }

  get receiveEnabled(): boolean {
    return this.mediaGateway.receiveEnabled;
  }

  get videoEnabled(): boolean {
    return this.mediaGateway.videoEnabled;
  }

  setAudioCodec(
    codec?: MediaCodecs | null | string,
  ): Socket {
    if (!codec) {
      return this;
    }
    if (!MEDIA_CODECS_AUDIO.includes(codec as MediaCodecs)) {
      this.emit(SocketEvents.WARN, new Error(`Unsupported audio codec received: ${codec}`));
      this.mediaGateway.kill();
      return this;
    }
    this.codecs.audio = codec as MediaCodecs;
    this.headers.audio.setPayloadType(this.rtpAudioPayloadType!);
    return this;
  }

  setVideoCodec(
    codec?: MediaCodecs | null | string,
  ): Socket {
    if (!codec) {
      return this;
    }
    if (!MEDIA_CODECS_VIDEO.includes(codec as MediaCodecs)) {
      this.emit(SocketEvents.WARN, new Error(`Unsupported video codec received: ${codec}`));
      this.mediaGateway.kill();
      return this;
    }
    const changed = this.codecs.video !== codec;
    this.codecs.video = codec as MediaCodecs;
    if (this.headers.video) {
      this.headers.video.setPayloadType(this.rtpVideoPayloadType!);
    }
    if (changed) {
      // the codec everyone in the call can decode, video we send has to switch to it (SESSION_UPDATE changes it mid call)
      this.emit(SocketEvents.VIDEO_CODEC, codec);
    }
    return this;
  }

  /**
   * What we can send and receive, the voice server picks the video codec we send from these (lower priority goes first)
   */
  getCodecs(): Array<MediaCodecDescription> {
    const codecs: Array<MediaCodecDescription> = [];

    MEDIA_CODECS_AUDIO.forEach((codec: string, i: number) => {
      let rtpPayloadType = 0;
      switch (codec) {
        case MediaCodecs.OPUS: {
          rtpPayloadType = RTPPayloadTypes.OPUS;
        }; break;
      }
      codecs.push({
        name: codec,
        payload_type: rtpPayloadType,
        priority: (i + 1) * 1000,
        type: MediaCodecTypes.AUDIO,
      });
    });

    if (this.videoEnabled) {
      const videoCodecs = MEDIA_CODECS_VIDEO.slice();
      if (this.preferredVideoCodec) {
        videoCodecs.splice(videoCodecs.indexOf(this.preferredVideoCodec), 1);
        videoCodecs.unshift(this.preferredVideoCodec);
      }
      videoCodecs.forEach((codec: string, i: number) => {
        let rtpPayloadType = 0;
        switch (codec) {
          case MediaCodecs.VP8: {
            rtpPayloadType = RTPPayloadTypes.VP8;
          }; break;
          case MediaCodecs.VP9: {
            rtpPayloadType = RTPPayloadTypes.VP9;
          }; break;
          case MediaCodecs.H264: {
            rtpPayloadType = RTPPayloadTypes.H264;
          }; break;
        }
        codecs.push({
          // we pass encoded frames through, what we can send/receive is up to whoever makes or uses them
          decode: true,
          encode: true,
          name: codec,
          payload_type: rtpPayloadType,
          priority: (i + 1) * 1000,
          rtx_payload_type: rtpPayloadType + 1,
          type: MediaCodecTypes.VIDEO,
        });
      });
    }
    return codecs;
  }

  /**
   * Asks the voice server to have us send `codec` (SESSION_UPDATE), its answer comes as a `videoCodec` event
   * It can still pick another one, every viewer has to be able to decode what we send
   */
  setPreferredVideoCodec(codec: MediaCodecs | string): Socket {
    if (!MEDIA_CODECS_VIDEO.includes(codec as MediaCodecs)) {
      throw new Error(`Unsupported video codec ${codec}`);
    }
    this.preferredVideoCodec = codec as MediaCodecs;
    if (this.connected) {
      this.mediaGateway.sendSessionUpdate({codecs: this.getCodecs()});
    }
    return this;
  }

  setKey(
    value: Array<number>,
  ): Socket {
    Object.defineProperty(this, 'key', {
      value: Uint8Array.from(value),
    });
    return this;
  }

  setMode(
    value: string,
  ): Socket {
    if (!MEDIA_ENCRYPTION_MODES.includes(value as MediaEncryptionModes) || !RTPCrypto.isModeAvailable(value)) {
      throw new Error(`Encryption mode '${value}' is not supported.`);
    }
    Object.defineProperty(this, 'mode', {value});
    return this;
  }

  setSSRC(
    value: number,
  ): Socket {
    Object.defineProperty(this, 'ssrc', {value});
    this.headers.audio.setSSRC(this.audioSSRC);
    if (this.headers.video) {
      this.headers.video.setSSRC(this.videoSSRC);
    }
    if (this.headers.rtx) {
      this.headers.rtx.setSSRC(this.rtxSSRC);
    }
    return this;
  }

  setTransportId(
    value: string,
  ): Socket {
    Object.defineProperty(this, 'transportId', {value});
    return this;
  }

  connect(
    ip: null | string = null,
    port: null | number = null,
  ): Socket {
    this.remote.ip = ip || this.remote.ip;
    this.remote.port = port || this.remote.port;
    if (this.connected) {
      this.disconnect();
    }
    // a key from a previous voice session would encrypt frames the new server can't decrypt, wait for its session description
    this.key = null;

    const socket = this.socket = dgram.createSocket('udp4');
    const ipDiscoveryInterval = new Timers.Interval();
    // dgram emits events asynchronously, ignore anything from a socket we've already replaced/disconnected
    const onPacket = (packet: Buffer, from: UDPFrom) => {
      if (this.socket === socket) {
        this.onPacket(packet, from);
      }
    };
    this.emit(SocketEvents.SOCKET, socket);
    const onIpDiscovery = (packet: Buffer) => {
      if (this.socket !== socket) {
        return;
      }
      // response: uint16 type (0x2) | uint16 length (70) | uint32 ssrc | 64 byte null-terminated address | uint16 port
      if (packet.length !== 74 || packet.readUInt16BE(0) !== 2) {
        // rtp/rtcp packets can arrive before discovery finishes, only warn about packets that look like discovery responses
        if (packet.length === 74) {
          this.emit(SocketEvents.WARN, new Error('Received an invalid ip discovery packet'));
        }
        return;
      }
      if (this.ssrc !== packet.readUInt32BE(4)) {
        this.emit(SocketEvents.WARN, new Error('SSRC mismatch in ip discovery packet'));
        return;
      }
      socket.removeListener('message', onIpDiscovery);
      ipDiscoveryInterval.stop();
      this.mediaGateway.ipDiscoveryFailures = 0;

      let addressEnd = packet.indexOf(0, 8);
      if (addressEnd === -1 || 72 < addressEnd) {
        addressEnd = 72;
      }
      this.local.ip = packet.toString('utf8', 8, addressEnd);
      this.local.port = packet.readUInt16BE(72);

      this.mediaGateway.sendSelectProtocol({
        codecs: this.getCodecs(),
        data: {
          address: this.local.ip!,
          mode: this.mode!,
          port: this.local.port!,
        },
        protocol: MediaProtocols.UDP,
      });
      this.mediaGateway.sendClientConnect();

      socket.on('message', onPacket);
      this.startKeepAlive();
      this.emit(SocketEvents.READY);
    };
    socket.on('message', onIpDiscovery);

    socket.on('close', () => {
      ipDiscoveryInterval.stop();
      socket.removeListener('message', onIpDiscovery);
      socket.removeListener('message', onPacket);
      // `close` fires asynchronously, after `disconnect()` and possibly after a new socket was created by `connect()`
      if (this.socket === socket) {
        this.connected = false;
        this.socket = null;
        this.key = null;
        this.keepAlive.interval.stop();
        this.emit(SocketEvents.CLOSE);
      } else if (!this.socket) {
        // closed via `disconnect()`, no new socket replaced it
        this.emit(SocketEvents.CLOSE);
      }
    });

    socket.on('error', (error: any) => {
      this.emit(SocketEvents.WARN, error);
    });

    this.connected = true;

    const ipDiscovery = Buffer.alloc(74);
    ipDiscovery.writeUIntBE(1, 0, 2);
    ipDiscovery.writeUIntBE(70, 2, 2);
    ipDiscovery.writeUIntBE(this.ssrc, 4, 4);

    // udp is lossy, resend the discovery packet until we get a response
    let attempts = 1;
    ipDiscoveryInterval.start(IP_DISCOVERY_INTERVAL, () => {
      if (this.socket !== socket) {
        ipDiscoveryInterval.stop();
        return;
      }
      if (IP_DISCOVERY_ATTEMPTS <= attempts) {
        ipDiscoveryInterval.stop();
        const error = new Error(`IP discovery failed after ${attempts} attempts`);
        this.emit(SocketEvents.WARN, error);
        this.disconnect();

        const mediaGateway = this.mediaGateway;
        if (mediaGateway.gateway.reconnectMax <= ++mediaGateway.ipDiscoveryFailures) {
          mediaGateway.kill(error);
        } else {
          // re-identify to get a new udp endpoint instead of leaving the voice channel
          mediaGateway.identified = false;
          mediaGateway.disconnect(SocketInternalCloseCodes.RECONNECTING);
        }
        return;
      }
      attempts++;
      try {
        this.send(ipDiscovery);
      } catch(error) {
        this.emit(SocketEvents.WARN, error);
      }
    });
    this.send(ipDiscovery);
    return this;
  }

  disconnect(): void {
    this.keepAlive.interval.stop();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    // the next connection is a new voice session with a new key
    this.key = null;
    this.frameAssemblers.clear();
    this.keyframeRequests.clear();
    this.nackTrackers.clear();
    this.sendHistory.clear();
    this.headers.audio.reset();
    if (this.headers.video) {
      this.headers.video.reset();
    }
    if (this.headers.rtx) {
      this.headers.rtx.reset();
    }
    this.connected = false;
  }

  onPacket(packet: Buffer, from: UDPFrom): void {
    // rtcp is feedback on what we send (nacks, keyframe requests), it matters even when we don't receive media
    if (!this.receiveEnabled && !RTCP_PACKET_TYPE_SET.has(packet[1])) {return;}
    if (from.address !== this.remote.ip || from.port !== this.remote.port) {
      const error = new MediaPacketError('Received a packet from an unknown IP/Port', from, packet);
      this.emit(SocketEvents.WARN, error);
      return;
    }
    if (packet.length === KEEPALIVE_PACKET_LENGTH) {
      // the server echoes our keepalives back
      return;
    }
    if (!this.key) {
      const error = new MediaPacketError('Received a packet before the Session Description', from, packet);
      this.emit(SocketEvents.WARN, error);
      return;
    }
    if (packet.length <= 12) {
      const error = new MediaPacketError('Received an rtp packet that\'s way too small to be valid', from, packet);
      this.emit(SocketEvents.WARN, error);
      return;
    }
    if (!isValidRTPHeader(packet)) {
      const error = new MediaPacketError('Invalid RTP Packet', from, packet);
      this.emit(SocketEvents.WARN, error);
      return;
    }

    const packetType = packet[1];
    if (RTCP_PACKET_TYPE_SET.has(packetType)) {
      this.onRTCPPacket(packet, from);
    } else {
      // read what we need from the bytes first, packets we drop never need the header object
      let payloadType = packetType & 0x7F;
      // a retransmission has its original packet's payload type + 1, it's unwrapped once decrypted
      const isRetransmission = RTP_RTX_PAYLOAD_TYPE_SET.has(payloadType);
      if (isRetransmission) {
        payloadType--;
      }
      if (!RTP_PAYLOAD_TYPE_SET.has(payloadType)) {
        // the server probes bandwidth with payload types we never negotiated
        this.emitRTPError(SocketEvents.LOG, 'Unknown RTP Packet Payload Type', from, packet);
        return;
      }

      let codec: MediaCodecs | null = null;
      let format: MediaCodecTypes| null = null;
      switch (payloadType) {
        case RTPPayloadTypes.OPUS: {
          codec = MediaCodecs.OPUS;
          format = MediaCodecTypes.AUDIO;
        }; break;
        case RTPPayloadTypes.VP8: {
          codec = MediaCodecs.VP8;
          format = MediaCodecTypes.VIDEO;
        }; break;
        case RTPPayloadTypes.VP9: {
          codec = MediaCodecs.VP9;
          format = MediaCodecTypes.VIDEO;
        }; break;
        case RTPPayloadTypes.H264: {
          codec = MediaCodecs.H264;
          format = MediaCodecTypes.VIDEO;
        }; break;
      }

      if (format === MediaCodecTypes.VIDEO && !this.videoEnabled) {
        this.emitRTPError(SocketEvents.LOG, 'Dropping video packet due to video not being enabled', from, packet);
        return;
      }

      const rtp: RTPPayload = {
        header: RTPHeader.fromBuffer(packet.subarray(0, 12)),
      };

      // rtpsize modes: the header (including csrcs and the extension preamble) is unencrypted and used as the additional data
      let headerLength = 12 + (rtp.header.csrcCount * 4);
      let extensionLength = 0;
      if (rtp.header.extension) {
        if (packet.length < headerLength + 4) {
          this.emitRTPError(SocketEvents.WARN, 'Received an rtp packet with a truncated header extension', from, packet, rtp);
          return;
        }
        // RFC3550 Section 5.3.1, length is in 32-bit words and excludes the 4 byte preamble
        extensionLength = packet.readUInt16BE(headerLength + 2) * 4;
        headerLength += 4;
      }
      if (packet.length < headerLength + RTP_NONCE_LENGTH) {
        const error = new MediaRTPError('Received an rtp packet that\'s way too small to be valid', from, packet, rtp);
        this.emit(SocketEvents.WARN, error);
        return;
      }

      rtp.nonce = packet.subarray(packet.length - RTP_NONCE_LENGTH);
      rtp.payload = packet.subarray(headerLength, packet.length - RTP_NONCE_LENGTH);

      let data: Buffer | null = RTPCrypto.decrypt(
        this.mode!,
        this.key!,
        packet.subarray(0, headerLength),
        rtp.payload,
        rtp.nonce,
      );
      if (!data) {
        this.emitRTPError(SocketEvents.WARN, 'Packet failed to decrypt', from, packet, rtp);
        return;
      }

      if (rtp.header.padding && data.length) {
        // RFC3550 Section 5.1
        // last byte contains amount of padding, including itself, slice that stuff off
        data = data.subarray(0, data.length - data.readUInt8(data.length - 1));
      }

      if (extensionLength) {
        // the header extension's body is encrypted along with the payload, we don't use it
        data = data.subarray(extensionLength);
      }

      let ssrc = rtp.header.ssrc;
      let sequence = rtp.header.sequence;
      if (isRetransmission) {
        if (data.length < 2) {
          // padding only, sent to probe bandwidth
          return;
        }
        const videoSSRC = this.mediaGateway.rtxToSSRC(ssrc);
        if (videoSSRC === null) {
          this.emitRTPError(SocketEvents.LOG, 'Dropping rtx packet from an unknown ssrc', from, packet, rtp);
          return;
        }
        // RFC 4588 Section 4, the original sequence number goes in front of the original payload
        sequence = data.readUInt16BE(0);
        data = data.subarray(2);
        ssrc = videoSSRC;
      }

      let userId: null | string = null;
      if (format !== null) {
        switch (format) {
          case MediaCodecTypes.AUDIO: {
            userId = this.mediaGateway.ssrcToUserId(ssrc, MediaSSRCTypes.AUDIO);
          }; break;
          case MediaCodecTypes.VIDEO: {
            userId = this.mediaGateway.ssrcToUserId(ssrc, MediaSSRCTypes.VIDEO);
          }; break;
        }
      }

      if (isRetransmission) {
        // only goes into frames, the `packet` event stays the packets as they came in on their own ssrc
        this.onVideoPacket(codec!, ssrc, sequence, rtp.header.timestamp, !!rtp.header.marker, data, userId);
        return;
      }

      const dave = this.mediaGateway.dave;
      if (dave && format === MediaCodecTypes.AUDIO) {
        if (userId === null) {
          this.emitRTPError(SocketEvents.LOG, 'Dropping audio packet from an unknown ssrc, cannot e2e decrypt it', from, packet, rtp);
          return;
        }
        const decrypted = dave.decrypt(data, userId);
        if (!decrypted) {
          this.emitRTPError(SocketEvents.LOG, 'Packet failed to e2e decrypt', from, packet, rtp);
          return;
        }
        data = decrypted;
      }

      this.emit(SocketEvents.PACKET, {
        codec,
        data,
        format,
        from,
        rtp,
        ssrc: rtp.header.ssrc,
        userId,
      } as TransportPacket);

      if (format === MediaCodecTypes.VIDEO) {
        this.onVideoPacket(codec!, ssrc, sequence, rtp.header.timestamp, !!rtp.header.marker, data, userId);
      }
    }
  }

  onVideoPacket(
    codec: MediaCodecs,
    ssrc: number,
    sequence: number,
    timestamp: number,
    marker: boolean,
    data: Buffer,
    userId: null | string,
  ): void {
    let assembler = this.frameAssemblers.get(ssrc);
    if (!assembler || assembler.codec !== codec) {
      assembler = new MediaFrameAssembler(codec);
      this.frameAssemblers.set(ssrc, assembler);
    }

    // ask for whatever went missing first, a retransmission is a lot quicker than a keyframe
    let tracker = this.nackTrackers.get(ssrc);
    if (!tracker) {
      tracker = new MediaNackTracker();
      this.nackTrackers.set(ssrc, tracker);
    }
    const missing = tracker.push(sequence);
    if (missing.length) {
      this.sendNack(ssrc, missing);
    }

    const { frames, requestKeyframe } = assembler.push(sequence, timestamp, marker, data);
    if (requestKeyframe) {
      this.requestKeyframe(ssrc);
    }

    const dave = this.mediaGateway.dave;
    for (let frame of frames) {
      let frameData: Buffer | null = frame.data;
      if (dave) {
        if (userId === null) {
          this.emit(SocketEvents.LOG, new Error(`Dropping video frame from an unknown ssrc ${ssrc}, cannot e2e decrypt it`));
          continue;
        }
        frameData = dave.decryptVideo(frame.data, userId);
        if (!frameData) {
          this.emit(SocketEvents.LOG, new Error(`Video frame from ssrc ${ssrc} failed to e2e decrypt`));
          if (frame.keyframe) {
            // whatever comes next depends on this keyframe
            assembler.waitingForKeyframe = true;
            this.requestKeyframe(ssrc);
          }
          continue;
        }
      }

      this.emit(SocketEvents.FRAME, {
        codec,
        data: frameData,
        keyframe: frame.keyframe,
        ssrc,
        timestamp: frame.timestamp,
        userId,
      } as TransportFrame);
    }
  }

  /**
   * Asks the sender of a video stream for a keyframe (rtcp picture loss indication), at most every 500ms per stream
   */
  requestKeyframe(ssrc: number, force: boolean = false): void {
    const now = Date.now();
    const last = this.keyframeRequests.get(ssrc);
    if (!force && last !== undefined && now - last < KEYFRAME_REQUEST_INTERVAL) {
      return;
    }
    this.keyframeRequests.set(ssrc, now);
    this.sendPictureLossIndication(ssrc);
  }

  /**
   * RFC 4585 Section 6.3.1
   */
  sendPictureLossIndication(mediaSSRC: number): void {
    this.sendFeedback(RTCPPacketTypes.PSFB, RTCPPayloadFeedbackTypes.PLI, mediaSSRC);
  }

  /**
   * RFC 4585 Section 6.2.1, each entry is a lost sequence number and a bitmask of which of the 16 after it are lost too
   */
  sendNack(mediaSSRC: number, sequences: Array<number>): void {
    const entries: Array<{bitmask: number, sequence: number}> = [];
    for (let sequence of sequences) {
      const entry = entries.find((x) => {
        const distance = sequenceDistance(x.sequence, sequence);
        return 1 <= distance && distance <= 16;
      });
      if (entry) {
        entry.bitmask |= 1 << (sequenceDistance(entry.sequence, sequence) - 1);
      } else {
        entries.push({bitmask: 0, sequence});
      }
    }

    const fci = Buffer.alloc(entries.length * 4);
    entries.forEach((entry, i) => {
      fci.writeUInt16BE(entry.sequence, i * 4);
      fci.writeUInt16BE(entry.bitmask, i * 4 + 2);
    });
    this.sendFeedback(RTCPPacketTypes.RTPFB, RTCPTransportFeedbackTypes.NACK, mediaSSRC, fci);
  }

  /**
   * RFC 4585 Section 6.1, a feedback message about one of the streams we receive
   */
  sendFeedback(
    packetType: RTCPPacketTypes,
    format: number,
    mediaSSRC: number,
    fci: Buffer = Buffer.alloc(0),
  ): void {
    if (!this.connected || !this.key) {
      return;
    }
    const header = Buffer.alloc(RTCP_HEADER_LENGTH);
    header.writeUInt8(RTCP_HEADER_VERSION | format, 0);
    header.writeUInt8(packetType, 1);
    // length in 32-bit words minus one, the header, both ssrcs and the feedback entries
    header.writeUInt16BE(2 + (fci.length / 4), 2);
    header.writeUInt32BE(this.audioSSRC, 4);

    const payload = Buffer.alloc(4 + fci.length);
    payload.writeUInt32BE(mediaSSRC >>> 0, 0);
    fci.copy(payload, 4);

    // shares the audio nonce counter so the two never reuse a nonce under the same key
    const nonce = this.nonces.audio.set();
    this.send(RTPCrypto.encryptPacket(this.mode!, this.key!, header, payload, nonce));
  }

  /**
   * rtpsize modes leave the first header and sender ssrc unencrypted, everything after it (other packets of a compound
   * packet included) is encrypted like an rtp payload
   */
  onRTCPPacket(packet: Buffer, from: UDPFrom): void {
    if (packet.length < RTCP_HEADER_LENGTH + RTP_NONCE_LENGTH) {
      return;
    }
    const header = packet.subarray(0, RTCP_HEADER_LENGTH);
    const data = RTPCrypto.decrypt(
      this.mode!,
      this.key!,
      header,
      packet.subarray(RTCP_HEADER_LENGTH, packet.length - RTP_NONCE_LENGTH),
      packet.subarray(packet.length - RTP_NONCE_LENGTH),
    );
    if (!data) {
      if (this.hasEventListener(SocketEvents.LOG)) {
        this.emit(SocketEvents.LOG, new MediaPacketError('RTCP packet failed to decrypt', from, packet));
      }
      return;
    }

    const rtcp = Buffer.concat([header, data]);
    let offset = 0;
    while (offset + RTCP_HEADER_LENGTH <= rtcp.length) {
      const first = rtcp[offset];
      // RFC 3550 Section 6.4.1, length is in 32-bit words minus one
      const length = (rtcp.readUInt16BE(offset + 2) + 1) * 4;
      if ((first & 0xC0) !== RTCP_HEADER_VERSION || rtcp.length < offset + length) {
        break;
      }
      this.onRTCPFeedback(rtcp[offset + 1], first & 0x1F, rtcp.subarray(offset, offset + length));
      offset += length;
    }
  }

  onRTCPFeedback(packetType: number, format: number, packet: Buffer): void {
    if (!this.videoEnabled || packet.length < 12) {
      return;
    }
    const videoSSRC = this.videoSSRC;
    const mediaSSRC = packet.readUInt32BE(8);
    switch (packetType) {
      case RTCPPacketTypes.RTPFB: {
        if (format === RTCPTransportFeedbackTypes.NACK && mediaSSRC === videoSSRC) {
          const sequences: Array<number> = [];
          for (let offset = 12; offset + 4 <= packet.length; offset += 4) {
            const sequence = packet.readUInt16BE(offset);
            const bitmask = packet.readUInt16BE(offset + 2);
            sequences.push(sequence);
            for (let bit = 0; bit < 16; bit++) {
              if (bitmask & (1 << bit)) {
                sequences.push((sequence + bit + 1) & 0xFFFF);
              }
            }
          }
          this.retransmit(sequences);
        }
      }; break;
      case RTCPPacketTypes.PSFB: {
        let requested = false;
        if (format === RTCPPayloadFeedbackTypes.PLI) {
          requested = mediaSSRC === videoSSRC;
        } else if (format === RTCPPayloadFeedbackTypes.FIR) {
          // RFC 5104 Section 4.3.1, the ssrcs asked for are in the entries
          for (let offset = 12; offset + 8 <= packet.length; offset += 8) {
            requested = requested || packet.readUInt32BE(offset) === videoSSRC;
          }
        }
        if (requested) {
          // a viewer lost something or just started watching, only whoever encodes the video can make a keyframe
          this.emit(SocketEvents.KEYFRAME_REQUEST, {ssrc: videoSSRC});
        }
      }; break;
    }
  }

  /**
   * RFC 4588, resends the packets viewers nack'd on our retransmission stream
   */
  retransmit(sequences: Array<number>): void {
    const header = this.headers.rtx;
    if (!header || !this.connected || !this.key) {
      return;
    }
    for (let sequence of sequences) {
      const packet = this.sendHistory.take(sequence);
      if (!packet) {
        continue;
      }
      header.setPayloadType(packet.payloadType + 1);
      header.setMarker(packet.marker);
      header.setSequence();
      header.setTimestamp(packet.timestamp);

      // the original sequence number goes in front of the original payload
      const payload = Buffer.allocUnsafe(2 + packet.payload.length);
      payload.writeUInt16BE(sequence, 0);
      packet.payload.copy(payload, 2);

      const nonce = this.nonces.video!.set();
      this.send(RTPCrypto.encryptPacket(this.mode!, this.key!, header.buffer, payload, nonce));
    }
  }

  deleteFrameAssembler(ssrc: number): void {
    this.frameAssemblers.delete(ssrc);
    this.keyframeRequests.delete(ssrc);
    this.nackTrackers.delete(ssrc);
  }

  /**
   * Only builds the error (and its stack trace) when something listens for it, dropped packets can come in at hundreds a second
   */
  emitRTPError(
    event: string,
    message: string,
    from: UDPFrom,
    packet: Buffer,
    rtp?: RTPPayload,
  ): void {
    if (this.hasEventListener(event)) {
      if (!rtp) {
        rtp = {header: RTPHeader.fromBuffer(packet.subarray(0, 12))};
      }
      const error = new MediaRTPError(message, from, packet, rtp);
      this.emit(event, error);
    }
  }

  onSend(error: any, bytes: number): void {
    if (error) {
      this.emit(SocketEvents.WARN, error);
    }
  }

  startKeepAlive(): void {
    const socket = this.socket;
    this.keepAlive.counter = 0;
    this.keepAlive.interval.start(this.keepAlive.intervalTime, () => {
      if (!this.connected || !this.socket || this.socket !== socket) {
        this.keepAlive.interval.stop();
        return;
      }
      // 8 bytes, an incrementing uint32 (little endian) in the first 4
      const packet = Buffer.alloc(KEEPALIVE_PACKET_LENGTH);
      packet.writeUInt32LE(this.keepAlive.counter, 0);
      this.keepAlive.counter = (this.keepAlive.counter + 1) >>> 0;
      try {
        this.send(packet);
      } catch(error) {
        this.emit(SocketEvents.WARN, error);
      }
    });
  }

  send(packet: Buffer): void {
    if (!this.connected || !this.socket) {
      throw new Error('UDP is not connected yet!');
    }

    this.socket.send(
      packet,
      0,
      packet.length,
      this.remote.port!,
      this.remote.ip!,
      this.onSend,
    );
  }

  sendAudioFrame(
    packet: Buffer,
    options?: FrameOptions,
  ): void {
    this._sendFrame(packet, MediaCodecTypes.AUDIO, options);
  }

  sendVideoFrame(
    packet: Buffer,
    options?: FrameOptions,
  ): void {
    this._sendFrame(packet, MediaCodecTypes.VIDEO, options);
  }

  /**
   * Sends a whole encoded video frame (vp8/vp9, or h264 as annex b): e2e encrypts it, splits it into rtp packets and
   * sends them with the frame's timestamp, the marker bit on the last one. Pacing is up to the caller, this sends now
   * Returns false if it couldn't be sent, viewers can't decrypt anything before we're in the DAVE group, so the frame
   * gets dropped then. Nothing after a dropped frame decodes until the next keyframe, check `keyframe` to know
   */
  sendVideo(
    frame: Buffer,
    options: {
      // the codec the voice server picked (`codecs.video`) unless you know better
      codec?: MediaCodecs | string,
      // worked out from the frame when left out
      keyframe?: boolean,
      // 90kHz rtp timestamp, frames should go up by 90000 / fps
      timestamp: number,
    },
  ): boolean {
    if (!this.videoEnabled) {
      throw new Error('Cannot send video when video is disabled!');
    }
    const codec = options.codec || this.codecs.video;
    if (!codec) {
      throw new Error('No video codec yet, wait for the transport to be ready');
    }
    const header = this.headers.video!;
    if (!this.connected || !this.key) {
      return false;
    }
    const dave = this.mediaGateway.dave;
    if (dave && dave.protocolVersion !== 0 && !dave.ready) {
      return false;
    }

    const keyframe = (options.keyframe === undefined) ? isKeyframe(codec, frame) : options.keyframe;
    const data = (dave) ? dave.encryptVideo(frame, codec) : frame;
    const packets = packetize(codec, data, {keyframe, pictureId: this.pictureId});
    this.pictureId = (this.pictureId + 1) & 0x7FFF;

    header.setPayloadType(RTPPayloadTypes[codec as keyof typeof RTPPayloadTypes]);
    for (let i = 0; i < packets.length; i++) {
      // every packet of a frame shares its timestamp, the last one gets the marker bit
      header.setMarker(i === packets.length - 1);
      this._sendFrame(packets[i], MediaCodecTypes.VIDEO, {
        incrementSequence: true,
        sequence: 1,
        timestamp: options.timestamp >>> 0,
      });
    }
    header.setMarker(false);
    return true;
  }

  sendFrame(
    packet: Buffer,
    options: FrameOptions = DEFAULT_FRAME_OPTIONS,
  ): void {
    this._sendFrame(packet, options.type!, options);
  }

  _sendFrame(
    packet: Buffer,
    type: string,
    options: FrameOptions = DEFAULT_FRAME_OPTIONS,
  ): void {
    // drop frames while (re)connecting, the key only arrives with the new session description
    if (!this.connected || !this.key) {
      return;
    }

    if (type !== MediaCodecTypes.AUDIO && type !== MediaCodecTypes.VIDEO) {
      throw new Error('Invalid frame type');
    }

    const useCache = options.useCache || options.useCache === undefined;
    if (type === MediaCodecTypes.VIDEO && !this.videoEnabled) {
      throw new Error('Cannot send in video frames when video is disabled!');
    }

    const isAudio = (type === MediaCodecTypes.AUDIO);
    const cachedHeader = (isAudio) ? this.headers.audio : this.headers.video!;
    const cachedNonce = (isAudio) ? this.nonces.audio : this.nonces.video!;

    let sequence = options.sequence;
    let incrementSequence = options.incrementSequence;
    let timestamp = options.timestamp;
    let incrementTimestamp = options.incrementTimestamp;
    if (useCache && timestamp === undefined && isAudio) {
      // `setTimestamp(undefined)` picks a random timestamp, which breaks the receiver's jitter buffer, advance by one frame instead
      timestamp = AUDIO_FRAME_SAMPLES;
      incrementTimestamp = true;
    }

    let header: RTPHeader;
    let rtpNonce: RTPNonce;
    if (useCache) {
      header = cachedHeader;
      rtpNonce = cachedNonce;
    } else {
      let payloadType: number, ssrc: number;
      switch (type) {
        case MediaCodecTypes.AUDIO: {
          payloadType = this.rtpAudioPayloadType!;
          ssrc = this.audioSSRC;
        }; break;
        case MediaCodecTypes.VIDEO: {
          payloadType = this.rtpVideoPayloadType!;
          ssrc = this.videoSSRC;
        }; break;
        default: {
          throw new Error(`Invalid type ${type}`);
        };
      }
      header = new RTPHeader({payloadType, ssrc});
      rtpNonce = new RTPNonce({randomize: true});

      if (sequence === undefined) {
        sequence = cachedHeader.sequence;
        incrementSequence = false;
      }
      if (timestamp === undefined) {
        timestamp = cachedHeader.timestamp;
        incrementTimestamp = false;
      }
    }

    header.setSequence(sequence, incrementSequence);
    header.setTimestamp(timestamp, incrementTimestamp);
    const nonce = rtpNonce.set(options.nonce, options.incrementNonce);

    if (!isAudio) {
      // kept for a second to answer nacks with, copied since callers are free to reuse their buffer
      this.sendHistory.add(header.sequence, {
        marker: !!header.marker,
        payload: Buffer.from(packet),
        payloadType: header.payloadType,
        timestamp: header.timestamp,
      });
    }

    const dave = this.mediaGateway.dave;
    if (dave && type === MediaCodecTypes.AUDIO) {
      packet = dave.encrypt(packet);
    }

    // rtpsize modes: rtp header | encrypted payload + auth tag | 4 byte nonce
    this.send(RTPCrypto.encryptPacket(this.mode!, this.key!, header.buffer, packet, nonce));
  }

  sendAudioSilenceFrame(): void {
    this.sendFrame(Buffer.from(MediaSilencePacket), {
      incrementTimestamp: true,
      timestamp: AUDIO_FRAME_SAMPLES,
      type: MediaCodecTypes.AUDIO,
    });
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: 'close', listener: () => any): this;
  on(event: 'killed', listener: () => any): this;
  on(event: 'log', listener: (error: Error) => any): this;
  on(event: 'open', listener: () => any): this;
  on(event: 'frame', listener: (frame: TransportFrame) => any): this;
  on(event: 'keyframeRequest', listener: (request: {ssrc: number}) => any): this;
  on(event: 'videoCodec', listener: (codec: MediaCodecs) => any): this;
  on(event: 'packet', listener: (packet: TransportPacket) => any): this;
  on(event: 'ready', listener: () => any): this;
  on(event: 'socket', listener: (socket: dgram.Socket) => any): this;
  on(event: 'warn', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
