import * as dgram from 'dgram';

import { EventSpewer } from 'detritus-utils';

import {
  MediaCodecs,
  MediaCodecTypes,
  MediaEncryptionModes,
  MediaProtocols,
  MediaSilencePacket,
  MediaSSRCTypes,
  RTPPayloadTypes,
  SocketEvents,
  MEDIA_CODECS_AUDIO,
  MEDIA_CODECS_VIDEO,
  MEDIA_ENCRYPTION_MODES,
  RTP_PAYLOAD_TYPES,
  RTCP_PACKET_TYPES,
} from './constants';
import {
  MediaPacketError,
  MediaRTPError,
} from './errors';
import { Socket as MediaSocket } from './media';
import {
  isValidRTPHeader,
  RTPHeader,
  RTPNonce,
} from './mediapackets/rtp';
import RTPCrypto, { RTP_NONCE_LENGTH } from './mediapackets/rtpcrypto';


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
  headers: {
    audio: RTPHeader,
    video?: RTPHeader,
  };
  key: null | Uint8Array;
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

    this.headers = {audio: new RTPHeader({randomize: true})};
    this.nonces = {audio: new RTPNonce({randomize: true})};

    if (this.videoEnabled) {
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
    this.codecs.video = codec as MediaCodecs;
    if (this.headers.video) {
      this.headers.video.setPayloadType(this.rtpVideoPayloadType!);
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

    const onPacket = this.onPacket.bind(this);
    const socket = this.socket = dgram.createSocket('udp4');
    this.emit(SocketEvents.SOCKET, socket);
    socket.once('message', (packet: Buffer) => {
      if (this.ssrc !== packet.readUInt32BE(4)) {
        this.emit(SocketEvents.WARN, new Error('SSRC mismatch in ip discovery packet'));
        return;
      }

      this.local.ip = packet.slice(8, packet.indexOf(0, 8)).toString();
      this.local.port = packet.readUIntBE(packet.length - 2, 2);

      const codecs: Array<{
        name: string,
        priority: number,
        payload_type: number,
        rtx_payload_type?: number,
        type: string,
      }> = [];

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
        MEDIA_CODECS_VIDEO.forEach((codec: string, i: number) => {
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
            name: codec,
            payload_type: rtpPayloadType,
            priority: (i + 1) * 1000,
            rtx_payload_type: rtpPayloadType + 1,
            type: MediaCodecTypes.VIDEO,
          });
        });
      }

      this.mediaGateway.sendSelectProtocol({
        codecs,
        data: {
          address: this.local.ip!,
          mode: this.mode!,
          port: this.local.port!,
        },
        protocol: MediaProtocols.UDP,
      });
      this.mediaGateway.sendClientConnect();

      socket.on('message', onPacket);
      this.emit(SocketEvents.READY);
    });

    socket.on('close', () => {
      this.connected = false;
      socket.removeListener('message', onPacket);
      this.emit(SocketEvents.CLOSE);
    });

    socket.on('error', (error: any) => {
      this.emit(SocketEvents.WARN, error);
    });

    this.connected = true;

    const ipDiscovery = Buffer.alloc(74);
    ipDiscovery.writeUIntBE(1, 0, 2);
    ipDiscovery.writeUIntBE(70, 2, 2);
    ipDiscovery.writeUIntBE(this.ssrc, 4, 4);
    this.send(ipDiscovery);
    return this;
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.headers.audio.reset();
    if (this.headers.video) {
      this.headers.video.reset();
    }
    this.connected = false;
  }

  onPacket(packet: Buffer, from: UDPFrom): void {
    if (!this.receiveEnabled) {return;}
    if (from.address !== this.remote.ip || from.port !== this.remote.port) {
      const error = new MediaPacketError('Received a packet from an unknown IP/Port', from, packet);
      this.emit(SocketEvents.WARN, error);
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

    const packetType = packet.readUIntBE(1, 1);
    if (RTCP_PACKET_TYPES.includes(packetType)) {

    } else {
      const rtp: RTPPayload = {
        header: new RTPHeader({buffer: packet.slice(0, 12)}),
      };
  
      let payloadType = rtp.header.payloadType;
      /*
      // unknown if this is how it is now
      let isRTX = false;
      if (payloadType === this.rtxPayloadType) {
        payloadType -= 1;
        isRTX = true;
      }
      */
      if (!RTP_PAYLOAD_TYPES.includes(payloadType)) {
        const error = new MediaRTPError('Unknown RTP Packet Payload Type', from, packet, rtp);
        this.emit(SocketEvents.WARN, error);
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
        const error = new MediaRTPError('Dropping video packet due to video not being enabled', from, packet, rtp);
        this.emit(SocketEvents.LOG, error);
        return;
      }

      // rtpsize modes: the header (including csrcs and the extension preamble) is unencrypted and used as the additional data
      let headerLength = 12 + (rtp.header.csrcCount * 4);
      let extensionLength = 0;
      if (rtp.header.extension) {
        if (packet.length < headerLength + 4) {
          const error = new MediaRTPError('Received an rtp packet with a truncated header extension', from, packet, rtp);
          this.emit(SocketEvents.WARN, error);
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
        const error = new MediaRTPError('Packet failed to decrypt', from, packet, rtp);
        this.emit(SocketEvents.WARN, error);
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

      let userId: null | string = null;
      if (format !== null) {
        switch (format) {
          case MediaCodecTypes.AUDIO: {
            userId = this.mediaGateway.ssrcToUserId(rtp.header.ssrc, MediaSSRCTypes.AUDIO);
          }; break;
          case MediaCodecTypes.VIDEO: {
            userId = this.mediaGateway.ssrcToUserId(rtp.header.ssrc, MediaSSRCTypes.VIDEO);
          }; break;
        }
      }

      const dave = this.mediaGateway.dave;
      if (dave && format === MediaCodecTypes.AUDIO) {
        if (userId === null) {
          const error = new MediaRTPError('Dropping audio packet from an unknown ssrc, cannot e2e decrypt it', from, packet, rtp);
          this.emit(SocketEvents.LOG, error);
          return;
        }
        const decrypted = dave.decrypt(data, userId);
        if (!decrypted) {
          const error = new MediaRTPError('Packet failed to e2e decrypt', from, packet, rtp);
          this.emit(SocketEvents.LOG, error);
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
        userId,
      } as TransportPacket);
    }
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
      (error: any, bytes: number) => {
        if (error) {
          this.emit(SocketEvents.WARN, error);
        }
      },
    );
  }

  sendAudioFrame(
    packet: Buffer,
    options?: FrameOptions,
  ): void {
    this.sendFrame(
      packet,
      Object.assign({}, options, {type: MediaCodecTypes.AUDIO}),
    );
  }

  sendVideoFrame(
    packet: Buffer,
    options?: FrameOptions,
  ): void {
    this.sendFrame(
      packet,
      Object.assign({}, options, {type: MediaCodecTypes.VIDEO}),
    );
  }

  sendFrame(
    packet: Buffer,
    options: FrameOptions = {},
  ): void {
    if (!this.connected) {
      return;
    }
    if (!this.key) {
      throw new Error('Haven\'t received the session description yet');
    }

    const type = options.type!;
    if (type !== MediaCodecTypes.AUDIO && type !== MediaCodecTypes.VIDEO) {
      throw new Error('Invalid frame type');
    }

    const useCache = options.useCache || options.useCache === undefined;
    if (type === MediaCodecTypes.VIDEO && !this.videoEnabled) {
      throw new Error('Cannot send in video frames when video is disabled!');
    }

    let cache: {
      header: RTPHeader,
      nonce: RTPNonce,
    };
    switch (type) {
      case MediaCodecTypes.AUDIO: {
        cache = {
          header: this.headers.audio!,
          nonce: this.nonces.audio!,
        };
      }; break;
      case MediaCodecTypes.VIDEO: {
        cache = {
          header: this.headers.video!,
          nonce: this.nonces.video!,
        };
      }; break;
      default: {
        throw new Error(`Invalid type ${type}`);
      };
    }

    let header: RTPHeader;
    let rtpNonce: RTPNonce;
    if (useCache) {
      header = cache.header;
      rtpNonce = cache.nonce;
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

      if (options.sequence === undefined) {
        options.sequence = cache.header.sequence;
        options.incrementSequence = false;
      }
      if (options.timestamp === undefined) {
        options.timestamp = cache.header.timestamp;
        options.incrementTimestamp = false;
      }
    }

    header.setSequence(options.sequence, options.incrementSequence);
    header.setTimestamp(options.timestamp, options.incrementTimestamp);
    const nonce = rtpNonce.set(options.nonce, options.incrementNonce);

    const dave = this.mediaGateway.dave;
    if (dave && type === MediaCodecTypes.AUDIO) {
      packet = dave.encrypt(packet);
    }

    // rtpsize modes: rtp header | encrypted payload + auth tag | 4 byte nonce
    const encrypted = RTPCrypto.encrypt(this.mode!, this.key!, header.buffer, packet, nonce);
    this.send(Buffer.concat([header.buffer, encrypted, nonce]));
  }

  sendAudioSilenceFrame(): void {
    this.sendFrame(Buffer.from(MediaSilencePacket), {
      incrementTimestamp: true,
      timestamp: 960,
      type: MediaCodecTypes.AUDIO,
    });
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: 'close', listener: () => any): this;
  on(event: 'killed', listener: () => any): this;
  on(event: 'log', listener: (error: Error) => any): this;
  on(event: 'open', listener: () => any): this;
  on(event: 'packet', listener: (packet: TransportPacket) => any): this;
  on(event: 'ready', listener: () => any): this;
  on(event: 'socket', listener: (socket: dgram.Socket) => any): this;
  on(event: 'warn', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
