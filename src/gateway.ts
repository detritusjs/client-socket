import * as os from 'os';
import { URL } from 'url';

import { EventSpewer, BaseCollection, Timers } from 'detritus-utils';

import { BaseSocket } from './basesocket';
import { Bucket } from './bucket';
import { Decompressor } from './decompressor';
import { DroppedPacketError, SocketKillError } from './errors';
import { Socket as MediaSocket } from './media';
import { GatewayPackets } from './types';

import {
  ApiVersions,
  CompressTypes,
  EncodingTypes,
  GatewayDispatchEvents,
  GatewayIntents,
  GatewayOpCodes,
  GatewayPresenceStatuses,
  Package,
  SocketCloseCodes,
  SocketEvents,
  SocketEventsBase,
  SocketGatewayCloseCodes,
  SocketInternalCloseCodes,
  SocketInternalCloseReasons,
  SocketStates,
  COMPRESS_TYPES,
  DEFAULT_SHARD_COUNT,
  DEFAULT_SHARD_LAUNCH_DELAY,
  DEFAULT_VOICE_TIMEOUT,
  GATEWAY_INTENTS_ALL,
  GATEWAY_INTENTS_ALL_UNPRIVILEGED,
} from './constants';


const Dependencies: {
  Erlpack: any,
} = {
  Erlpack: null,
};

try {
  Dependencies.Erlpack = require('erlpack');
} catch(e) {}

const IdentifyProperties = Object.freeze({
  $browser: process.version.replace(/^v/, (process.release.name || 'node') + '/'),
  $device: `Detritus v${Package.VERSION}`,
  $os: `${os.type()} ${os.release()}; ${os.arch()}`,
});

const defaultOptions = Object.freeze({
  autoReconnect: true,
  compress: true,
  encoding: (Dependencies.Erlpack) ? EncodingTypes.ETF : EncodingTypes.JSON,
  guildSubscriptions: true,
  intents: GATEWAY_INTENTS_ALL_UNPRIVILEGED,
  largeThreshold: 250,
  presence: null,
  reconnectDelay: DEFAULT_SHARD_LAUNCH_DELAY,
  reconnectMax: 5,
  shardCount: DEFAULT_SHARD_COUNT,
  shardId: 0,
});

const defaultPresence = Object.freeze({
  afk: false,
  since: null,
  status: GatewayPresenceStatuses.ONLINE,
});

export interface SocketOptions {
  autoReconnect?: boolean,
  compress?: boolean | string,
  disabledEvents?: Array<string>,
  encoding?: string,
  guildSubscriptions?: boolean,
  identifyProperties?: IdentifyDataProperties,
  intents?: Array<number> | Array<string> | string | number,
  largeThreshold?: number,
  presence?: PresenceOptions,
  reconnectDelay?: number,
  reconnectMax?: number,
  shardCount?: number,
  shardId?: number,
  onIdentifyCheck?: () => boolean | Promise<boolean>,
}

export class Socket extends EventSpewer {
  readonly state: SocketStates = SocketStates.CLOSED;

  _lastSocket: BaseSocket | null = null;
  _packetImmediate: ReturnType<typeof setImmediate> | null = null;
  _packetQueue: Array<any> = [];
  _reconnectTimeout = new Timers.Timeout();
  _heartbeat: {
    ack: boolean,
    lastAck: null | number,
    lastSent: null | number,
    interval: Timers.Interval,
    intervalTime: null | number,
  } = {
    ack: false,
    lastAck: null,
    lastSent: null,
    interval: new Timers.Interval(),
    intervalTime: null,
  };
  autoReconnect: boolean;
  bucket: Bucket;
  compress: CompressTypes;
  disabledEvents: Array<string>;
  discordTrace: Array<any> = [];
  decompressor: Decompressor | null;
  encoding: EncodingTypes;
  guildSubscriptions: boolean;
  identifyProperties: IdentifyDataProperties = Object.assign({}, IdentifyProperties);
  intents: number = GATEWAY_INTENTS_ALL_UNPRIVILEGED;
  killed: boolean = false;
  largeThreshold: number;
  mediaGateways = new BaseCollection<string, MediaSocket>();
  presence: PresenceOptions | null = null;
  reconnectDelay: number;
  reconnectMax: number;
  reconnects: number = 0;
  resumeGatewayUrl: null | string = null;
  resuming: boolean = false;
  sequence: number = 0;
  sessionId: null | string = null;
  shardCount: number;
  shardId: number;
  socket: BaseSocket | null = null;
  token: string;
  url: URL | null = null;
  userId: null | string = null;

  onIdentifyCheck?(): boolean | Promise<boolean>;

