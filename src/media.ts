import { BaseSocket } from './basesocket';
import { Bucket } from './bucket';
import {
  ApiVersions,
  MediaOpCodes,
  MediaProtocols,
  MediaSpeakingFlags,
  MediaSSRCTypes,
  SocketCloseCodes,
  SocketInternalCloseCodes,
  SocketInternalCloseReasons,
  SocketMediaCloseCodes,
  MEDIA_ENCRYPTION_MODES,
  MEDIA_PROTOCOLS,
} from './constants';
import EventEmitter from './eventemitter';
import { Socket as GatewaySocket } from './gateway';
import { Socket as MediaUDPSocket } from './mediaudp';


export interface SocketOptions {
  channelId: string,
  forceMode?: string,
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

export class Socket extends EventEmitter {
  _heartbeat: {
    ack: boolean,
    lastAck: null | number,
    lastSent: null | number,
    interval: null | ReturnType<typeof setInterval>,
    intervalTime: null | number,
    nonce: null | number,
  } = {
    ack: false,
    lastAck: null,
    lastSent: null,
    interval: null,
    intervalTime: null,
    nonce: null,
  };
  bucket = new Bucket(120, 60 * 1000);
  channelId: string;
  endpoint: null | string = null;
  forceMode: null | string = null;
  gateway: GatewaySocket;
  identified: boolean = false;
  killed: boolean = false;
  promises = new Set<{reject: Function, resolve: Function}>();
  protocol: null | string = null;
  ready: boolean = false;
  receiveEnabled: boolean = false;
  reconnects: number = 0;
  serverId: string;
  socket: BaseSocket | null = null;
  ssrcs: {
    [key: string]: Map<number, string>,
  } = {
    [MediaSSRCTypes.AUDIO]: new Map(),
    [MediaSSRCTypes.VIDEO]: new Map(),
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
      if (!MEDIA_ENCRYPTION_MODES.includes(options.forceMode)) {
        throw new Error('Unknown Encryption Mode');
      }
      this.forceMode = options.forceMode;
    }
  
