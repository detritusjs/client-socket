module.exports = {
	VERSION: '0.0.6',
	ApiVersions: {
		GATEWAY: 6,
		VOICE_GATEWAY: 4
	},
	SocketStates: {
		CLOSED: 0,
		CONNECTING: 1,
		CONNECTED: 2
	},
	MaxNumbers: {
		UINT8:  0xFF,
		UINT16: 0xFFFF,
		UINT32: 0xFFFFFFFF,
	},
	Gateway: {
		ActivityTypes: {
			PLAYING: 0,
			STREAMING: 1,
			LISTENING: 2,
			WATCHING: 3
		},
		ENCODING: ['etf', 'json'],
		Status: {
			ONLINE: 'online',
			DND: 'dnd',
			IDLE: 'idle',
			INVISIBLE: 'invisible',
			OFFLINE: 'offline'
		},
		ZLIB_SUFFIX: [0x0, 0x0, 0xff, 0xff]
	},
	Opus: {
		VOIP: 2048,
		AUDIO: 2049,
		RESTRICTED_LOWDELAY: 2051
	},
	Voice: {
		Codecs: {
			AUDIO: ['opus'],
			VIDEO: []
		},
		MODES: ['xsalsa20_poly1305_lite', 'xsalsa20_poly1305_suffix', 'xsalsa20_poly1305'],
		Packet: {
			RTPHeader: {
				VERSION: 0x80,
				PayloadTypes: {
					OPUS: 0x78,
					VP8: 0x65,
					VP9: 0x67
				}
			},
			RTPHeaderExtension: {
				OneByte: {
					HEADER: [0xBE, 0xDE],
					LOCAL_IDENTIFER: 0xF
				},
				TwoByte: {
					HEADER: [0x10, 0x00]
				}
			},
			SILENCE: [0xF8, 0xFF, 0xFE]
		},
		Speaking: {
			NONE: 0,
			VOICE: 1 << 0,
			SOUNDSHARE: 1 << 1
		}
	},
	OpCodes: {
		Gateway: {
			DISPATCH:              0,
			HEARTBEAT:             1,
			IDENTIFY:              2,
			STATUS_UPDATE:         3,
			VOICE_STATE_UPDATE:    4,
			VOICE_SERVER_PING:     5,
			RESUME:                6,
			RECONNECT:             7,
			REQUEST_GUILD_MEMBERS: 8,
			INVALID_SESSION:       9,
			HELLO:                 10,
			HEARTBEAT_ACK:         11,
			SYNC_GUILD:            12,
			CALL_CONNECT:          13,
			GUILD_SUBSCRIPTION:    14
		},
		Voice: {
			IDENTIFY:            0,
			SELECT_PROTOCOL:     1,
			READY:               2,
			HEARTBEAT:           3,
			SESSION_DESCRIPTION: 4,
			SPEAKING:            5,
			HEARTBEAT_ACK:       6,
			RESUME:              7,
			HELLO:               8,
			RESUMED:             9,
			SIGNAL:              10,
			CLIENT_CONNECT:      12,
			CLIENT_DISCONNECT:   13,
			CODECS:              14
		}
	}
};