  constructor(
    token: string,
    options: SocketOptions = {},
  ) {
    super();

    options = Object.assign({
      disabledEvents: [],
    }, defaultOptions, options);
    if (typeof(options.compress) === 'boolean') {
      if (options.compress) {
        options.compress = Decompressor.supported().shift();
      } else {
        options.compress = CompressTypes.NONE;
      }
    }

    this.autoReconnect = !!options.autoReconnect;
    this.compress = options.compress!.toLowerCase() as CompressTypes;
    this.encoding = options.encoding!.toLowerCase() as EncodingTypes;
    this.disabledEvents = options.disabledEvents as Array<string>;
    this.guildSubscriptions = !!options.guildSubscriptions;
    this.largeThreshold = options.largeThreshold as number;
    this.reconnectDelay = options.reconnectDelay as number;
    this.reconnectMax = options.reconnectMax as number;
    this.shardCount = options.shardCount as number;
    this.shardId = options.shardId as number;
    this.token = token;

    this.emitPackets = this.emitPackets.bind(this);
    this.onIdentifyCheck = options.onIdentifyCheck || this.onIdentifyCheck;

    if (options.presence) {
      this.presence = Object.assign({}, defaultPresence, options.presence);
    }

    Object.assign(this.identifyProperties, options.identifyProperties);

    if (!COMPRESS_TYPES.includes(this.compress)) {
      throw new Error(`Compress type must be of: '${COMPRESS_TYPES.join(', ')}'`);
    }

    if (this.shardCount <= this.shardId) {
      throw new Error('Shard count cannot be less than or equal to the Shard Id!');
    }

    if (!Object.values(EncodingTypes).includes(this.encoding)) {
      throw new Error(`Invalid Encoding Type, valid: ${JSON.stringify(Object.values(EncodingTypes))}`);
    }

    if (this.encoding === EncodingTypes.ETF && !Dependencies.Erlpack) {
      throw new Error('Install `Erlpack` to use ETF encoding.');
    }

    // reserve a few of the 120 per minute for heartbeats and identify/resume, which skip the queue
    this.bucket = new Bucket(120, 60 * 1000, 5);
    // regular sends wait for READY/RESUMED, sending anything before identifying gets the socket closed with 4003
    this.bucket.lock();

    this.decompressor = null;
    switch (this.compress) {
      case CompressTypes.ZLIB:
      case CompressTypes.ZSTD: {
        if (!Decompressor.supported().includes(this.compress)) {
          throw new Error(`Missing modules for ${this.compress} Compress Type`);
        }
        this.decompressor = new Decompressor({type: this.compress});
        this.decompressor.on('data', (data) => {
          this.handle(data, true);
        }).on('error', (error) => {
          this.disconnect(SocketInternalCloseCodes.INVALID_DATA);
          this.emit(SocketEvents.WARN, error);
        });
      };
    }

    if (options.intents !== undefined) {
      this.intents = 0;
      if (options.intents === 'ALL') {
        this.intents = GATEWAY_INTENTS_ALL;
      } else if (options.intents === 'ALL_UNPRIVILEGED') {
        this.intents = GATEWAY_INTENTS_ALL_UNPRIVILEGED;
      } else {
        const intents = (Array.isArray(options.intents)) ? options.intents : [options.intents];
        for (let intent of intents) {
          if (typeof(intent) === 'string') {
            intent = intent.toUpperCase();
            if (intent in GatewayIntents) {
              this.intents |= (GatewayIntents as any)[intent];
            }
          } else if (typeof(intent) === 'number') {
            this.intents |= intent;
          } else {
            throw new Error(`Invalid intent received: ${intent}`);
          }
        }
      }
    }

    Object.defineProperties(this, {
      _heartbeat: {enumerable: false, writable: false},
      _lastSocket: {enumerable: false},
      _packetImmediate: {enumerable: false},
      _packetQueue: {enumerable: false, writable: false},
      _reconnectTimeout: {enumerable: false, writable: false},
      emitPackets: {enumerable: false},
      identifyProperties: {enumerable: false},
      killed: {configurable: true},
      state: {configurable: true, writable: false},
      token: {enumerable: false, writable: false},
    });
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

  setState(value: SocketStates): void {
    if (value in SocketStates && value !== this.state) {
      Object.defineProperty(this, 'state', {value});
      this.emit(SocketEvents.STATE, {state: value});
    }
  }

  makePresence(options: PresenceOptions = {}): RawPresence {
    options = this.presence = Object.assign({}, defaultPresence, this.presence, options);

    const data: RawPresence = {
      activities: [],
      afk: !!options.afk,
      since: options.since || null,
      status: options.status || defaultPresence.status,
    };

    const activities: Array<PresenceActivityOptions> = [...(options.activities || [])];
    if (options.activity) {
      activities.unshift(options.activity);
    }
    if (options.game) {
      activities.unshift(options.game);
    }

    if (activities.length) {
      for (let activity of activities) {
        const raw: RawPresenceActivity = {
          application_id: activity.applicationId,
          assets: undefined,
          buttons: activity.buttons,
          details: activity.details,
          emoji: undefined,
          flags: activity.flags,
          metadata: activity.metadata,
          name: activity.name,
          party: undefined,
          platform: activity.platform,
          secrets: undefined,
          session_id: activity.sessionId,
          state: activity.state,
          sync_id: activity.syncId,
          timestamps: undefined,
          type: activity.type,
          url: activity.url,
        };

        if (activity.assets) {
          raw.assets = {
            large_image: activity.assets.largeImage,
            large_text: activity.assets.largeText,
            small_image: activity.assets.smallImage,
            small_text: activity.assets.smallText,
          };
        }
        if (activity.emoji) {
          raw.emoji = {
            animated: activity.emoji.animated,
            id: activity.emoji.id,
            name: activity.emoji.name,
          };
        }
        if (activity.party) {
          raw.party = {
            id: activity.party.id,
            size: activity.party.size,
          };
        }
        if (activity.secrets) {
          raw.secrets = {
            join: activity.secrets.join,
            match: activity.secrets.match,
            spectate: activity.secrets.spectate,
          };
        }
        if (activity.timestamps) {
          raw.timestamps = {
            end: activity.timestamps.end,
            start: activity.timestamps.start,
          };
        }
        data.activities.push(raw);
      }
    }
    return data;
  }

  getIdentifyData(): IdentifyData {
    const data: IdentifyData = {
      guild_subscriptions: this.guildSubscriptions,
      intents: this.intents,
      large_threshold: this.largeThreshold,
      properties: this.identifyProperties,
      token: this.token,
    };
    if (DEFAULT_SHARD_COUNT < this.shardCount) {
      data.shard = [this.shardId, this.shardCount];
    }
    if (this.presence) {
      data.presence = this.makePresence();
    }
    return data;
  }

  getResumeData(): ResumeData {
    return {
      seq: this.sequence || null,
      session_id: this.sessionId,
      token: this.token,
    };
  }

  cleanup(code?: string | number, reason?: string): void {
    this.bucket.clear();
    this.bucket.lock();
    if (this.decompressor) {
      this.decompressor.reset();
    }

    if (code !== undefined) {
      code = parseInt(code as string);
      switch (code) {
        // un-resumable events
        case SocketCloseCodes.NORMAL:
        case SocketGatewayCloseCodes.INVALID_SEQUENCE:
        case SocketGatewayCloseCodes.SESSION_TIMEOUT:
        case SocketInternalCloseCodes.INVALID_SESSION_NON_RESUMABLE: {
          this.sequence = 0;
          this.sessionId = null;
          this.resumeGatewayUrl = null;
        }; break;
        // un-resumable and kill socket
        case SocketGatewayCloseCodes.AUTHENTICATION_FAILED:
        case SocketGatewayCloseCodes.INVALID_SHARD:
        case SocketGatewayCloseCodes.SHARDING_REQUIRED:
        case SocketGatewayCloseCodes.INVALID_VERSION:
        case SocketGatewayCloseCodes.INVALID_INTENTS:
        case SocketGatewayCloseCodes.DISALLOWED_INTENTS: {
          this.kill(new SocketKillError(code, reason));
        }; break;
      }
    }

    this._heartbeat.interval.stop();
    this._heartbeat.ack = false;
    this._heartbeat.lastAck = null;
    this._heartbeat.lastSent = null;
    this._heartbeat.intervalTime = null;
  }

  connect(
    url?: null | string | URL,
  ): void {
    if (this.killed) {return;}
    this._reconnectTimeout.stop();
    if (this.connected) {
      this.disconnect(SocketInternalCloseCodes.RECONNECTING);
    }

    // only resumes go to `resume_gateway_url`, keep `this.url` as the gateway url to identify on
    let isResumeUrl = false;
    if (!url) {
      if (this.resumeGatewayUrl) {
        url = this.resumeGatewayUrl;
        isResumeUrl = true;
      } else {
        url = this.url;
      }
    }

    if (!url) {
      throw new Error('Socket requires a url to connect to.');
    }

    const gatewayUrl = new URL('', url as string | URL);
    gatewayUrl.searchParams.set('encoding', this.encoding);
    gatewayUrl.searchParams.set('v', String(ApiVersions.GATEWAY));
    gatewayUrl.pathname = gatewayUrl.pathname || '/';

    switch (this.compress) {
      case CompressTypes.ZLIB:
      case CompressTypes.ZSTD: {
        gatewayUrl.searchParams.set('compress', this.compress);
      }; break;
    }
    if (!isResumeUrl) {
      this.url = gatewayUrl;
    }

    try {
      this.socket = this._lastSocket = new BaseSocket(gatewayUrl.href);
      this.socket.on(SocketEventsBase.CLOSE, this.onClose.bind(this, this.socket));
      this.socket.on(SocketEventsBase.ERROR, this.onError.bind(this, this.socket));
      this.socket.on(SocketEventsBase.MESSAGE, this.onMessage.bind(this, this.socket));
      this.socket.on(SocketEventsBase.OPEN, this.onOpen.bind(this, this.socket));
    } catch(error) {
      this.socket = null;
      this.emit(SocketEvents.WARN, error);
      if (this.autoReconnect && !this.killed) {
        if (this.reconnectMax <= this.reconnects) {
          this.kill(new Error(`Tried reconnecting ${this.reconnectMax} times.`));
        } else {
          this.emit(SocketEvents.RECONNECTING);
          this._reconnectTimeout.start(this.reconnectDelay, () => {
            this.reconnects++;
            this.connect((isResumeUrl) ? null : url);
          });
        }
      }
    }

    this.setState(SocketStates.CONNECTING);
    this.emit(SocketEvents.SOCKET, this.socket);
  }

  decode(
    data: any,
    uncompressed: boolean = false,
  ): any {
    try {
      if (data instanceof ArrayBuffer) {
        data = Buffer.from(new Uint8Array(data));
      } else if (Array.isArray(data)) {
        data = Buffer.concat(data);
      }
      if (!uncompressed) {
        if (this.decompressor) {
          this.decompressor.feed(data);
          return null;
        }
      }
      switch (this.encoding) {
        case EncodingTypes.ETF: return Dependencies.Erlpack.unpack(data);
        case EncodingTypes.JSON: return JSON.parse(data);
      }
    } catch(error) {
      this.emit(SocketEvents.WARN, error);
    }
  }

  disconnect(
    code: number = SocketCloseCodes.NORMAL,
    reason?: string,
  ): void {
    this.cleanup(code, reason);
    // internal disconnects use `SocketInternalCloseCodes` and still reconnect through `onClose`
    if (!(code in SocketInternalCloseReasons)) {
      this._lastSocket = null;
      this._reconnectTimeout.stop();
      this.setState(SocketStates.CLOSED);
    }
    if (this.socket) {
      if (!reason && (code in SocketInternalCloseReasons)) {
        reason = (SocketInternalCloseReasons as any)[code];
      }
      this.socket.close(code, reason);
      this.socket = null;
    }
    this.resuming = false;
  }

  handle(
    data: any,
    uncompressed: boolean = false,
  ): void {
    const packet = this.decode(data, uncompressed);
    if (!packet) {return;}
    if (packet.s !== null) {
      this.sequence = packet.s;
    }

    switch (packet.op) {
      case GatewayOpCodes.HEARTBEAT: {
        // discord asked for one, send it without clearing `ack`
        // otherwise our interval firing before this one's ack comes back would see a zombie and reconnect
        this.heartbeat(false, true);
      }; break;
      case GatewayOpCodes.HEARTBEAT_ACK: {
        this._heartbeat.ack = true;
        this._heartbeat.lastAck = Date.now();
      }; break;
      case GatewayOpCodes.HELLO: {
        const data: GatewayPackets.Hello = packet.d;

        this.setHeartbeat(data);
        if (this.sessionId) {
          this.resume();
        } else {
          const socket = this.socket;
          this.identifyTry().catch((error) => {
            this.emit(SocketEvents.WARN, error);
            if (this.socket === socket) {
              this.disconnect(SocketInternalCloseCodes.RECONNECTING);
            }
          });
        }
      }; break;
      case GatewayOpCodes.INVALID_SESSION: {
        const shouldResume: GatewayPackets.InvalidSession = packet.d;
        if (!shouldResume) {
          this.sequence = 0;
          this.sessionId = null;
          this.resumeGatewayUrl = null;
        }
        // discord recommends waiting a random 1-5 seconds before resuming/identifying again
        const socket = this.socket;
        this._reconnectTimeout.start(1000 + Math.round(Math.random() * 4000), () => {
          if (this.socket !== socket) {
            return;
          }
          if (shouldResume) {
            this.resume();
          } else {
            this.disconnect(SocketInternalCloseCodes.INVALID_SESSION_NON_RESUMABLE);
            this.connect();
          }
        });
      }; break;
      case GatewayOpCodes.RECONNECT: {
        this.disconnect(SocketInternalCloseCodes.RECONNECTING);
        this.connect();
      }; break;
      case GatewayOpCodes.DISPATCH: {
        this.handleDispatch(packet.t, packet.d);
      }; break;
    }

    // nothing listens for the raw packets most of the time, don't schedule anything for them
    if (this.hasEventListener(SocketEvents.PACKET)) {
      this._packetQueue.push(packet);
      if (!this._packetImmediate) {
        this._packetImmediate = setImmediate(this.emitPackets);
      }
    }
  }

  /**
   * Emits the queued raw packets in order, one immediate for every packet handled in the same tick
   */
  emitPackets(): void {
    const queue = this._packetQueue;
    // packets queued while emitting wait for the next immediate, like they would with their own `setImmediate()`
    const end = queue.length;
    let i = 0;
    try {
      while (i < end && i < queue.length) {
        this.emit(SocketEvents.PACKET, queue[i++]);
      }
    } finally {
      // a throwing listener still surfaces as an uncaught exception, the rest of the packets go out on the next immediate
      if (i < queue.length) {
        queue.splice(0, i);
        this._packetImmediate = setImmediate(this.emitPackets);
      } else {
        queue.length = 0;
        this._packetImmediate = null;
      }
    }
  }

  handleDispatch(
    name: string,
    data: any,
  ): void {
    switch (name) {
      case GatewayDispatchEvents.READY: {
        this.bucket.unlock();
        this.reconnects = 0;
        this.discordTrace = data['_trace'];
        this.resumeGatewayUrl = data['resume_gateway_url'];
        this.sessionId = data['session_id'];
        this.userId = data['user']['id'];
        this.setState(SocketStates.READY);
        this.emit(SocketEvents.READY);
      }; break;
      case GatewayDispatchEvents.RESUMED: {
        this.reconnects = 0;
        this.resuming = false;
        this.bucket.unlock();
        this.setState(SocketStates.READY);
        this.emit(SocketEvents.READY);
      }; break;
      case GatewayDispatchEvents.GUILD_DELETE: {
        const serverId = data['id'] as string;
        if (this.mediaGateways.has(serverId)) {
          const mGateway = this.mediaGateways.get(serverId) as MediaSocket;
          if (data['unavailable']) {
            mGateway.kill(new Error('The guild this voice was connected to became unavailable'));
          } else {
            mGateway.kill(new Error('Left the guild this voice was connected to'));
          }
        }
      }; break;
      case GatewayDispatchEvents.VOICE_SERVER_UPDATE: {
        const serverId = (data['guild_id'] || data['channel_id']) as string;
        if (this.mediaGateways.has(serverId)) {
          const gateway = this.mediaGateways.get(serverId) as MediaSocket;
          gateway.setEndpoint(data['endpoint']);
          gateway.setToken(data['token']);
        }
      }; break;
      case GatewayDispatchEvents.VOICE_STATE_UPDATE: {
        const userId = data['user_id'] as string;
        if (userId !== this.userId) {
          // not our voice state update
          return;
        }
        const serverId = (data['guild_id'] || data['channel_id']) as string;
        if (this.mediaGateways.has(serverId)) {
          const gateway = this.mediaGateways.get(serverId) as MediaSocket;
          if (!data['channel_id']) {
            gateway.kill();
          } else if (gateway.sessionId !== data['session_id']) {
            // leaving the channel would disconnect the session that took over
            gateway.kill(new Error('Connected to this server from a different session'), {voiceStateUpdate: false});
          } else {
            gateway.setChannelId(data['channel_id']);
            gateway.resolvePromises();
          }
        }
      }; break;
    }
  }

  kill(error?: Error): void {
    if (!this.killed) {
      Object.defineProperty(this, 'killed', {value: true});
      this._reconnectTimeout.stop();
      this.disconnect(SocketCloseCodes.NORMAL);
      if (this.decompressor) {
        // frees the zlib stream, `cleanup` would otherwise re-create it when the socket closes
        this.decompressor.close();
        this.decompressor = null;
      }
      for (let [serverId, socket] of this.mediaGateways) {
        socket.kill(error);
      }
      this.emit(SocketEvents.KILLED, {error});
      this.removeAllListeners();
      // the queued packets have no one left to go to
      if (this._packetImmediate) {
        clearImmediate(this._packetImmediate);
        this._packetImmediate = null;
      }
      this._packetQueue.length = 0;
    }
  }

  onClose(
    target: BaseSocket,
    code?: number,
    reason?: string,
  ) {
    if (code === undefined) {
      code = SocketInternalCloseCodes.CONNECTION_ERROR;
    }
    if (!reason && (code in SocketInternalCloseReasons)) {
      reason = (SocketInternalCloseReasons as any)[code];
    }
    // a stale socket closing late must not schedule a second reconnect
    const isCurrent = (this.socket === target || (!this.socket && this._lastSocket === target));
    this.emit(SocketEvents.CLOSE, {code, reason, stale: !isCurrent});
    if (isCurrent) {
      this.setState(SocketStates.CLOSED);
      this.disconnect(code, reason);
      if (this.autoReconnect && !this.killed) {
        if (this.reconnectMax <= this.reconnects) {
          this.kill(new Error(`Tried reconnecting ${this.reconnectMax} times.`));
        } else {
          this.emit(SocketEvents.RECONNECTING);
          this._reconnectTimeout.start(this.reconnectDelay, () => {
            this.reconnects++;
            this.connect();
          });
        }
      }
    }
  }

  onError(
    target: BaseSocket,
    error: Error,
  ) {
    this.emit(SocketEvents.WARN, error);
  }

  onMessage(
    target: BaseSocket,
    data: any,
    isBinary?: boolean,
  ) {
    if (this.socket === target) {
      this.handle(data);
    } else {
      target.close(SocketInternalCloseCodes.OTHER_SOCKET_MESSAGE);
    }
  }

  onOpen(target: BaseSocket) {
    this.emit(SocketEvents.OPEN, target);
    if (this.socket === target) {
      this.setState(SocketStates.OPEN);
    } else {
      target.close(SocketInternalCloseCodes.OTHER_SOCKET_OPEN);
    }
  }

  async ping(timeout?: number): Promise<any> {
    if (!this.connected || !this.socket) {
      throw new Error('Socket is still initializing!');
    }
    return this.socket.ping(timeout);
  }

  send(
    op: number,
    d: any,
    callback?: Function,
    priority: boolean = false,
  ): void {
    const packet = {op, d};

    let data: any;
    try {
      switch (this.encoding) {
        case EncodingTypes.JSON: data = JSON.stringify(packet); break;
        case EncodingTypes.ETF: data = Dependencies.Erlpack.pack(packet); break;
        default: {
          throw new DroppedPacketError(packet, `Invalid encoding: ${this.encoding}`);
        };
      }
    } catch(error) {
      this.emit(SocketEvents.WARN, error);
    }
    if (data !== undefined) {
      if (priority) {
        this.bucket.addPriority(() => {
          if (this.connected && this.socket) {
            this.socket.send(data, callback);
          } else {
            this.emit(SocketEvents.WARN, new DroppedPacketError(packet, 'Socket isn\'t connected'));
          }
        });
      } else {
        const throttled = () => {
          if (this.bucket.locked || !this.connected) {
            if (!this.bucket.locked) {
              this.bucket.lock();
            }
            this.bucket.add(throttled, true);
          } else {
            try {
              (this.socket as BaseSocket).send(data, callback);
            } catch(error) {
              this.emit(SocketEvents.WARN, error);
            }
          }
        }
        this.bucket.add(throttled);
      }
    }
  }

  heartbeat(fromInterval: boolean = false, requested: boolean = false): void {
    if (fromInterval && !this._heartbeat.ack) {
      this.disconnect(SocketInternalCloseCodes.HEARTBEAT_ACK);
      this.connect();
    } else {
      if (!requested) {
        this._heartbeat.ack = false;
      }
      this._heartbeat.lastSent = Date.now();
      const sequence = (this.sequence) ? this.sequence : null;
      this.send(GatewayOpCodes.HEARTBEAT, sequence, undefined, true);
    }
  }

  setHeartbeat(data: GatewayPackets.Hello): void {
    if (data) {
      this._heartbeat.ack = true;
      this._heartbeat.lastAck = Date.now();
      // sets `ack` to false, so a zombied connection is caught on the first interval
      this.heartbeat();
      this._heartbeat.intervalTime = data['heartbeat_interval'];
      this._heartbeat.interval.start(this._heartbeat.intervalTime, () => {
        this.heartbeat(true);
      });
      this.discordTrace = data._trace;
    }
  }

  identify(): void {
    if (this.state !== SocketStates.OPEN && this.state !== SocketStates.RESUMING) {
      return;
    }

    const data = this.getIdentifyData();
    this.send(GatewayOpCodes.IDENTIFY, data, () => {
      this.setState(SocketStates.IDENTIFYING);
    }, true);
  }

  async identifyTry(): Promise<void> {
    const socket = this.socket;
    if (!this.onIdentifyCheck || (await Promise.resolve(this.onIdentifyCheck()))) {
      // the check may be async, don't identify on a socket that replaced the one we checked for
      if (this.socket === socket) {
        this.identify();
      }
    }
  }

  resume(): void {
    this.resuming = true;
    const data = this.getResumeData();
    this.send(GatewayOpCodes.RESUME, data, () => {
      this.setState(SocketStates.RESUMING);
    }, true);
  }

  callConnect(
    channelId: string,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.CALL_CONNECT, {
      channel_id: channelId,
    }, callback);
  }