    Object.defineProperties(this, {
      channelId: {configurable: true, writable: false},
      gateway: {enumerable: false, writable: false},
      killed: {configurable: true, writable: false},
      protocol: {configurable: true, writable: false},
      ready: {configurable: true, writable: false},
      serverId: {writable: false},
      token: {configurable: true, writable: false},
      userId: {writable: false},
      _heartbeat: {enumerable: false, writable: false},
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

  get initializing(): boolean {
    return !this.socket;
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

  setProtocol(value: string): void {
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

  setToken(value: string): void {
    Object.defineProperty(this, 'token', {value});
    if (!this.identified) {
      this.resolvePromises();
      this.connect();
    }
  }

  ssrcToUserId(
    ssrc: number,
    type: string = 'audio',
  ): null | string {
    if (!(type in this.ssrcs)) {
      throw new Error(`Invalid SSRC Type`);
    }
    if (this.ssrcs[type].has(ssrc)) {
      return <string> this.ssrcs[type].get(ssrc);
    }
    return null;
  }

  userIdToSSRC(
    userId: string,
    type: 'audio' | 'video' = 'audio',
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

    // Normal Disconnected
    // Voice Channel Kick/Deleted
    // Voice Server Crashed
    if (
      (code === SocketCloseCodes.NORMAL) ||
      (code === SocketMediaCloseCodes.DISCONNECTED) ||
      (code === SocketMediaCloseCodes.VOICE_SERVER_CRASHED)
    ) {
      this.identified = false;
    }
    if (this._heartbeat.interval !== null) {
      clearInterval(<number> <unknown> this._heartbeat.interval);
      this._heartbeat.interval = null;
    }
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
    this.emit('socket', ws);
    ws.socket.onclose = this.onClose.bind(this, ws);
    ws.socket.onerror = this.onError.bind(this, ws);
    ws.socket.onmessage = this.onMessage.bind(this, ws);
    ws.socket.onopen = this.onOpen.bind(this, ws);
  }

  decode(data: any): any {
    try {
      return JSON.parse(data);
    } catch(error) {
      this.emit('warn', error);
    }
  }

  disconnect(
    code: number = SocketCloseCodes.NORMAL,
    reason?: string,
  ): void {
    this.cleanup(code);
    if (this.socket) {
      if (!reason && (code in SocketInternalCloseReasons)) {
        reason = <string> SocketInternalCloseReasons[code];
      }
      this.socket.close(code, reason);
    }
    this.socket = null;
  }

  encode(data: any): null | string {
    try {
      return JSON.stringify(data);
    } catch(error) {
      this.emit('warn', error);
    }
    return null;
  }

  handle(data: any): void {
    const packet = this.decode(data);
    if (!packet) {return;}
    this.emit('packet', packet);

    switch (packet.op) {
      case MediaOpCodes.READY: {
        this.reconnects = 0;
        Object.defineProperty(this, 'ready', {value: true});
        this.identified = true;
        this.bucket.unlock();
        this.transportConnect(packet.d);
        this.emit('ready');
      }; break;
      case MediaOpCodes.CLIENT_CONNECT: {
        this.ssrcs[MediaSSRCTypes.AUDIO].set(packet.d.audio_ssrc, packet.d.user_id);
        if ('video_ssrc' in packet.d) {
          this.ssrcs[MediaSSRCTypes.VIDEO].set(packet.d.video_ssrc, packet.d.user_id);
        }
        // start the user id's decode/encoders
      }; break;
      case MediaOpCodes.CLIENT_DISCONNECT: {
        const audioSSRC = this.userIdToSSRC(packet.d.user_id, 'audio');
        if (audioSSRC !== null) {
          this.ssrcs[MediaSSRCTypes.AUDIO].delete(<number> audioSSRC);
        }
        const videoSSRC = this.userIdToSSRC(packet.d.user_id, 'video');
        if (videoSSRC !== null) {
          this.ssrcs[MediaSSRCTypes.VIDEO].delete(<number> videoSSRC);
        }
      }; break;
      case MediaOpCodes.HELLO: {
        this.setHeartbeat(packet.d);
      }; break;
      case MediaOpCodes.HEARTBEAT_ACK: {
        if (packet.d !== this._heartbeat.nonce) {
          this.disconnect(SocketInternalCloseCodes.HEARTBEAT_ACK_NONCE);
          this.connect();
          return;
        }
        this._heartbeat.lastAck = Date.now();
        this._heartbeat.ack = true;
      }; break;
      case MediaOpCodes.RESUMED: {
        this.reconnects = 0;
        Object.defineProperty(this, 'ready', {value: true});
        this.bucket.unlock();
      }; break;
      case MediaOpCodes.SELECT_PROTOCOL_ACK: {
        if (this.protocol === MediaProtocols.UDP) {
          const packetData: {
            audio_codec: string,
            mode: string,
            media_session_id: string,
            secret_key: Array<number>,
            video_codec: string,
          } = packet.d;
          (<MediaUDPSocket> this.transport)
            .setAudioCodec(packetData.audio_codec)
            .setVideoCodec(packetData.video_codec)
            .setKey(packetData.secret_key)
            .setMode(packetData.mode)
            .setTransportId(packetData.media_session_id);
          this.emit('transportReady', this.transport);
        } else if (this.protocol === MediaProtocols.WEBRTC) {
          const data: {
            audio_codec: string,
            media_session_id: string,
            sdp: string,
            video_codec: string,
          } = packet.d;
        }
      }; break;
      case MediaOpCodes.SESSION_UPDATE: {
        (<MediaUDPSocket> this.transport)
          .setAudioCodec(packet.d.audio_codec)
          .setVideoCodec(packet.d.video_codec)
          .setTransportId(packet.d.media_session_id);

        if (packet.d.video_quality_changes) {
          packet.d.video_quality_changes.forEach((change: {
            quality: string, // MediaReceivedVideoQuality
            ssrc: number,
            user_id: string,
          }) => {

          });
        }
      }; break;
      case MediaOpCodes.SPEAKING: {
        this.ssrcs[MediaSSRCTypes.AUDIO].set(packet.d.ssrc, packet.d.user_id);
        // use the bitmasks Constants.Discord.SpeakingFlags
        // emit it?
        // check to see if it already existed, if not, create decode/encoders
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
      this.transport = null;
    }
    this.resolvePromises(error || new Error('Media Gateway was killed.'));
    this.emit('killed');
  }

  onClose(
    target: BaseSocket,
    event: {code: number, reason: string},
  ) {
    let { code, reason } = event;
    if (!reason && (code in SocketInternalCloseReasons)) {
      reason = <string> SocketInternalCloseReasons[code];
    }
    this.emit('close', {code, reason});
    if (!this.socket || this.socket === target) {
      this.cleanup(code);
      if (this.gateway.autoReconnect && !this.killed) {
        if (this.gateway.reconnectMax < this.reconnects) {
          this.kill();
        } else {
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
    this.emit('warn', event.error);
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
    this.emit('open');
    if (this.socket === target) {
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
    return (<BaseSocket> this.socket).ping(timeout);
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
      (<BaseSocket> this.socket).send(data, callback);
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
          (<BaseSocket> this.socket).send(data, callback);
        } catch(error) {
          this.emit('warn', error);
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
      return;
    }
    this._heartbeat.nonce = Date.now();
    this.send(MediaOpCodes.HEARTBEAT, this._heartbeat.nonce, () => {
      this._heartbeat.ack = false;
      this._heartbeat.lastSent = Date.now();
    }, true);
  }

  setHeartbeat(data: {
    heartbeat_interval: number,
  }): void {
    if (!data || !data.heartbeat_interval) {
      return;
    }
    this.heartbeat();
    this._heartbeat.ack = true;
    this._heartbeat.lastAck = Date.now();
    this._heartbeat.intervalTime = data.heartbeat_interval;
    if (this._heartbeat.interval !== null) {
      clearInterval(<number> <unknown> this._heartbeat.interval);
    }
    this._heartbeat.interval = setInterval(
      this.heartbeat.bind(this, true),
      data.heartbeat_interval,
    );
  }

  identify(callback?: Function): void {
    this.send(MediaOpCodes.IDENTIFY, {
      server_id: this.serverId,
      session_id: this.sessionId,
      token: this.token,
      user_id: this.userId,
      video: this.videoEnabled,
    }, callback, true);
  }

  resume(callback?: Function): void {
    this.send(MediaOpCodes.RESUME, {
      server_id: this.serverId,
      session_id: this.sessionId,
      token: this.token,
    }, callback, true);
  }

  transportConnect(
    data: {
      ip: string,
      port: number,
      modes: Array<string>,
      ssrc: number,
    },
  ): void {
    this.ssrcs[MediaSSRCTypes.AUDIO].set(
      data.ssrc,
      (<string> this.gateway.userId),
    );

    if (!this.transport) {
      if (this.protocol === MediaProtocols.UDP) {
        this.transport = new MediaUDPSocket(this);
      } else {
        this.emit('warn', new Error(`Unsupported Media Transport Protocol: ${this.protocol}`));
        return;
      }
    } else {
      this.transport.disconnect();
    }

    if (this.protocol === MediaProtocols.UDP) {
      let mode: null | string = null;
      if (this.forceMode && MEDIA_ENCRYPTION_MODES.includes(this.forceMode)) {
        mode = this.forceMode;
      }
      if (mode === null) {
        for (let m of data.modes) {
          if (MEDIA_ENCRYPTION_MODES.includes(m)) {
            mode = m;
            break;
          }
        }
      }
      if (mode) {
        (<MediaUDPSocket> this.transport).setMode(mode);
        (<MediaUDPSocket> this.transport).setSSRC(data.ssrc);
        (<MediaUDPSocket> this.transport).connect(data.ip, data.port);
        this.emit('transport', this.transport);
      } else {
        (<MediaUDPSocket> this.transport).disconnect();
        this.transport = null;
        this.emit('warn', new Error(`No supported voice mode found in ${JSON.stringify(data.modes)}`));
      }
    } else {
      this.emit('warn', new Error(`Unsupported Media Transport Protocol: ${this.protocol}`));
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
      protocol?: string,
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
}
