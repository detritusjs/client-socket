export const Package = Object.freeze({
  URL: 'https://github.com/detritusjs/client-socket',
  VERSION: '0.6.0',
});

function normalize(object: {[key: string]: any}) {
  for (let key in object) {
    object[key] = key;
  }
  return Object.freeze(object);
}


export const ApiVersions = Object.freeze({
  GATEWAY: 6,
  MEDIA_GATEWAY: 5,
});

export enum CompressTypes {
  NONE = 'none',
  PAYLOAD = 'payload',
  ZLIB = 'zlib-stream',
}

export const COMPRESS_TYPES = Object.freeze(Object.values(CompressTypes));

export enum CryptoModules {
  LIBSODIUM_WRAPPERS = 'libsodium-wrappers',
  SODIUM = 'sodium',
  TWEETNACL = 'tweetnacl',
}

export const DEFAULT_SHARD_COUNT = 1;
export const DEFAULT_SHARD_LAUNCH_DELAY = 5000;
export const DEFAULT_VOICE_TIMEOUT = 30000;

export enum EncodingTypes {
  ETF = 'etf',
  JSON = 'json',
}

export enum GatewayActivityActionTypes {
  JOIN = 1,
  SPECTATE = 2,
  LISTEN = 3,
  WATCH = 4,
  JOIN_REQUEST = 5,
}

export enum GatewayActivityFlags {
  INSTANCE = 1 << 0,
  JOIN = 1 << 1,
  SPECTATE = 1 << 2,
  JOIN_REQUEST = 1 << 3,
  SYNC = 1 << 4,
  PLAY = 1 << 5,
}

export enum GatewayActivityTypes {
  PLAYING = 0,
  STREAMING = 1,
  LISTENING = 2,
  WATCHING = 3,
  CUSTOM_STATUS = 4,
}

export const GatewayDispatchEvents = normalize({
  READY: null,
  RESUMED: null,
  ACTIVITY_JOIN_INVITE: null,
  ACTIVITY_JOIN_REQUEST: null,
  ACTIVITY_START: null,
  BRAINTREE_POPUP_BRIDGE_CALLBACK: null,
  CALL_CREATE: null,
  CALL_DELETE: null,
  CALL_UPDATE: null,
  CHANNEL_CREATE: null,
  CHANNEL_DELETE: null,
  CHANNEL_UPDATE: null,
  CHANNEL_PINS_ACK: null,
  CHANNEL_PINS_UPDATE: null,
  CHANNEL_RECIPIENT_ADD: null,
  CHANNEL_RECIPIENT_REMOVE: null,
  ENTITLEMENT_CREATE: null,
  ENTITLEMENT_DELETE: null,
  ENTITLEMENT_UPDATE: null,
  FRIEND_SUGGESTION_CREATE: null,
  FRIEND_SUGGESTION_DELETE: null,
  GIFT_CODE_UPDATE: null,
  GUILD_BAN_ADD: null,
  GUILD_BAN_REMOVE: null,
  GUILD_CREATE: null,
  GUILD_DELETE: null,
  GUILD_UPDATE: null,
  GUILD_EMOJIS_UPDATE: null,
  GUILD_INTEGRATIONS_UPDATE: null,
  GUILD_MEMBER_ADD: null,
  GUILD_MEMBER_LIST_UPDATE: null,
  GUILD_MEMBER_REMOVE: null,
  GUILD_MEMBER_UPDATE: null,
  GUILD_MEMBERS_CHUNK: null,
  GUILD_ROLE_CREATE: null,
  GUILD_ROLE_DELETE: null,
  GUILD_ROLE_UPDATE: null,
  INVITE_CREATE: null,
  INVITE_DELETE: null,
  LIBRARY_APPLICATION_UPDATE: null,
  LOBBY_CREATE: null,
  LOBBY_DELETE: null,
  LOBBY_UPDATE: null,
  LOBBY_MEMBER_CONNECT: null,
  LOBBY_MEMBER_DISCONNECT: null,
  LOBBY_MEMBER_UPDATE: null,
  LOBBY_MESSAGE: null,
  LOBBY_VOICE_SERVER_UPDATE: null,
  LOBBY_VOICE_STATE_UPDATE: null,
  MESSAGE_ACK: null,
  MESSAGE_CREATE: null,
  MESSAGE_DELETE: null,
  MESSAGE_DELETE_BULK: null,
  MESSAGE_REACTION_ADD: null,
  MESSAGE_REACTION_REMOVE: null,
  MESSAGE_REACTION_REMOVE_ALL: null,
  MESSAGE_REACTION_REMOVE_EMOJI: null,
  MESSAGE_UPDATE: null,
  OAUTH2_TOKEN_REMOVE: null,
  PRESENCES_REPLACE: null,
  PRESENCE_UPDATE: null,
  RECENT_MENTION_DELETE: null,
  RELATIONSHIP_ADD: null,
  RELATIONSHIP_REMOVE: null,
  SESSIONS_REPLACE: null,
  STREAM_CREATE: null,
  STREAM_DELETE: null,
  STREAM_SERVER_UPDATE: null,
  STREAM_UPDATE: null,
  TYPING_START: null,
  USER_ACHIEVEMENT_UPDATE: null,
  USER_CONNECTIONS_UPDATE: null,
  USER_FEED_SETTINGS_UPDATE: null,
  USER_GUILD_SETTINGS_UPDATE: null,
  USER_NOTE_UPDATE: null,
  USER_PAYMENT_SOURCES_UPDATE: null,
  USER_PAYMENTS_UPDATE: null,
  USER_SETTINGS_UPDATE: null,
  USER_SUBSCRIPTIONS_UPDATE: null,
  USER_REQUIRED_ACTION_UPDATE: null,
  USER_UPDATE: null,
  VOICE_SERVER_UPDATE: null,
  VOICE_STATE_UPDATE: null,
  WEBHOOKS_UPDATE: null,
});

