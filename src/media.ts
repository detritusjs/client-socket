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
  MediaStreamTypes,
  SocketCloseCodes,
  SocketEvents,
  SocketEventsBase,
  SocketInternalCloseCodes,
  SocketInternalCloseReasons,
  SocketMediaCloseCodes,
  SocketStates,
  MEDIA_ENCRYPTION_MODES,
  MEDIA_PROTOCOLS,
} from './constants';
import { SocketKillError } from './errors';
import { Socket as GatewaySocket } from './gateway';
import { DaveSession } from './mediadave';
import { Socket as MediaUDPSocket } from './mediaudp';
import RTPCrypto from './mediapackets/rtpcrypto';
import { MediaGatewayPackets } from './types';


export interface VideoStreamSettings {
  // bits per second
  maxBitrate?: number,
  maxFramerate?: number,
  // `type` is `fixed` unless given
  maxResolution?: {height: number, type?: string, width: number},
}

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

// how long discord gets to send a new voice server after we ask for one
const NEW_SERVER_TIMEOUT = 15 * 1000;

// how long wants changes are collected before they are sent
const MEDIA_SINK_WANTS_DELAY = 100;

// discord's client only resumes if its last heartbeat ack is this recent, an older session gets identified again
const RESUME_MAX_AGE = 60 * 1000;

