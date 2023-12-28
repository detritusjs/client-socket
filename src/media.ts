import { EventSpewer, Timers } from 'detritus-utils';

import { BaseSocket } from './basesocket';
import { Bucket } from './bucket';
import {
  ApiVersions,
  MediaEncryptionModes,
  MediaOpCodes,
  MediaProtocols,
  MediaSpeakingFlags,
  MediaSSRCTypes,
  SocketCloseCodes,
  SocketEvents,
  SocketInternalCloseCodes,
  SocketInternalCloseReasons,
  SocketMediaCloseCodes,
  SocketStates,
  MEDIA_ENCRYPTION_MODES,
  MEDIA_PROTOCOLS,
} from './constants';
import { Socket as GatewaySocket } from './gateway';
import { Socket as MediaUDPSocket } from './mediaudp';
import { MediaGatewayPackets } from './types';


export interface SocketOptions {
  channelId: string,
  forceMode?: MediaEncryptionModes | string,
  receive?: boolean,
  serverId: string,
  userId: string,
  video?: boolean,
}


const defaultOptions = {
  receive: false,
  serverId: null,
  userId: null,
  video: false,
};

export class Socket extends EventSpewer {
  readonly state: SocketStates = SocketStates.CLOSED;

  _heartbeat: {
    ack: boolean,
    lastAck: null | number,
    lastSent: null | number,
    interval: Timers.Interval,
    intervalTime: null | number,
    nonce: null | number,
  } = {
    ack: false,
    lastAck: null,
    lastSent: null,
    interval: new Timers.Interval(),
    intervalTime: null,
    nonce: null,
  };
  bucket = new Bucket(120, 60 * 1000);
  channelId: string;
  endpoint: null | string = null;
  forceMode: MediaEncryptionModes | null = null;
  gateway: GatewaySocket;
  identified: boolean = false;
  killed: boolean = false;
  promises = new Set<{reject: Function, resolve: Function}>();
  protocol: MediaProtocols | null = null;
  ready: boolean = false;
  receiveEnabled: boolean = false;
  reconnects: number = 0;
  serverId: string;
  socket: BaseSocket | null = null;
  ssrcs = {
    [MediaSSRCTypes.AUDIO]: new Map<number, string>(),
    [MediaSSRCTypes.VIDEO]: new Map<number, string>(),
  };
  transport: MediaUDPSocket | null = null;
  token: null | string = null;
  userId: string;
  videoEnabled: boolean;

  constructor(
    gateway: GatewaySocket,
    options: SocketOptions,
  ) {
    super();
    this.gateway = gateway;

    options = Object.assign({}, defaultOptions, options);
    this.channelId = options.channelId;
    this.serverId = options.serverId;
    this.userId = options.userId;

    this.receiveEnabled = !!options.receive;
    this.videoEnabled = !!options.video;

    if (options.forceMode !== undefined) {
      if (!MEDIA_ENCRYPTION_MODES.includes(options.forceMode as MediaEncryptionModes)) {
        throw new Error('Unknown Encryption Mode');
      }
      this.forceMode = options.forceMode as MediaEncryptionModes;
    }

    Object.defineProperties(this, {
      _heartbeat: {enumerable: false, writable: false},
      channelId: {configurable: true, writable: false},
      gateway: {enumerable: false, writable: false},
      killed: {configurable: true, writable: false},
      protocol: {configurable: true, writable: false},
      ready: {configurable: true, writable: false},
      serverId: {writable: false},
      state: {configurable: true, writable: false},
      token: {configurable: true, writable: false},
      userId: {writable: false},
    });
    this.setProtocol(MediaProtocols.UDP);
  }

  get closed(): boolean {
    return !!this.socket && this.socket.closed;
  }

  get closing(): boolean {
    return !!this.socket && this.socket.closing;
  }

  get connected(): boolean {
    return !!this.socket && this.socket.connected;
  }

  get connecting(): boolean {
    return !!this.socket && this.socket.connecting;
  }

  get guildId(): null | string {
    return (this.inDm) ? null : this.serverId;
  }

  get inDm(): boolean {
    return this.serverId === this.channelId;
  }

  get sessionId(): null | string {
    return this.gateway.sessionId;
  }

  get audioSSRC(): number {
    return (this.transport) ? this.transport.ssrc : 0;
  }

  get videoSSRC(): number {
    return (this.videoEnabled) ? this.audioSSRC + 1 : 0;
  }

  get rtxSSRC(): number {
    return (this.videoEnabled) ? this.videoSSRC + 1 : 0;
  }