  guildStreamCreate(
    guildId: string,
    options: {
      channelId: string,
      preferredRegion?: string,
    },
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.STREAM_CREATE, {
      channel_id: options.channelId,
      guild_id: guildId,
      preferred_region: options.preferredRegion,
      type: 'guild',
    }, callback);
  }

  lobbyConnect(
    lobbyId: string,
    lobbySecret: string,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.LOBBY_CONNECT, {
      lobby_id: lobbyId,
      lobby_secret: lobbySecret,
    }, callback);
  }

  lobbyDisconnect(
    lobbyId: string,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.LOBBY_DISCONNECT, {
      lobby_id: lobbyId,
    }, callback);
  }

  lobbyVoiceStatesUpdate(
    voiceStates: Array<{
      lobbyId: string,
      selfDeaf: boolean,
      selfMute: boolean,
    }>,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.LOBBY_VOICE_STATES_UPDATE, voiceStates.map((voiceState) => {
      return {
        lobby_id: voiceState.lobbyId,
        self_deaf: voiceState.selfDeaf,
        self_mute: voiceState.selfMute,
      };
    }), callback);
  }

  // the response comes back as a `CHANNEL_INFO` dispatch
  requestChannelInfo(
    guildId: string,
    fields: Array<string> = ['status', 'voice_start_time'],
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.REQUEST_CHANNEL_INFO, {
      guild_id: guildId,
      fields,
    }, callback);
  }

  requestGuildMembers(
    guildIds: Array<string> | string,
    options: {
      limit: number,
      nonce?: string,
      presences?: boolean,
      query?: string,
      userIds?: Array<string>,
    },
    callback?: Function,
  ): void {
    const data: any = {
      guild_id: guildIds,
      limit: options.limit,
      nonce: options.nonce,
      presences: options.presences,
    };
    // discord requires exactly one of `query` or `user_ids`
    if (options.userIds) {
      data.user_ids = options.userIds;
    } else {
      data.query = options.query || '';
    }
    this.send(GatewayOpCodes.REQUEST_GUILD_MEMBERS, data, callback);
  }

  // the response comes back as `SOUNDBOARD_SOUNDS` dispatches, one per guild
  requestSoundboardSounds(
    guildIds: Array<string> | string,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.REQUEST_SOUNDBOARD_SOUNDS, {
      guild_ids: (Array.isArray(guildIds)) ? guildIds : [guildIds],
    }, callback);
  }

  requestApplicationCommands(
    guildId: string,
    options: {
      applicationId?: string,
      applications: boolean,
      limit?: number,
      nonce: string,
      offset?: number,
      query?: string,
    },
  ): void {
    this.send(GatewayOpCodes.REQUEST_APPLICATION_COMMANDS, {
      application_id: options.applicationId,
      guild_id: guildId,
      limit: options.limit,
      nonce: options.nonce,
      offset: options.offset,
      query: options.query,
    });
  }

  setPresence(
    options: PresenceOptions = {},
    callback?: Function,
  ): void {
    const data = this.makePresence(options);
    this.send(GatewayOpCodes.PRESENCE_UPDATE, data, callback);
  }

  streamDelete(
    streamKey: string,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.STREAM_DELETE, {
      stream_key: streamKey,
    }, callback);
  }

  streamPing(
    streamKey: string,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.STREAM_PING, {
      stream_key: streamKey,
    }, callback);
  }

  streamSetPaused(
    streamKey: string,
    paused: boolean,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.STREAM_SET_PAUSED, {
      stream_key: streamKey,
      paused,
    }, callback);
  }

  streamWatch(
    streamKey: string,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.STREAM_WATCH, {
      stream_key: streamKey,
    }, callback);
  }

  syncGuild(
    guildIds: Array<string>,
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.SYNC_GUILD, guildIds, callback);
  }

  updateGuildSubscriptions(
    guildId: string,
    options: {
      activities?: boolean,
      channels?: {[channelId: string]: Array<[number, number]>},
      members?: Array<string>,
      typing?: boolean,
    } = {},
    callback?: Function,
  ) : void {
    this.send(GatewayOpCodes.GUILD_SUBSCRIPTIONS, {
      activities: options.activities,
      channels: options.channels,
      guild_id: guildId,
      members: options.members,
      typing: options.typing,
    }, callback);
  }

  voiceServerPing(callback?: Function) {
    this.send(GatewayOpCodes.VOICE_SERVER_PING, null, callback);
  }

  voiceStateUpdate(
    guildId: null | string = null,
    channelId: null | string = null,
    options: {
      preferredRegion?: string,
      selfDeaf?: boolean,
      selfMute?: boolean,
      selfVideo?: boolean,
    } = {},
    callback?: Function,
  ): void {
    this.send(GatewayOpCodes.VOICE_STATE_UPDATE, {
      channel_id: channelId,
      guild_id: guildId,
      preferred_region: options.preferredRegion,
      self_deaf: options.selfDeaf,
      self_mute: options.selfMute,
      self_video: options.selfVideo,
    }, callback);
  }

  async voiceConnect(
    guildId?: null | string,
    channelId?: null | string,
    options: {
      forceMode?: string,
      receive?: boolean,
      selfDeaf?: boolean,
      selfMute?: boolean,
      selfVideo?: boolean,
      timeout?: number,
      video?: boolean,
    } = {},
  ): Promise<MediaSocket | null> {
    if (!guildId && !channelId) {
      throw new Error('A Guild Id or a Channel Id is required.');
    }

    options = Object.assign({}, options);
    if (options.receive === undefined) {
      options.receive = true;
    }
    if (options.timeout === undefined) {
      options.timeout = DEFAULT_VOICE_TIMEOUT;
    }

    if (options.selfVideo && options.video === undefined) {
      options.video = options.selfVideo;
    }

    const serverId = (guildId || channelId)!;
    let gateway: MediaSocket;
    if (this.mediaGateways.has(serverId)) {
      gateway = this.mediaGateways.get(serverId)!;
      if (!channelId) {
        gateway.kill();
        return null;
      }
      if (channelId === gateway.channelId) {
        return gateway;
      }
    } else {
      if (!channelId) {
        this.voiceStateUpdate(guildId, channelId, options);
        return null;
      }
      gateway = new MediaSocket(this, {
        channelId,
        forceMode: options.forceMode,
        receive: options.receive,
        serverId,
        userId: (<string> this.userId),
        video: options.video,
      });
      this.mediaGateways.set(serverId, gateway);
    }

    const timeout = new Timers.Timeout();
    if (options.timeout) {
      timeout.start(options.timeout, () => {
        gateway.kill(new Error(`Voice Gateway took longer than ${options.timeout}ms.`));
      });
    }

    return new Promise((resolve, reject) => {
      gateway.promises.add({resolve, reject});
      this.voiceStateUpdate(guildId, channelId, options);
    }).then(() => {
      timeout.stop();
      return (channelId) ? gateway : null;
    }).catch((error) => {
      timeout.stop();
      throw error;
    });
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: SocketEvents.CLOSE | 'close', listener: (payload: {code: number, reason: string}) => any): this;
  on(event: SocketEvents.KILLED | 'killed', listener: (payload: {error?: Error}) => any): this;
  on(event: SocketEvents.OPEN | 'open', listener: (target: BaseSocket) => any): this;
  on(event: SocketEvents.PACKET | 'packet', listener: (packet: GatewayPackets.Packet) => any): this;
  on(event: SocketEvents.READY | 'ready', listener: () => any): this;
  on(event: SocketEvents.SOCKET | 'socket', listener: (socket: BaseSocket) => any): this;
  on(event: SocketEvents.STATE | 'state', listener: ({state}: {state: SocketStates}) => any): this;
  on(event: SocketEvents.WARN | 'warn', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}

