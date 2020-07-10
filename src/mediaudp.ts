import * as dgram from 'dgram';

import { EventSpewer } from 'detritus-utils';

import {
  MediaCodecs,
  MediaCodecTypes,
  MediaEncryptionModes,
  MediaProtocols,
  MediaSilencePacket,
  MediaSSRCTypes,
  RTPHeaderExtensionOneByte,
  RTPHeaderExtensionTwoByte,
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
import RTPCrypto from './mediapackets/rtpcrypto';


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
  caches: {
    audio: Buffer,
    video?: Buffer,
  };
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

    this.caches = {audio: Buffer.alloc(5 * 1024)};
    this.headers = {audio: new RTPHeader({randomize: true})};
    this.nonces = {audio: new RTPNonce({randomize: true})};

    if (this.videoEnabled) {
      this.caches.video = Buffer.alloc(5 * 1024);
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
    if (!MEDIA_CODECS_AUDIO.includes(<MediaCodecs> codec)) {
      this.emit(SocketEvents.WARN, new Error(`Unsupported audio codec received: ${codec}`));
      this.mediaGateway.kill();
      return this;
    }
    this.codecs.audio = <MediaCodecs> codec;
    this.headers.audio.setPayloadType(<number> this.rtpAudioPayloadType);
    return this;
  }

  setVideoCodec(
    codec?: MediaCodecs | null | string,
  ): Socket {
    if (!codec) {
      return this;
    }
    if (!MEDIA_CODECS_VIDEO.includes(<MediaCodecs> codec)) {
      this.emit(SocketEvents.WARN, new Error(`Unsupported video codec received: ${codec}`));
      this.mediaGateway.kill();
      return this;
    }
    this.codecs.video = <MediaCodecs> codec;
    if (this.headers.video) {
      this.headers.video.setPayloadType(<number> this.rtpVideoPayloadType);
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
    if (!MEDIA_ENCRYPTION_MODES.includes(value as MediaEncryptionModes)) {
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
      if (this.ssrc !== packet.readUInt32LE(0)) {
        this.emit(SocketEvents.WARN, new Error('SSRC mismatch in ip discovery packet'));
        return;
      }
  
      this.local.ip = packet.slice(4, packet.indexOf(0, 4)).toString();
      this.local.port = packet.readUIntLE(packet.length - 2, 2);

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
          address: <string> this.local.ip,
          mode: <string> this.mode,
          port: <number> this.local.port,
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

    const ipDiscovery = Buffer.alloc(70);
    ipDiscovery.writeUIntBE(this.ssrc, 0, 4);
    this.send(ipDiscovery);
    return this;
  }

  disconnect(): void {
    if (this.socket) {
      (<dgram.Socket> this.socket).close();
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

      rtp.nonce = Buffer.alloc(24);
      switch (this.mode) {
        case MediaEncryptionModes.XSALSA20_POLY1305_LITE: {
          // last 4 bytes
          packet.copy(rtp.nonce, 0, packet.length - 4);
          rtp.payload = packet.slice(12, -4);
        }; break;
        case MediaEncryptionModes.XSALSA20_POLY1305_SUFFIX: {
          // last 24 bytes
          packet.copy(rtp.nonce, 0, packet.length - 24);
          rtp.payload = packet.slice(12, -24);
        }; break;
        case MediaEncryptionModes.XSALSA20_POLY1305: {
          // first 12 bytes, the rtp header
          // currently broken for some reason
          packet.copy(rtp.nonce, 0, 0, 12);
          rtp.payload = packet.slice(12);
        }; break;
        default: {
          const error = new MediaRTPError(`${this.mode} is not supported for decoding.`, from, packet, rtp);
          this.emit(SocketEvents.WARN, error);
          return;
        };
      }

      let data: Buffer | null = RTPCrypto.decrypt(
        <Uint8Array> this.key,
        <Buffer> rtp.payload,
        <Buffer> rtp.nonce,
      );
      if (!data) {
        const error = new MediaRTPError('Packet failed to decrypt', from, packet, rtp);
        this.emit(SocketEvents.WARN, error);
        return;
      }

      if (rtp.header.padding) {
        // RFC3550 Section 5.1
        // last byte contains amount of padding, including itself, slice that stuff off
        data = data.slice(0, data.length - data.readUIntBE(data.length - 1, 1));
      }

      if (rtp.header.extension) {
        if (RTPHeaderExtensionOneByte.HEADER.every((header, i) => header === (<Buffer> data)[i])) {
          // RFC5285 Section 4.2: One-Byte Header

          const fieldAmount = data.readUIntBE(2, 2);
          // const fields: Array<Buffer> = [];
          // Unknown as to what each field is

          let offset = 4;
          for (let i = 0; i < fieldAmount; i++) {
            const byte = data.readUIntBE(offset++, 1);
            const identifer = byte & RTPHeaderExtensionOneByte.LOCAL_IDENTIFER;
            const len = ((byte >> 4) & RTPHeaderExtensionOneByte.LOCAL_IDENTIFER) + 1;

            // ignore rest if identifier === 15 (local identifer)
            if (identifer === RTPHeaderExtensionOneByte.LOCAL_IDENTIFER) {
              break;
            }

            // skip the field data since we don't know what to do with it
            offset += len;
            // fields.push(data.slice(offset, offset += len));

            /*
            // apparently discord's padding isn't actually padding from the RFC..
            // is just padding
            while (data[offset] === 0) {
              offset++;
            }
            */
          }
          // https://github.com/discordjs/discord.js/pull/3555
          offset++;
          data = data.slice(offset);
          // do something here with the fields, then clear it
          // fields.length = 0;
        } else if (RTPHeaderExtensionTwoByte.HEADER.every((header, i) => header === (<Buffer> data)[i])) {
          // RFC5285 Section 4.3: Two-Byte Header not received yet, appbits unknown anyways
          // using two bytes, 0x10 and 0x00 instead
          // if appbits is all 0s, ignore, so rn ignore this packet

          const error = new MediaRTPError('Received Two Byte header with appbits being 0, ignoring', from, packet, rtp);
          this.emit(SocketEvents.LOG, error);
          return;
          /*
          // handle the two byte
          const fields = [];
          const fieldAmount = data.readUIntBE(2, 2);
          let offset = 4;
          for (let i = 0; i < fieldAmount; i++) {
            const identifier = data.readUIntBE(offset++, 1);
            const len = data.readUIntBE(offset++, 1);
            if (!len) {continue;}
            fields.push(data.slice(offset, offset + len));
            offset += len;
            while (data[offset] === 0) {offset++;}
          }
          if (offset !== data.length) {
            fields.push(data.slice(offset));
            //just making sure, dunno tho
          }
          
          data = (fields.length <= 1) ? fields.shift() : Buffer.concat(fields);
          fields.length = 0;
          */
        }
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

      this.emit(SocketEvents.PACKET, (<TransportPacket> {
        codec,
        data,
        format,
        from,
        rtp,
        userId,
      }));
    }
  }

  send(packet: Buffer): void {
    if (!this.connected || !this.socket) {
      throw new Error('UDP is not connected yet!');
    }

    (<dgram.Socket> this.socket).send(
      packet,
      0,
      packet.length,
      <number> this.remote.port,
      <string> this.remote.ip,
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

    const type = <string> options.type;
    if (type !== MediaCodecTypes.AUDIO && type !== MediaCodecTypes.VIDEO) {
      throw new Error('Invalid frame type');
    }

    let useCache = options.useCache || options.useCache === undefined;
    if (type === MediaCodecTypes.VIDEO && !this.videoEnabled) {
      throw new Error('Cannot send in video frames when video is disabled!');
    }

    const cache: {
      header?: RTPHeader,
      nonce?: RTPNonce,
      payload?: Buffer,
    } = {};
    switch (type) {
      case MediaCodecTypes.AUDIO: {
        cache.header = this.headers.audio;
        cache.nonce = this.nonces.audio;
        cache.payload = this.caches.audio;
      }; break;
      case MediaCodecTypes.VIDEO: {
        cache.header = this.headers.video;
        cache.nonce = this.nonces.video;
        cache.payload = this.caches.video;
      }; break;
      default: {
        throw new Error(`Invalid type ${type}`);
      };
    }

    cache.header = (<RTPHeader> cache.header);
    cache.nonce = (<RTPNonce> cache.nonce);
    cache.payload = (<Buffer> cache.payload);

    const rtp: {
      header?: RTPHeader,
      nonce?: RTPNonce,
    } = {};
    if (useCache) {
      rtp.header = cache.header;
      rtp.nonce = cache.nonce;
    } else {
      let payloadType: number, ssrc: number;
      switch (type) {
        case MediaCodecTypes.AUDIO: {
          payloadType = <number> this.rtpAudioPayloadType;
          ssrc = this.audioSSRC;
        }; break;
        case MediaCodecTypes.VIDEO: {
          payloadType = <number> this.rtpVideoPayloadType;
          ssrc = this.videoSSRC;
        }; break;
        default: {
          throw new Error(`Invalid type ${type}`);
        };
      }
      rtp.header = new RTPHeader({payloadType, ssrc});
      rtp.nonce = new RTPNonce({randomize: true});
    }

    rtp.header = (<RTPHeader> rtp.header);
    rtp.nonce = (<RTPNonce> rtp.nonce);

    if (!useCache && cache.header) {
      if (options.sequence === undefined) {
        options.sequence = cache.header.sequence;
        options.incrementSequence = false;
      }
      if (options.timestamp === undefined) {
        options.timestamp = cache.header.timestamp;
        options.incrementTimestamp = false;
      }
    }

    rtp.header.setSequence(options.sequence, options.incrementSequence);
    rtp.header.setTimestamp(options.timestamp, options.incrementTimestamp);

    const data: Array<Buffer | {
      length: number,
      packet: Buffer,
    }> = [];
    const payloadDataCache = (useCache) ? cache.payload.slice(12) : null;

    let nonce: Buffer;
    switch (this.mode) {
      case MediaEncryptionModes.XSALSA20_POLY1305_LITE: {
        nonce = rtp.nonce.set(options.nonce, options.incrementNonce);
        data.push(nonce.slice(0, 4));
      }; break;
      case MediaEncryptionModes.XSALSA20_POLY1305_SUFFIX: {
        nonce = rtp.nonce.generate();
        data.push(nonce);
      }; break;
      case MediaEncryptionModes.XSALSA20_POLY1305: {
        rtp.header.copy(rtp.nonce.buffer);
        nonce = rtp.nonce.buffer;
      }; break;
      default: {
        throw new Error(`${this.mode} is not supported for encoding.`);
      };
    }

    data.unshift(RTPCrypto.encrypt(
      <Uint8Array> this.key,
      packet,
      nonce,
      payloadDataCache,
    ));

    let buffer: Buffer;
    if (useCache) {
      let total = rtp.header.length;
      rtp.header.copy(cache.payload);
      data.forEach((buf) => {
        const start = total;
        total += buf.length;
        if (buf instanceof Buffer) {
          buf.copy(<Buffer> cache.payload, start);
        }
      });
      buffer = cache.payload.slice(0, total);
    } else {
      const buffers = [rtp.header.buffer, ...data].map((buffer) => {
        if (buffer instanceof Buffer) {
          return buffer;
        }
        return buffer.packet;
      });
      buffer = Buffer.concat(buffers);
    }

    this.send(buffer);
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