  resolvePromises(error?: any) {
    this.promises.forEach((promise) => {
      this.promises.delete(promise);
      if (error) {
        promise.reject(error);
      } else {
        promise.resolve();
      }
    });
  }

  setChannelId(value: string): void {
    Object.defineProperty(this, 'channelId', {value});
  }

  setEndpoint(value: string): void {
    this.endpoint = (value) ? `wss://${value.split(':').shift()}` : null;
    this.identified = false;
    if (this.connected) {
      this.connect();
    }
  }

  setProtocol(value: MediaProtocols): void {
    if (this.transport) {
      throw new Error('Cannot change protocols after transport connection.');
    }
    if (value !== MediaProtocols.UDP) {
      throw new Error('UDP is currently the only protocol supported.');
    }
    if (!MEDIA_PROTOCOLS.includes(value)) {
      throw new Error('Invalid Protocol Type');
    }
    Object.defineProperty(this, 'protocol', {value});
  }

  setState(value: SocketStates): void {
    if (value in SocketStates && value !== this.state) {
      Object.defineProperty(this, 'state', {value});
      this.emit(SocketEvents.STATE, {state: value});
    }
  }

  setToken(value: string): void {
    Object.defineProperty(this, 'token', {value});
    if (!this.identified) {
      this.resolvePromises();
      this.connect();
    }
  }

  ssrcToUserId(
    ssrc: number,
    type: MediaSSRCTypes = MediaSSRCTypes.AUDIO,
  ): null | string {
    if (!(type in this.ssrcs)) {
      throw new Error('Invalid SSRC Type');
    }
    if (this.ssrcs[type].has(ssrc)) {
      return <string> this.ssrcs[type].get(ssrc);
    }
    return null;
  }

  userIdToSSRC(
    userId: string,
    type: MediaSSRCTypes = MediaSSRCTypes.AUDIO,
  ): null | number {
    if (!(type in this.ssrcs)) {
      throw new Error(`Invalid SSRC Type`);
    }
    for (let [ssrc, uid] of this.ssrcs[type]) {
      if (userId === uid) {
        return ssrc;
      }
    }
    return null;
  }

  cleanup(
    code?: number,
  ): void {
    Object.defineProperty(this, 'ready', {value: false});
    this.bucket.clear();
    this.bucket.lock();

    this.ssrcs[MediaSSRCTypes.AUDIO].clear();
    this.ssrcs[MediaSSRCTypes.VIDEO].clear();

    // unresumable events
    // 1000 Normal Disconnected
    // 4014 Voice Channel Kick/Deleted
    // 4015 Voice Server Crashed
    switch (code) {
      case SocketCloseCodes.NORMAL:
      case SocketMediaCloseCodes.DISCONNECTED:
      case SocketMediaCloseCodes.VOICE_SERVER_CRASHED: {
        this.identified = false;
      }; break;
    }

    this._heartbeat.interval.stop();
    this._heartbeat.ack = false;
    this._heartbeat.lastAck = null;
    this._heartbeat.lastSent = null;
    this._heartbeat.intervalTime = null;
    this._heartbeat.nonce = null;
  }

  connect(
    endpoint?: string,
  ): void {
    if (this.killed) {return;}
    if (this.connected) {
      this.disconnect();
    }
    if (endpoint) {
      this.setEndpoint(endpoint);
    }
    if (!this.endpoint) {
      throw new Error('Media Endpoint is null');
    }

    const url = new URL(this.endpoint);
    url.searchParams.set('v', String(ApiVersions.MEDIA_GATEWAY));
    url.pathname = url.pathname || '/';

    const ws = this.socket = new BaseSocket(url.href);
    this.setState(SocketStates.CONNECTING);
    this.emit(SocketEvents.SOCKET, ws);
    ws.socket.onclose = this.onClose.bind(this, ws);
    ws.socket.onerror = this.onError.bind(this, ws);
    ws.socket.onmessage = this.onMessage.bind(this, ws);
    ws.socket.onopen = this.onOpen.bind(this, ws);
  }

  decode(data: any): any {
    try {
      return JSON.parse(data);
    } catch(error) {
      this.emit(SocketEvents.WARN, error);
    }
  }

  disconnect(
    code: number = SocketCloseCodes.NORMAL,
    reason?: string,
  ): void {
    this.cleanup(code);
    if (this.socket) {
      if (!reason && (code in SocketInternalCloseReasons)) {
        reason = (<any> SocketInternalCloseReasons)[code];
      }
      this.socket.close(code, reason);
      this.socket = null;
    }
  }