export enum GatewayIntents {
  GUILDS = 1 << 0,
  GUILD_MEMBERS = 1 << 1,
  GUILD_BANS = 1 << 2,
  GUILD_EMOJIS = 1 << 3,
  GUILD_INTEGRATIONS = 1 << 4,
  GUILD_WEBHOOKS = 1 << 5,
  GUILD_INVITES = 1 << 6,
  GUILD_VOICE_STATES = 1 << 7,
  GUILD_PRESENCES = 1 << 8,
  GUILD_MESSAGES = 1 << 9,
  GUILD_MESSAGE_REACTIONS = 1 << 10,
  GUILD_MESSAGE_TYPING = 1 << 11,
  DIRECT_MESSAGES = 1 << 12,
  DIRECT_MESSAGE_REACTIONS = 1 << 13,
  DIRECT_MESSAGE_TYPING = 1 << 14,
}

export enum GatewayOpCodes {
  DISPATCH = 0,
  HEARTBEAT = 1,
  IDENTIFY = 2,
  PRESENCE_UPDATE = 3,
  VOICE_STATE_UPDATE = 4,
  VOICE_SERVER_PING = 5,
  RESUME = 6,
  RECONNECT = 7,
  REQUEST_GUILD_MEMBERS = 8,
  INVALID_SESSION = 9,
  HELLO = 10,
  HEARTBEAT_ACK = 11,
  SYNC_GUILD = 12,
  CALL_CONNECT = 13,
  GUILD_SUBSCRIPTIONS = 14,
  LOBBY_CONNECT = 15,
  LOBBY_DISCONNECT = 16,
  LOBBY_VOICE_STATES_UPDATE = 17,
  STREAM_CREATE = 18,
  STREAM_DELETE = 19,
  STREAM_WATCH = 20,
  STREAM_PING = 21,
  STREAM_SET_PAUSED = 22,
}