export interface IdentifyData {
  compress?: boolean,
  guild_subscriptions?: boolean,
  intents?: number,
  large_threshold?: number,
  presence?: RawPresence,
  properties: IdentifyDataProperties,
  shard?: Array<number>,
  token: string,
}

export interface IdentifyDataProperties {
  $browser?: string,
  $device?: string,
  $os?: string,
  os?: string,
  browser?: string,
  browser_user_agent?: string,
  browser_version?: string,
  client_build_number?: number,
  client_event_source?: string,
  client_version?: string,
  distro?: string,
  os_version?: string,
  os_arch?: string,
  release_channel?: string,
  window_manager?: string,
}

export interface RawPresenceActivity {
  application_id?: string,
  assets?: {
    large_image?: string,
    large_text?: string,
    small_image?: string,
    small_text?: string,
  },
  buttons?: Array<string>,
  details?: string,
  emoji?: {
    animated: boolean,
    id: null | string,
    name: string,
  },
  flags?: number,
  id?: string,
  instance?: boolean,
  metadata?: {[key: string]: any},
  name: string,
  party?: {
    id?: string,
    size?: Array<[number, number]>,
  },
  platform?: string,
  secrets?: {
    join?: string,
    match?: string,
    spectate?: string,
  },
  session_id?: string,
  state?: string,
  sync_id?: string,
  timestamps?: {
    end?: number,
    start?: number,
  },
  type: number,
  url?: string,
}

export interface RawPresence {
  activities: Array<RawPresenceActivity>,
  afk: boolean,
  since: null | number,
  status: string,
}

export interface ResumeData {
  seq?: null | number,
  session_id: null | string,
  token: string,
}


export interface PresenceActivityOptions {
  applicationId?: string,
  assets?: {
    largeImage?: string,
    largeText?: string,
    smallImage?: string,
    smallText?: string,
  },
  buttons?: Array<string>,
  details?: string,
  emoji?: {
    animated: boolean,
    id: null | string,
    name: string,
  },
  flags?: number,
  metadata?: {[key: string]: any},
  name: string,
  party?: {
    id?: string,
    size?: Array<[number, number]>,
  },
  platform?: string,
  secrets?: {
    join?: string,
    match?: string,
    spectate?: string,
  },
  sessionId?: string,
  state?: string,
  syncId?: string,
  timestamps?: {
    end?: number,
    start?: number,
  },
  type: number,
  url?: string,
}

export interface PresenceOptions {
  activities?: Array<PresenceActivityOptions>,
  activity?: PresenceActivityOptions,
  afk?: boolean,
  game?: PresenceActivityOptions,
  since?: null | number,
  status?: string,
}