  encode(data: any): null | string {
    try {
      return JSON.stringify(data);
    } catch(error) {
      this.emit(SocketEvents.WARN, error);
    }
    return null;
  }

  handle(data: any): void {
    const packet = this.decode(data);
    if (!packet) {return;}
    this.emit(SocketEvents.PACKET, packet);

    switch (packet.op) {
      case MediaOpCodes.READY: {
        const data: MediaGatewayPackets.Ready = packet.d;

        this.reconnects = 0;
        Object.defineProperty(this, 'ready', {value: true});
        this.identified = true;
        this.bucket.unlock();
        this.transportConnect(data);
        this.setState(SocketStates.READY);
        this.emit(SocketEvents.READY);
      }; break;
      case MediaOpCodes.RESUMED: {
        this.reconnects = 0;
        Object.defineProperty(this, 'ready', {value: true});
        this.bucket.unlock();
        this.setState(SocketStates.READY);
        this.emit(SocketEvents.READY);
      }; break;
      case MediaOpCodes.CLIENT_CONNECT: {
        const data: MediaGatewayPackets.ClientConnect = packet.d;

        this.ssrcs[MediaSSRCTypes.AUDIO].set(data.audio_ssrc, data.user_id);
        if (data['video_ssrc'] !== undefined) {
          this.ssrcs[MediaSSRCTypes.VIDEO].set(data.video_ssrc, data.user_id);
        }
        // start the user id's decode/encoders
      }; break;
      case MediaOpCodes.CLIENT_DISCONNECT: {
        const data: MediaGatewayPackets.ClientDisconnect = packet.d;

        const audioSSRC = this.userIdToSSRC(data.user_id, MediaSSRCTypes.AUDIO);
        if (audioSSRC !== null) {
          this.ssrcs[MediaSSRCTypes.AUDIO].delete(<number> audioSSRC);
        }
        const videoSSRC = this.userIdToSSRC(data.user_id, MediaSSRCTypes.VIDEO);
        if (videoSSRC !== null) {
          this.ssrcs[MediaSSRCTypes.VIDEO].delete(<number> videoSSRC);
        }
      }; break;
      case MediaOpCodes.HELLO: {
        const data: MediaGatewayPackets.Hello = packet.d;
        this.setHeartbeat(data);
      }; break;
      case MediaOpCodes.HEARTBEAT_ACK: {
        const data: MediaGatewayPackets.HeartbeatAck = packet.d;
        if (data !== this._heartbeat.nonce) {
          this.disconnect(SocketInternalCloseCodes.HEARTBEAT_ACK_NONCE);
          this.connect();
          return;
        }
        this._heartbeat.ack = true;
        this._heartbeat.lastAck = Date.now();
      }; break;
      case MediaOpCodes.SELECT_PROTOCOL_ACK: {
        if (this.protocol === MediaProtocols.UDP) {
          const {
            audio_codec: audioCodec,
            mode,
            media_session_id: mediaSessionId,
            secret_key: secretKey,
            video_codec: videoCodec,
          }: MediaGatewayPackets.SelectProtocolAckUDP = packet.d;

          (<MediaUDPSocket> this.transport)
            .setAudioCodec(audioCodec)
            .setVideoCodec(videoCodec)
            .setKey(secretKey)
            .setMode(mode)
            .setTransportId(mediaSessionId);
          this.emit(SocketEvents.TRANSPORT_READY, this.transport);
        } else if (this.protocol === MediaProtocols.WEBRTC) {
          const data: MediaGatewayPackets.SelectProtocolAckWebRTC = packet.d;
        }
      }; break;
      case MediaOpCodes.SESSION_UPDATE: {
        const {
          audio_codec: audioCodec,
          media_session_id: mediaSessionId,
          video_codec: videoCodec,
          video_quality_changes: videoQualityChanges,
        }: MediaGatewayPackets.SessionUpdate = packet.d;

        (<MediaUDPSocket> this.transport)
          .setAudioCodec(audioCodec)
          .setVideoCodec(videoCodec)
          .setTransportId(mediaSessionId);

        if (videoQualityChanges) {
          videoQualityChanges.forEach((change) => {

          });
        }
      }; break;
      case MediaOpCodes.SPEAKING: {
        const data: MediaGatewayPackets.Speaking = packet.d;
        this.ssrcs[MediaSSRCTypes.AUDIO].set(data.ssrc, data.user_id);
        // use the bitmasks Constants.Discord.SpeakingFlags
        // emit it?
        // check to see if it already existed, if not, create decode/encoders
      }; break;
      case MediaOpCodes.MEDIA_SINK_WANTS: {
        const data: MediaGatewayPackets.MediaSinkWants = packet.d;
      }; break;
    }
  }