export enum GatewayPresenceStatuses {
  ONLINE = 'online',
  DND = 'dnd',
  IDLE = 'idle',
  INVISIBLE = 'invisible',
  OFFLINE = 'offline',
}

export const MaxNumbers = Object.freeze({
  UINT8:  0xFF,
  UINT16: 0xFFFF,
  UINT32: 0xFFFFFFFF,
});

export enum MediaCodecTypes {
  AUDIO = 'audio',
  VIDEO = 'video',
}

export enum MediaCodecs {
  OPUS = 'opus',
  H264 = 'H264',
  VP8 = 'VP8',
  VP9 = 'VP9',
  RTX = 'rtx',
}

export const MEDIA_CODECS_AUDIO = [
  MediaCodecs.OPUS,
];

export const MEDIA_CODECS_VIDEO = [
  MediaCodecs.VP8,
  MediaCodecs.VP9,
  MediaCodecs.H264,
];

export enum MediaEncryptionModes {
  XSALSA20_POLY1305_LITE = 'xsalsa20_poly1305_lite',
  XSALSA20_POLY1305_SUFFIX = 'xsalsa20_poly1305_suffix',
  XSALSA20_POLY1305 = 'xsalsa20_poly1305',
}

export const MEDIA_ENCRYPTION_MODES = Object.freeze(Object.values(MediaEncryptionModes));

export enum MediaOpCodes {
  IDENTIFY = 0,
  SELECT_PROTOCOL = 1,
  READY = 2,
  HEARTBEAT = 3,
  SELECT_PROTOCOL_ACK = 4,
  SPEAKING = 5,
  HEARTBEAT_ACK = 6,
  RESUME = 7,
  HELLO = 8,
  RESUMED = 9,
  SIGNAL = 10,
  CLIENT_CONNECT = 12,
  CLIENT_DISCONNECT = 13,
  SESSION_UPDATE = 14,
  VIDEO_SINK_WANTS = 15,
}

export enum MediaProtocols {
  UDP = 'udp',
  WEBRTC = 'webrtc',
}

export const MEDIA_PROTOCOLS = Object.freeze(Object.values(MediaProtocols));

export const MediaReceivedVideoQuality = Object.freeze({
  OFF: 'off',
  FULL: 'full',
});

export const MediaSilencePacket = [0xF8, 0xFF, 0xFE];

export enum MediaSpeakingFlags {
  NONE = 0,
  VOICE = 1 << 0,
  SOUNDSHARE = 1 << 1,
  PRIORITY = 1 << 2,
}

export enum MediaSSRCTypes {
  AUDIO = 'audio',
  VIDEO = 'video',
}

export enum SocketEvents {
  CLOSE = 'close',
  KILLED = 'killed',
  LOG = 'log',
  OPEN = 'open',
  PACKET = 'packet',
  READY = 'ready',
  RECONNECTING = 'reconnecting',
  SOCKET = 'socket',
  STATE = 'state',
  TRANSPORT = 'transport',
  TRANSPORT_READY = 'transportReady',
  WARN = 'warn',
}

export enum SocketEventsBase {
  CLOSE = 'close',
  ERROR = 'error',
  MESSAGE = 'messsage',
  OPEN = 'open',
  PING = 'ping',
  PONG = 'pong',
}

export enum SocketCloseCodes {
  NORMAL = 1000,
  GOING_AWAY = 1001,
  PROTOCOL_ERROR = 1002,
  UNSUPPORTED_DATA = 1003,

  ABNORMAL_CLOSURE = 1006,
  INVALID_FRAME = 1007,
  POLICY_VIOLATION = 1008,
  MESSAGE_TOO_BIG = 1009,
  MISSING_EXTENSION = 1010,
  INTERNAL_ERROR = 1011,
  SERVICE_RESTART = 1012,
  TRY_AGAIN_LATER = 1013,
  BAD_GATEWAY = 1014,
}