function clampWants(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value) || 0));
}

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
  connectedUserIds = new Set<string>();
  dave: DaveSession | null = null;
  endpoint: null | string = null;
  forceMode: MediaEncryptionModes | null = null;
  gateway: GatewaySocket;
  // what we ask the server to forward from users with no entry in `userWants`, 0 to 100
  defaultWants: number = 100;
  identified: boolean = false;
  ipDiscoveryFailures: number = 0;
  // kept across disconnects (unlike `_heartbeat.lastAck`) to decide if the session is still resumable
  lastHeartbeatAckAt: null | number = null;
  // how often the server wants a video keyframe from us, as it sent it. null until it does
  keyframeInterval: number | null = null;
  killed: boolean = false;
  // waiting on the voice server discord gives us after the last one stopped answering, see `requestNewServer()`
  newServerTimeout = new Timers.Timeout();
  promises = new Set<{reject: Function, resolve: Function}>();
  protocol: MediaProtocols | null = null;
  ready: boolean = false;
  receiveEnabled: boolean = false;
  reconnects: number = 0;
  // what the receivers of our video last asked for, keyed by our own stream ssrcs. null until the server sends it
  remoteMediaSinkWants: MediaGatewayPackets.MediaSinkWants | null = null;
  // the wants the server last got from us this session, null while it is still on its defaults
  sentMediaSinkWants: string | null = null;
  // collects wants changes made right after each other into one packet, see `scheduleMediaSinkWants()`
  mediaSinkWantsTimeout = new Timers.Timeout();
  // whether we asked discord for a new voice server since we last connected to one
  requestedNewServer: boolean = false;
  // our voice state as discord last sent it, sent again as is when asking for a new voice server
  selfDeaf: boolean = false;
  selfMute: boolean = false;
  selfVideo: boolean = false;
  // last sequence number received from the server, sent back as `seq_ack`
  sequence: number = -1;
  serverId: string;
  // the voice gateway version the server said it speaks in HELLO, newer opcodes depend on it
  serverVersion: number = 0;
  socket: BaseSocket | null = null;
  ssrcs = {
    [MediaSSRCTypes.AUDIO]: new Map<number, string>(),
    [MediaSSRCTypes.VIDEO]: new Map<number, string>(),
  };
  // other users' retransmission ssrcs to the video ssrc they retransmit for
  rtxSSRCs = new Map<number, number>();
  // our own video streams, as assigned by the server in READY
  streams: Array<MediaGatewayPackets.Stream> = [];
  // other users' video streams (one per simulcast layer) as they last announced them, with their bitrate/framerate/resolution
  userStreams = new Map<string, Array<MediaGatewayPackets.Stream>>();
  // what we last said about our own video in `sendClientConnect`
  videoStreamSettings: VideoStreamSettings = {};
  transport: MediaUDPSocket | null = null;
  token: null | string = null;
  userId: string;
  // per user override of `defaultWants`, 0 stops the server from forwarding that user to us
  userWants = new Map<string, number>();
  videoEnabled: boolean;
  // versions of the voice server we are connected to, asked for after READY
  voiceBackendVersion: {rtcWorker: string, voice: string} | null = null;

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
      if (!MEDIA_ENCRYPTION_MODES.includes(options.forceMode as MediaEncryptionModes) || !RTPCrypto.isModeAvailable(options.forceMode)) {
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

  // the server assigns these in READY's `streams`, older servers leave it empty and expect audio + 1 and audio + 2
  get videoSSRC(): number {
    if (!this.videoEnabled) {
      return 0;
    }
    const stream = this.streams.find((x) => x.type === MediaStreamTypes.VIDEO);
    return (stream && stream.ssrc) ? stream.ssrc : this.audioSSRC + 1;
  }

  get rtxSSRC(): number {
    if (!this.videoEnabled) {
      return 0;
    }
    const stream = this.streams.find((x) => x.type === MediaStreamTypes.VIDEO);
    return (stream && stream.rtx_ssrc) ? stream.rtx_ssrc : this.videoSSRC + 1;
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

  get voicePrivacyCode(): null | string {
    return (this.dave) ? this.dave.voicePrivacyCode : null;
  }

  setChannelId(value: string): void {
    Object.defineProperty(this, 'channelId', {value});
    if (this.dave) {
      this.dave.setChannelId(value);
    }
  }

  setEndpoint(value: null | string): void {
    // keep the port, each port on a voice host is a different server and the others don't know our session (4006)
    this.endpoint = (value) ? `wss://${value}` : null;
    this.identified = false;
    if (!this.endpoint) {
      // discord is reallocating the voice server, wait for the next VOICE_SERVER_UPDATE with an endpoint
      this.disconnect();
    } else if (this.connected) {
      // a `setToken()` call usually follows, only connect if it didn't so we don't open two sockets
      this.disconnect();
      process.nextTick(() => {
        if (this.killed || !this.endpoint || this.socket) {
          return;
        }
        try {
          this.connect();
        } catch(error) {
          this.emit(SocketEvents.WARN, error);
        }
      });
    } else {
      this.cleanup();
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
    this.newServerTimeout.stop();
    if (!this.identified && this.endpoint) {
      this.resolvePromises();
      try {
        this.connect();
      } catch(error) {
        this.emit(SocketEvents.WARN, error);
      }
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

  /**
   * The video ssrc a retransmission (rtx) ssrc resends packets for
   */
  rtxToSSRC(rtxSSRC: number): null | number {
    const ssrc = this.rtxSSRCs.get(rtxSSRC);
    return (ssrc === undefined) ? null : ssrc;
  }

  cleanup(
    code?: number,
  ): void {
    Object.defineProperty(this, 'ready', {value: false});
    this.mediaSinkWantsTimeout.stop();
    this.bucket.clear();
    this.bucket.lock();

    // unresumable events
    switch (code) {
      case SocketCloseCodes.NORMAL:
      case SocketMediaCloseCodes.AUTHENTICATION_FAILED:
      case SocketMediaCloseCodes.SESSION_NO_LONGER_VALID:
      case SocketMediaCloseCodes.SESSION_TIMEOUT:
      case SocketMediaCloseCodes.SERVER_NOT_FOUND:
      case SocketMediaCloseCodes.UNKNOWN_PROTOCOL:
      case SocketMediaCloseCodes.DISCONNECTED:
      case SocketMediaCloseCodes.UNKNOWN_ENCRYPTION_MODE:
      case SocketMediaCloseCodes.DAVE_PROTOCOL_REQUIRED:
      case SocketMediaCloseCodes.BAD_REQUEST:
      case SocketMediaCloseCodes.RATE_LIMITED:
      case SocketMediaCloseCodes.CALL_TERMINATED:
      // the session died with the server, discord's client identifies again instead of resuming
      case SocketMediaCloseCodes.VOICE_SERVER_CRASHED: {
        this.identified = false;
      }; break;
    }
    if (!this.identified) {
      this.resetSession();
    }

    this._heartbeat.interval.stop();
    this._heartbeat.ack = false;
    this._heartbeat.lastAck = null;
    this._heartbeat.lastSent = null;
    this._heartbeat.intervalTime = null;
    this._heartbeat.nonce = null;
  }

  /**
   * Forgets everything tied to the voice session, the next connection identifies instead of resuming
   */
  resetSession(): void {
    this.identified = false;
    this.sequence = -1;
    this.connectedUserIds.clear();
    this.ssrcs[MediaSSRCTypes.AUDIO].clear();
    this.ssrcs[MediaSSRCTypes.VIDEO].clear();
    this.rtxSSRCs.clear();
    this.userStreams.clear();
    this.remoteMediaSinkWants = null;
    this.sentMediaSinkWants = null;
    this.keyframeInterval = null;
    this.voiceBackendVersion = null;
    this.destroyDave();
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
    // BaseSocket re-emits the websocket's errors, it throws if there is no listener
    ws.on(SocketEventsBase.ERROR, this.onError.bind(this, ws));
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
    if (typeof(data) !== 'string') {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      return this.handleBinary(buffer);
    }

    const packet = this.decode(data);
    if (!packet) {return;}
    if (typeof(packet.seq) === 'number') {
      this.sequence = packet.seq;
    }
    this.emit(SocketEvents.PACKET, packet);

    switch (packet.op) {
      case MediaOpCodes.READY: {
        const data: MediaGatewayPackets.Ready = packet.d;

        this.reconnects = 0;
        this.requestedNewServer = false;
        Object.defineProperty(this, 'ready', {value: true});
        this.identified = true;
        this.bucket.unlock();
        this.streams = (data.streams) ? data.streams.filter((x) => x.type !== MediaStreamTypes.AUDIO) : [];
        this.transportConnect(data);
        this.sentMediaSinkWants = null;
        this.syncMediaSinkWants();
        if (6 <= this.serverVersion) {
          // answered with the server's versions
          this.send(MediaOpCodes.VOICE_BACKEND_VERSION, {});
        }
        this.setState(SocketStates.READY);
        this.emit(SocketEvents.READY);
      }; break;
      case MediaOpCodes.RESUMED: {
        this.reconnects = 0;
        this.requestedNewServer = false;
        Object.defineProperty(this, 'ready', {value: true});
        this.bucket.unlock();
        // sent again in case the server did not keep our wants across the resume
        this.syncMediaSinkWants(true);
        this.setState(SocketStates.READY);
        this.emit(SocketEvents.READY);
        // a resume keeps the udp transport and its key and gets no new session description, so this is the only
        // signal that audio can be sent again. No key means the transport reconnected, its session description follows
        const transport = this.transport;
        if (transport && transport.connected && transport.key) {
          this.emit(SocketEvents.TRANSPORT_READY, transport);
        }
      }; break;
      case MediaOpCodes.CLIENTS_CONNECT: {
        const data: MediaGatewayPackets.ClientsConnect = packet.d;
        for (let userId of data.user_ids) {
          this.connectedUserIds.add(userId);
        }
      }; break;
      case MediaOpCodes.CLIENT_CONNECT: {
        const data: MediaGatewayPackets.ClientConnect = packet.d;

        this.connectedUserIds.add(data.user_id);
        if (data.audio_ssrc) {
          this.ssrcs[MediaSSRCTypes.AUDIO].set(data.audio_ssrc, data.user_id);
        }
        // sent again whenever the user's video starts or stops, a video_ssrc of 0 means it stopped
        for (let [ssrc, userId] of this.ssrcs[MediaSSRCTypes.VIDEO]) {
          if (userId === data.user_id) {
            this.ssrcs[MediaSSRCTypes.VIDEO].delete(ssrc);
            for (let [rtxSSRC, videoSSRC] of this.rtxSSRCs) {
              if (videoSSRC === ssrc) {
                this.rtxSSRCs.delete(rtxSSRC);
              }
            }
            if (this.transport) {
              this.transport.deleteFrameAssembler(ssrc);
            }
          }
        }
        if (data.video_ssrc) {
          this.ssrcs[MediaSSRCTypes.VIDEO].set(data.video_ssrc, data.user_id);
        }
        if (data.streams && data.streams.length) {
          this.userStreams.set(data.user_id, data.streams);
        } else {
          this.userStreams.delete(data.user_id);
        }
        if (data.streams) {
          // simulcast layers each have their own ssrc
          for (let stream of data.streams) {
            if (stream.ssrc && stream.active !== false) {
              this.ssrcs[MediaSSRCTypes.VIDEO].set(stream.ssrc, data.user_id);
              if (stream.rtx_ssrc) {
                this.rtxSSRCs.set(stream.rtx_ssrc, stream.ssrc);
              }
            }
          }
        }
        this.scheduleMediaSinkWants();
      }; break;
      case MediaOpCodes.CLIENT_DISCONNECT: {
        const data: MediaGatewayPackets.ClientDisconnect = packet.d;

        this.connectedUserIds.delete(data.user_id);
        this.userStreams.delete(data.user_id);
        const audioSSRC = this.userIdToSSRC(data.user_id, MediaSSRCTypes.AUDIO);
        if (audioSSRC !== null) {
          this.ssrcs[MediaSSRCTypes.AUDIO].delete(<number> audioSSRC);
        }
        // one per simulcast layer
        for (let [ssrc, userId] of this.ssrcs[MediaSSRCTypes.VIDEO]) {
          if (userId === data.user_id) {
            this.ssrcs[MediaSSRCTypes.VIDEO].delete(ssrc);
            for (let [rtxSSRC, videoSSRC] of this.rtxSSRCs) {
              if (videoSSRC === ssrc) {
                this.rtxSSRCs.delete(rtxSSRC);
              }
            }
            if (this.transport) {
              this.transport.deleteFrameAssembler(ssrc);
            }
          }
        }
        this.scheduleMediaSinkWants();
      }; break;
      case MediaOpCodes.HELLO: {
        const data: MediaGatewayPackets.Hello = packet.d;
        this.serverVersion = (data && data.v) || 3;
        this.setHeartbeat(data);
      }; break;
      case MediaOpCodes.HEARTBEAT_ACK: {
        const data: MediaGatewayPackets.HeartbeatAck = packet.d;
        const nonce = (data && typeof(data) === 'object') ? data.t : data;
        if (nonce !== this._heartbeat.nonce) {
          this.disconnect(SocketInternalCloseCodes.HEARTBEAT_ACK_NONCE);
          this.connect();
          return;
        }
        this._heartbeat.ack = true;
        this._heartbeat.lastAck = Date.now();
        this.lastHeartbeatAckAt = this._heartbeat.lastAck;
      }; break;
      case MediaOpCodes.HEARTBEAT: {
        // the server asking for one right away
        this.heartbeat();
      }; break;
      case MediaOpCodes.SELECT_PROTOCOL_ACK: {
        if (!this.transport) {
          this.emit(SocketEvents.WARN, new Error('Received a Select Protocol Ack without a transport'));
          return;
        }
        if (this.protocol === MediaProtocols.UDP) {
          const {
            audio_codec: audioCodec,
            dave_protocol_version: daveProtocolVersion,
            keyframe_interval: keyframeInterval,
            mode,
            media_session_id: mediaSessionId,
            secret_key: secretKey,
            video_codec: videoCodec,
          }: MediaGatewayPackets.SelectProtocolAckUDP = packet.d;

          // set the key first, a failing dave session shouldn't leave the transport unable to send
          try {
            this.transport
              .setAudioCodec(audioCodec)
              .setVideoCodec(videoCodec)
              .setKey(secretKey)
              .setMode(mode)
              .setTransportId(mediaSessionId);
          } catch(error) {
            this.emit(SocketEvents.WARN, error);
            return;
          }
          if (this.killed) {
            return;
          }
          if (keyframeInterval) {
            this.keyframeInterval = keyframeInterval;
          }

          try {
            this.setupDave(daveProtocolVersion || 0);
          } catch(error) {
            this.emit(SocketEvents.WARN, error);
            // a half setup session would e2e encrypt with the wrong state
            this.destroyDave();
            if (daveProtocolVersion) {
              // the call is e2ee, we can't send or receive anything without dave
              this.kill(new Error(`Failed to setup the DAVE protocol (E2EE): ${(error as any)?.message || error}`));
              return;
            }
          }
          if (!this.killed) {
            this.emit(SocketEvents.TRANSPORT_READY, this.transport);
          }
        } else if (this.protocol === MediaProtocols.WEBRTC) {
          const data: MediaGatewayPackets.SelectProtocolAckWebRTC = packet.d;
        }
      }; break;
      case MediaOpCodes.SESSION_UPDATE: {
        const {
          audio_codec: audioCodec,
          keyframe_interval: keyframeInterval,
          media_session_id: mediaSessionId,
          video_codec: videoCodec,
          video_quality_changes: videoQualityChanges,
        }: MediaGatewayPackets.SessionUpdate = packet.d;

        if (keyframeInterval) {
          this.keyframeInterval = keyframeInterval;
        }
        if (!this.transport) {
          this.emit(SocketEvents.WARN, new Error('Received a Session Update without a transport'));
          return;
        }
        this.transport
          .setAudioCodec(audioCodec)
          .setVideoCodec(videoCodec)
          .setTransportId(mediaSessionId);

        if (videoQualityChanges) {
          // the quality we now get of someone's video changed
          for (let change of videoQualityChanges) {
            this.emit(SocketEvents.VIDEO_QUALITY, {quality: change.quality, ssrc: change.ssrc, userId: change.user_id});
          }
        }
      }; break;
      case MediaOpCodes.SPEAKING: {
        const data: MediaGatewayPackets.Speaking = packet.d;
        this.ssrcs[MediaSSRCTypes.AUDIO].set(data.ssrc, data.user_id);
        // a user's wants can only be sent once we know their ssrc
        this.scheduleMediaSinkWants();
      }; break;
      case MediaOpCodes.MEDIA_SINK_WANTS: {
        const data: MediaGatewayPackets.MediaSinkWants = packet.d;
        this.remoteMediaSinkWants = data;
        this.emit(SocketEvents.MEDIA_SINK_WANTS, data);
      }; break;
      case MediaOpCodes.VOICE_BACKEND_VERSION: {
        const data: MediaGatewayPackets.VoiceBackendVersion = packet.d;
        if (data && data.voice != null && data.rtc_worker != null) {
          this.voiceBackendVersion = {rtcWorker: data.rtc_worker, voice: data.voice};
          this.emit(SocketEvents.VOICE_BACKEND_VERSION, this.voiceBackendVersion);
        }
      }; break;
      case MediaOpCodes.FLAGS: {
        const data: MediaGatewayPackets.Flags = packet.d;
        if (data && data.flags != null && data.user_id != null) {
          this.emit(SocketEvents.FLAGS, {flags: data.flags, userId: data.user_id});
        }
      }; break;
      case MediaOpCodes.PLATFORM: {
        const data: MediaGatewayPackets.Platform = packet.d;
        if (data && data.platform != null && data.user_id != null) {
          this.emit(SocketEvents.PLATFORM, {platform: data.platform, userId: data.user_id});
        }
      }; break;
      case MediaOpCodes.DAVE_PREPARE_TRANSITION: {
        const data: MediaGatewayPackets.DavePrepareTransition = packet.d;
        if (this.dave) {
          const sendReady = this.dave.prepareTransition(data.transition_id, data.protocol_version);
          if (sendReady) {
            this.sendDaveTransitionReady(data.transition_id);
          }
        }
      }; break;
      case MediaOpCodes.DAVE_EXECUTE_TRANSITION: {
        const data: MediaGatewayPackets.DaveExecuteTransition = packet.d;
        if (this.dave) {
          this.dave.executeTransition(data.transition_id);
        }
      }; break;
      case MediaOpCodes.DAVE_PREPARE_EPOCH: {
        const data: MediaGatewayPackets.DavePrepareEpoch = packet.d;
        if (this.dave) {
          this.dave.prepareEpoch(data.epoch, data.protocol_version);
        }
      }; break;
    }
  }

  handleBinary(buffer: Buffer): void {
    // server binary messages: uint16 sequence | uint8 opcode | payload
    if (buffer.length < 3) {
      this.emit(SocketEvents.WARN, new Error('Received a binary message that\'s too small to be valid'));
      return;
    }
    const seq = buffer.readUInt16BE(0);
    const op = buffer.readUInt8(2);
    const payload = buffer.subarray(3);
    this.sequence = seq;
    this.emit(SocketEvents.PACKET, {op, d: payload, seq, binary: true});

    const dave = this.dave;
    if (!dave) {
      return;
    }
    try {
      switch (op) {
        case MediaOpCodes.DAVE_MLS_EXTERNAL_SENDER: {
          dave.setExternalSender(payload);
        }; break;
        case MediaOpCodes.DAVE_MLS_PROPOSALS: {
          const commitWelcome = dave.processProposals(payload, this.connectedUserIds);
          if (commitWelcome) {
            this.sendBinary(MediaOpCodes.DAVE_MLS_COMMIT_WELCOME, commitWelcome);
          }
        }; break;
        case MediaOpCodes.DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION: {
          const { success, transitionId } = dave.processCommit(payload);
          if (success && transitionId !== 0) {
            this.sendDaveTransitionReady(transitionId);
          }
        }; break;
        case MediaOpCodes.DAVE_MLS_WELCOME: {
          const { success, transitionId } = dave.processWelcome(payload);
          if (success && transitionId !== 0) {
            this.sendDaveTransitionReady(transitionId);
          }
        }; break;
      }
    } catch(error) {
      this.emit(SocketEvents.WARN, error);
    }
  }

  setupDave(protocolVersion: number): void {
    // still create the session on protocol version 0 so the call can be upgraded to e2ee later
    if (!DaveSession.available) {
      return;
    }
    if (this.dave) {
      this.dave.protocolVersion = protocolVersion;
      this.dave.reinit();
      return;
    }
    const dave = this.dave = new DaveSession(protocolVersion, this.userId, this.channelId);
    dave.on('invalidateTransition', (transitionId: number) => {
      this.send(MediaOpCodes.DAVE_MLS_INVALID_COMMIT_WELCOME, {transition_id: transitionId});
    });
    dave.on('invalidTransitionsExceeded', (count: number) => {
      this.emit(SocketEvents.WARN, new Error(`${count} invalid DAVE commits/welcomes in a row, reconnecting with a new session`));
      this.resetSession();
      this.disconnect(SocketInternalCloseCodes.DAVE_INVALID_TRANSITIONS);
      this.connect();
    });
    dave.on('keyPackage', (keyPackage: Buffer) => {
      this.sendBinary(MediaOpCodes.DAVE_MLS_KEY_PACKAGE, keyPackage);
    });
    dave.on('warn', (error: Error) => this.emit(SocketEvents.WARN, error));
    dave.reinit();
  }

  destroyDave(): void {
    if (this.dave) {
      this.dave.destroy();
      this.dave = null;
    }
  }

  /**
   * The voice server stopped answering, asks discord for another one by sending our voice state again (same channel,
   * nothing about it changes). The VOICE_SERVER_UPDATE it answers with connects us there through `setEndpoint()` and
   * `setToken()`, the transport comes back with a TRANSPORT_READY. Once per server, if the new one fails too we die
   */
  requestNewServer(): void {
    this.requestedNewServer = true;
    this.reconnects = 0;
    this.emit(SocketEvents.WARN, new Error(`Voice server stopped answering after ${this.gateway.reconnectMax} reconnects, asking for a new one`));
    this.newServerTimeout.start(NEW_SERVER_TIMEOUT, () => {
      this.kill(new Error(`Tried reconnecting ${this.gateway.reconnectMax} times, and no new voice server came within ${NEW_SERVER_TIMEOUT}ms.`));
    });
    this.gateway.voiceStateUpdate(this.guildId, this.channelId, {
      selfDeaf: this.selfDeaf,
      selfMute: this.selfMute,
      selfVideo: this.selfVideo,
    });
  }

  kill(
    error?: any,
    options: {voiceStateUpdate?: boolean} = {},
  ): void {
    if (this.killed) {return;}
    // `voiceStateUpdate: false` when another session of ours took over this voice connection, leaving the channel would disconnect that session
    if (options.voiceStateUpdate !== false) {
      const serverId = (this.inDm) ? null : this.serverId;
      this.gateway.voiceStateUpdate(serverId, null);
    }

    Object.defineProperty(this, 'killed', {value: true});
    this.newServerTimeout.stop();
    this.gateway.mediaGateways.delete(this.serverId);
    this.disconnect(SocketCloseCodes.NORMAL);
    if (this.transport) {
      this.transport.disconnect();
      this.transport.removeAllListeners();
      this.transport = null;
    }
    this.destroyDave();
    this.resolvePromises(error || new Error('Media Gateway was killed.'));
    this.emit(SocketEvents.KILLED, {error});
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
      switch (code) {
        case SocketMediaCloseCodes.DAVE_PROTOCOL_REQUIRED: {
          const error = (DaveSession.available) ?
            new Error('Voice channel requires the DAVE protocol (E2EE)') :
            new Error('Voice channel requires the DAVE protocol (E2EE), please install @snazzah/davey');
          this.kill(error);
          return;
        };
        case SocketMediaCloseCodes.UNKNOWN_ENCRYPTION_MODE: {
          // reconnecting would select the same mode again
          this.kill(new Error('Voice server rejected the selected encryption mode'));
          return;
        };
        case SocketMediaCloseCodes.AUTHENTICATION_FAILED:
        case SocketMediaCloseCodes.SERVER_NOT_FOUND:
        case SocketMediaCloseCodes.UNKNOWN_PROTOCOL: {
          // reconnecting would send the same rejected token/server/protocol again
          this.kill(new SocketKillError(code, reason));
          return;
        };
        case SocketMediaCloseCodes.SESSION_NO_LONGER_VALID: {
          // our session isn't in this voice channel anymore, usually another session of ours joined voice
          // so don't send a voice state update, it would disconnect that session
          this.kill(new SocketKillError(code, reason), {voiceStateUpdate: false});
          return;
        };
        case SocketMediaCloseCodes.DISCONNECTED:
        case SocketMediaCloseCodes.RATE_LIMITED:
        case SocketMediaCloseCodes.CALL_TERMINATED: {
          // should not reconnect, the main gateway will either send a new VOICE_SERVER_UPDATE (reconnects) or a VOICE_STATE_UPDATE (kills)
          return;
        };
      }
      if (this.gateway.autoReconnect && !this.killed) {
        if (this.gateway.reconnectMax <= this.reconnects) {
          if (this.requestedNewServer) {
            this.kill(new Error(`Tried reconnecting ${this.gateway.reconnectMax} times.`));
          } else {
            this.requestNewServer();
          }
        } else {
          this.emit(SocketEvents.RECONNECTING);
          setTimeout(() => {
            // no endpoint (waiting on a VOICE_SERVER_UPDATE) or a new socket was already created
            if (this.killed || !this.endpoint || (this.socket && this.socket !== target)) {
              return;
            }
            try {
              this.connect();
            } catch(error) {
              this.emit(SocketEvents.WARN, error);
            }
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
    const error = (event && event.error !== undefined) ? event.error : event;
    this.emit(SocketEvents.WARN, error);
  }

  onMessage(
    target: BaseSocket,
    event: {data: any, type: string},
  ) {
    if (this.socket === target) {
      const { data } = event;
      try {
        this.handle(data);
      } catch(error) {
        this.emit(SocketEvents.WARN, error);
      }
    } else {
      target.close(SocketInternalCloseCodes.OTHER_SOCKET_MESSAGE);
    }
  }

  onOpen(target: BaseSocket) {
    this.emit(SocketEvents.OPEN, target);
    if (this.socket === target) {
      this.setState(SocketStates.OPEN);
      if (this.identified) {
        const lastAckAt = this.lastHeartbeatAckAt;
        if (lastAckAt === null || RESUME_MAX_AGE < Date.now() - lastAckAt) {
          // too long since the server last answered, it has likely dropped the session and would close with 4006
          this.resetSession();
        }
      }
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

  sendBinary(
    op: number,
    payload: Buffer,
    callback?: Function,
  ): void {
    if (!this.connected) {
      return;
    }
    // client binary messages: uint8 opcode | payload
    const data = Buffer.concat([Buffer.from([op]), payload]);
    this.socket!.send(data, callback);
  }

  sendDaveTransitionReady(transitionId: number, callback?: Function): void {
    this.send(MediaOpCodes.DAVE_TRANSITION_READY, {transition_id: transitionId}, callback);
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
      this.send(MediaOpCodes.HEARTBEAT, {
        t: this._heartbeat.nonce,
        seq_ack: this.sequence,
      }, undefined, true);
    }
  }

  setHeartbeat(data: MediaGatewayPackets.Hello): void {
    if (!data || !data.heartbeat_interval) {
      return;
    }
    this._heartbeat.ack = true;
    this._heartbeat.lastAck = Date.now();
    // sets `ack` to false, so a zombied connection is caught on the first interval
    this.heartbeat();
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
      channel_id: this.channelId,
      max_dave_protocol_version: DaveSession.maxProtocolVersion,
      server_id: this.serverId,
      session_id: this.sessionId,
      token: this.token,
      user_id: this.userId,
      video: this.videoEnabled,
      // asks the server to assign ssrcs for one full quality video layer, returned in READY
      streams: (this.videoEnabled) ? [{type: MediaStreamTypes.VIDEO, rid: '100', quality: 100}] : [],
    }, () => {
      this.setState(SocketStates.IDENTIFYING);
    }, true);
  }

  resume(): void {
    this.send(MediaOpCodes.RESUME, {
      channel_id: this.channelId,
      seq_ack: this.sequence,
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
      if (this.forceMode) {
        if (data.modes.includes(this.forceMode)) {
          mode = this.forceMode;
        } else {
          this.emit(SocketEvents.WARN, new Error(`Forced voice mode ${this.forceMode} is not offered by the server, falling back`));
        }
      }
      if (!mode) {
        for (let m of MEDIA_ENCRYPTION_MODES) {
          if (data.modes.includes(m) && RTPCrypto.isModeAvailable(m)) {
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

  /**
   * Tells the voice server (and through it everyone in the call) our ssrcs and if we're sending video
   * The bitrate/framerate/resolution describe that video, they're kept for the next call so only `videoActive` is needed after
   */
  sendClientConnect(
    options: {videoActive?: boolean} & VideoStreamSettings = {},
    callback?: Function,
  ): void {
    if (options.maxBitrate !== undefined) {
      this.videoStreamSettings.maxBitrate = options.maxBitrate;
    }
    if (options.maxFramerate !== undefined) {
      this.videoStreamSettings.maxFramerate = options.maxFramerate;
    }
    if (options.maxResolution !== undefined) {
      this.videoStreamSettings.maxResolution = options.maxResolution;
    }

    const streams: Array<MediaGatewayPackets.Stream> = [];
    if (this.videoEnabled) {
      const {maxBitrate, maxFramerate, maxResolution} = this.videoStreamSettings;
      streams.push({
        active: !!options.videoActive,
        max_bitrate: maxBitrate,
        max_framerate: maxFramerate,
        max_resolution: (maxResolution) ? {
          height: maxResolution.height,
          type: maxResolution.type || 'fixed',
          width: maxResolution.width,
        } : undefined,
        quality: 100,
        rid: '100',
        rtx_ssrc: this.rtxSSRC,
        ssrc: this.videoSSRC,
        type: MediaStreamTypes.VIDEO,
      });
    }
    this.send(MediaOpCodes.CLIENT_CONNECT, {
      audio_ssrc: this.audioSSRC,
      video_ssrc: (options.videoActive) ? this.videoSSRC : 0,
      rtx_ssrc: (options.videoActive) ? this.rtxSSRC : 0,
      streams,
    }, callback);
  }

  sendMediaSinkWants(
    wants: MediaGatewayPackets.MediaSinkWants,
    callback?: Function,
  ): void {
    this.send(MediaOpCodes.MEDIA_SINK_WANTS, wants, callback);
  }

  /**
   * The wants for our current `receive`, `video`, `defaultWants` and `userWants` settings.
   * Users are only listed once we know their ssrc, until then `any` applies to them.
   */
  buildMediaSinkWants(): MediaGatewayPackets.MediaSinkWants {
    const any = (this.receiveEnabled) ? this.defaultWants : 0;
    const wants: MediaGatewayPackets.MediaSinkWants = {any};
    if (!this.receiveEnabled) {
      return wants;
    }
    for (let [ssrc, userId] of this.ssrcs[MediaSSRCTypes.AUDIO]) {
      const value = this.userWants.get(userId);
      if (value !== undefined && value !== any && userId !== this.userId) {
        wants[ssrc] = value;
      }
    }
    for (let [ssrc, userId] of this.ssrcs[MediaSSRCTypes.VIDEO]) {
      // `any` covers video too, so with video off every video ssrc has to be turned down by itself
      const value = (this.videoEnabled) ? this.userWants.get(userId) : 0;
      if (value !== undefined && value !== any && userId !== this.userId) {
        wants[ssrc] = value;
      }
    }
    return wants;
  }

  /**
   * Sends our wants to the server if they changed since the last time.
   * Nothing is sent while the server's defaults (all audio, no video) are what we want.
   */
  syncMediaSinkWants(force: boolean = false): void {
    this.mediaSinkWantsTimeout.stop();
    if (!this.ready) {
      return;
    }
    if (this.sentMediaSinkWants === null) {
      const custom = !this.receiveEnabled || this.videoEnabled || this.defaultWants !== 100 || !!this.userWants.size;
      if (!custom) {
        return;
      }
    }
    const wants = this.buildMediaSinkWants();
    const key = JSON.stringify(wants);
    if (!force && key === this.sentMediaSinkWants) {
      return;
    }
    this.sentMediaSinkWants = key;
    this.sendMediaSinkWants(wants);
  }

  /**
   * Like `syncMediaSinkWants()` but waits a moment, so setting the wants of many users at once sends one packet.
   */
  scheduleMediaSinkWants(): void {
    if (!this.ready || this.mediaSinkWantsTimeout.hasStarted) {
      return;
    }
    this.mediaSinkWantsTimeout.start(MEDIA_SINK_WANTS_DELAY, () => this.syncMediaSinkWants());
  }

  /**
   * Turns receiving on or off while connected. Off asks the server to stop forwarding everything to us.
   */
  setReceive(receive: boolean): void {
    this.receiveEnabled = !!receive;
    this.scheduleMediaSinkWants();
  }

  /**
   * Sets what we want from users without their own value, 0 to 100.
   * 0 makes `setUserWants()` an allowlist, only the users given a value are forwarded to us.
   */
  setDefaultWants(value: number): void {
    this.defaultWants = clampWants(value);
    this.scheduleMediaSinkWants();
  }

  /**
   * Sets what we want from one user, 0 to 100. 0 stops the server from forwarding them to us, `null` removes the value.
   */
  setUserWants(userId: string, value: number | null): void {
    if (value === null) {
      this.userWants.delete(userId);
    } else {
      this.userWants.set(userId, clampWants(value));
    }
    this.scheduleMediaSinkWants();
  }

  /**
   * Gives the voice server a new list of codecs mid call, it answers with a SESSION_UPDATE if that changes what we send
   */
  sendSessionUpdate(
    options: {codecs: Array<any>},
    callback?: Function,
  ): void {
    this.send(MediaOpCodes.SESSION_UPDATE, {codecs: options.codecs}, callback);
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
      // discord's client shows no speaking indicator for a speaking update with this flag
      hidden?: boolean,
      priority?: boolean,
      ssrc?: number,
      soundshare?: boolean,
      voice?: boolean,
    },
    callback?: Function,
  ): void {
    options = Object.assign({
      delay: 0,
      ssrc: this.audioSSRC,
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
    if (options.priority) {
      data.speaking |= MediaSpeakingFlags.PRIORITY;
    }
    if (options.hidden) {
      data.speaking |= MediaSpeakingFlags.HIDDEN;
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
  on(event: 'flags', listener: (payload: {flags: number, userId: string}) => any): this;
  on(event: 'killed', listener: (payload: {error?: Error}) => any): this;
  on(event: 'mediaSinkWants', listener: (wants: MediaGatewayPackets.MediaSinkWants) => any): this;
  on(event: 'open', listener: (target: BaseSocket) => any): this;
  on(event: 'packet', listener: (packet: MediaGatewayPackets.Packet) => any): this;
  on(event: 'platform', listener: (payload: {platform: number, userId: string}) => any): this;
  on(event: 'ready', listener: () => any): this;
  on(event: 'socket', listener: (socket: BaseSocket) => any): this;
  on(event: 'state', listener: ({state}: {state: SocketStates}) => any): this;
  on(event: 'transport', listener: (transport: MediaUDPSocket) => any): this;
  on(event: 'transportReady', listener: (transport: MediaUDPSocket) => any): this;
  on(event: 'videoQuality', listener: (payload: {quality: string, ssrc: number, userId: string}) => any): this;
  on(event: 'voiceBackendVersion', listener: (payload: {rtcWorker: string, voice: string}) => any): this;
  on(event: 'warn', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