  kill(error?: any): void {
    if (this.killed) {return;}
    const serverId = (this.inDm) ? null : this.serverId;
    this.gateway.voiceStateUpdate(serverId, null);

    Object.defineProperty(this, 'killed', {value: true});
    this.gateway.mediaGateways.delete(this.serverId);
    this.disconnect(SocketCloseCodes.NORMAL);
    if (this.transport) {
      this.transport.disconnect();
      this.transport.removeAllListeners();
      this.transport = null;
    }
    this.resolvePromises(error || new Error('Media Gateway was killed.'));
    this.emit(SocketEvents.KILLED);
    this.removeAllListeners();
  }

  onClose(
    target: BaseSocket,
    event: {code: number, reason: string},
  ) {
    let { code, reason } = event;
    if (!reason && (code in SocketInternalCloseReasons)) {
      reason = (<any> SocketInternalCloseReasons)[code];
    }
    this.emit(SocketEvents.CLOSE, {code, reason});
    if (!this.socket || this.socket === target) {
      this.setState(SocketStates.CLOSED);
      this.cleanup(code);
      if (this.gateway.autoReconnect && !this.killed) {
        if (this.gateway.reconnectMax < this.reconnects) {
          this.kill();
        } else {
          this.emit(SocketEvents.RECONNECTING);
          setTimeout(() => {
            this.connect();
            this.reconnects++;
          }, this.gateway.reconnectDelay);
        }
      }
    }
  }

  onError(
    target: BaseSocket,
    event: {error: any} | any,
  ) {
    this.emit(SocketEvents.WARN, event.error);
  }

  onMessage(
    target: BaseSocket,
    event: {data: any, type: string},
  ) {
    if (this.socket === target) {
      const { data } = event;
      this.handle(data);
    } else {
      target.close(SocketInternalCloseCodes.OTHER_SOCKET_MESSAGE);
    }
  }

  onOpen(target: BaseSocket) {
    this.emit(SocketEvents.OPEN, target);
    if (this.socket === target) {
      this.setState(SocketStates.OPEN);
      if (this.identified && this.transport) {
        this.resume();
      } else {
        this.identify();
      }
    } else {
      target.close(SocketInternalCloseCodes.OTHER_SOCKET_OPEN);
    }
  }

  async ping(timeout?: number): Promise<any> {
    if (!this.connected) {
      throw new Error('Socket is still initializing!');
    }
    return this.socket!.ping(timeout);
  }

  send(
    op: number,
    d: any,
    callback?: Function,
    direct: boolean = false,
  ): void {
    if (!this.connected) {
      return;
    }

    const data = this.encode({op, d});
    if (!data) {
      return;
    }

    if (direct) {
      this.socket!.send(data, callback);
    } else {
      const throttled = () => {
        if (this.bucket.locked || !this.identified || !this.connected) {
          if (!this.bucket.locked) {
            this.bucket.lock();
          }
          this.bucket.add(throttled, true);
          return;
        }
        try {
          this.socket!.send(data, callback);
        } catch(error) {
          this.emit(SocketEvents.WARN, error);
        }
      };
      this.bucket.add(throttled);
    }
  }

  heartbeat(
    fromInterval: boolean = false,
  ): void {
    if (fromInterval && (this._heartbeat.lastSent && !this._heartbeat.ack)) {
      this.disconnect(SocketInternalCloseCodes.HEARTBEAT_ACK);
      this.connect();
    } else {
      this._heartbeat.ack = false;
      this._heartbeat.lastSent = Date.now();
      this._heartbeat.nonce = Date.now();
      this.send(MediaOpCodes.HEARTBEAT, this._heartbeat.nonce, undefined, true);
    }
  }

  setHeartbeat(data: MediaGatewayPackets.Hello): void {
    if (!data || !data.heartbeat_interval) {
      return;
    }
    this.heartbeat();
    this._heartbeat.ack = true;
    this._heartbeat.lastAck = Date.now();
    this._heartbeat.intervalTime = data.heartbeat_interval;
    this._heartbeat.interval.start(this._heartbeat.intervalTime, () => {
      this.heartbeat(true);
    });
  }

  identify(): void {
    if (this.state !== SocketStates.OPEN) {
      return;
    }

    this.send(MediaOpCodes.IDENTIFY, {
      server_id: this.serverId,
      session_id: this.sessionId,
      token: this.token,
      user_id: this.userId,
      video: this.videoEnabled,
    }, () => {
      this.setState(SocketStates.IDENTIFYING);
    }, true);
  }