export enum SocketInternalCloseCodes {
  INVALID_DATA = 4800,
  RECONNECTING = 4801,
  HEARTBEAT_ACK = 4802,
  HEARTBEAT_ACK_NONCE = 4803,
  OTHER_SOCKET_MESSAGE = 4804,
  OTHER_SOCKET_OPEN = 4805,
}

export const SocketInternalCloseReasons = Object.freeze({
  [SocketInternalCloseCodes.INVALID_DATA]: 'Invalid data received, reconnecting',
  [SocketInternalCloseCodes.RECONNECTING]: 'Reconnecting',
  [SocketInternalCloseCodes.HEARTBEAT_ACK]: 'Heartbeat ACK never arrived',
  [SocketInternalCloseCodes.HEARTBEAT_ACK_NONCE]: 'Invalid nonce received by Heartbeat ACK',
  [SocketInternalCloseCodes.OTHER_SOCKET_MESSAGE]: 'Received message from not our current socket',
  [SocketInternalCloseCodes.OTHER_SOCKET_OPEN]: 'Received open from not our current socket',
});

export enum SocketGatewayCloseCodes {
  UNKNOWN_ERROR = 4000,
  UNKNOWN_OPCODE = 4001,
  DECODE_ERROR = 4002,
  NOT_AUTHENTICATED = 4003,
  AUTHENTICATION_FAILED = 4004,
  ALREADY_AUTHENTICATED = 4005,
  INVALID_SEQUENCE = 4007,
  RATE_LIMITED = 4008,
  SESSION_TIMEOUT = 4009,
  INVALID_SHARD = 4010,
  SHARDING_REQUIRED = 4011,
  INVALID_VERSION = 4012,
  INVALID_INTENTS = 4013,
  DISALLOWED_INTENTS = 4014,
};

export enum SocketMediaCloseCodes {
  UNKNOWN_ERROR = 4000,
  UNKNOWN_OPCODE = 4001,
  DECODE_ERROR = 4002,
  NOT_AUTHENTICATED = 4003,
  AUTHENTICATION_FAILED = 4004,
  ALREADY_AUTHENTICATED = 4005,
  SESSION_NO_LONGER_VALID = 4006,
  SESSION_TIMEOUT = 4009,

  SERVER_NOT_FOUND = 4011,
  UNKNOWN_PROTOCOL = 4012,
  DISCONNECTED = 4014,
  VOICE_SERVER_CRASHED = 4015,
  UNKNOWN_ENCRYPTION_MODE = 4016,
};

export enum SocketStates {
  CLOSED = 'CLOSED',
  CONNECTING = 'CONNECTING',
  IDENTIFYING = 'IDENTIFYING',
  OPEN = 'OPEN',
  READY = 'READY',
  RESUMING = 'RESUMING',
}


export const RTP_HEADER_VERSION = 0x80;

export enum RTPPayloadTypes {
  OPUS = 0x78,
  VP8 = 0x65,
  VP9 = 0x67,
  H264 = 0x69,
}

export const RTP_PAYLOAD_TYPES = Object.freeze(Object.values(RTPPayloadTypes));

export const RTCP_HEADER_VERSION = 0x80;

export enum RTCPPacketTypes {
  SENDER_REPORT = 200,
  RECEIVER_REPORT = 201,
  SOURCE_DESCRIPTION = 202,
  BYE = 203,
  APP = 204,
  RTPFB = 205,
  PSFB = 206,
}

export const RTCP_PACKET_TYPES = Object.freeze(Object.values(RTCPPacketTypes));

export const RTPHeaderExtensionOneByte = Object.freeze({
  HEADER: [0xBE, 0xDE],
  LOCAL_IDENTIFER: 0xF,
});

export const RTPHeaderExtensionTwoByte = Object.freeze({
  HEADER: [0x10, 0x00],
});

export const ZLIB_SUFFIX = [0x0, 0x0, 0xff, 0xff];