  resume(): void {
    this.send(MediaOpCodes.RESUME, {
      server_id: this.serverId,
      session_id: this.sessionId,
      token: this.token,
    }, () => {
      this.setState(SocketStates.RESUMING);
    }, true);
  }

  transportConnect(data: MediaGatewayPackets.Ready): void {
    this.ssrcs[MediaSSRCTypes.AUDIO].set(
      data.ssrc,
      (<string> this.gateway.userId),
    );

    if (!this.transport) {
      if (this.protocol === MediaProtocols.UDP) {
        this.transport = new MediaUDPSocket(this);
      } else {
        this.emit(SocketEvents.WARN, new Error(`Unsupported Media Transport Protocol: ${this.protocol}`));
        return;
      }
    } else {
      this.transport.disconnect();
    }

    if (this.protocol === MediaProtocols.UDP) {
      let mode: null | MediaEncryptionModes = null;
      if (this.forceMode && MEDIA_ENCRYPTION_MODES.includes(this.forceMode)) {
        mode = this.forceMode;
      } else {
        for (let value of data.modes) {
          let m = value as MediaEncryptionModes;
          if (MEDIA_ENCRYPTION_MODES.includes(m)) {
            mode = m;
            break;
          }
        }
      }
      let transport = this.transport as MediaUDPSocket;
      if (mode) {
        transport.setMode(mode);
        transport.setSSRC(data.ssrc);
        transport.connect(data.ip, data.port);
        this.emit(SocketEvents.TRANSPORT, transport);
      } else {
        transport.disconnect();
        this.transport = null;
        this.emit(SocketEvents.WARN, new Error(`No supported voice mode found in ${JSON.stringify(data.modes)}`));
      }
    } else {
      this.emit(SocketEvents.WARN, new Error(`Unsupported Media Transport Protocol: ${this.protocol}`));
    }
  }

  sendClientConnect(callback?: Function): void {
    this.send(MediaOpCodes.CLIENT_CONNECT, {
      audio_ssrc: this.audioSSRC,
      video_ssrc: this.videoSSRC,
      rtx_ssrc: this.rtxSSRC,
    }, callback);
  }

  sendSelectProtocol(
    options: {
      codecs?: Array<any>,
      data: {
        address: string,
        port: number,
        mode: string,
      },
      experiments?: Array<any>,
      protocol?: MediaProtocols | string,
      rtcConnectionId?: string,
    },
    callback?: Function,
  ): void {
    options = Object.assign({
      protocol: MediaProtocols.UDP,
    }, options);
    const data = {
      codecs: options.codecs,
      data: options.data,
      experiments: options.experiments,
      protocol: options.protocol,
      rtc_connection_id: options.rtcConnectionId,
    };
    this.send(MediaOpCodes.SELECT_PROTOCOL, data, callback);
  }

  sendSpeaking(
    options: {
      delay?: number,
      ssrc?: number,
      soundshare?: boolean,
      voice?: boolean,
    },
    callback?: Function,
  ): void {
    options = Object.assign({
      delay: 0,
      ssrc: (<MediaUDPSocket> this.transport).ssrc,
    }, options);

    const data = {
      delay: options.delay,
      ssrc: options.ssrc,
      speaking: MediaSpeakingFlags.NONE,
    };
    if (options.soundshare) {
      data.speaking |= MediaSpeakingFlags.SOUNDSHARE;
    }
    if (options.voice) {
      data.speaking |= MediaSpeakingFlags.VOICE;
    }
    this.send(MediaOpCodes.SPEAKING, data, callback);
  }

  sendStateUpdate(
    options: {
      selfDeaf?: boolean,
      selfMute?: boolean,
      selfVideo?: boolean,
    } = {},
    callback?: Function,
  ): void {
    this.gateway.voiceStateUpdate(
      this.guildId,
      this.channelId,
      options,
      callback,
    );
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: 'close', listener: (payload: {code: number, reason: string}) => any): this;
  on(event: 'killed', listener: () => any): this;
  on(event: 'open', listener: (target: BaseSocket) => any): this;
  on(event: 'packet', listener: (packet: MediaGatewayPackets.Packet) => any): this;
  on(event: 'ready', listener: () => any): this;
  on(event: 'socket', listener: (socket: BaseSocket) => any): this;
  on(event: 'state', listener: ({state}: {state: SocketStates}) => any): this;
  on(event: 'transport', listener: (transport: MediaUDPSocket) => any): this;
  on(event: 'transportReady', listener: (transport: MediaUDPSocket) => any): this;
  on(event: 'warn', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
