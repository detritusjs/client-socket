const ApiVersion = 6;

module.exports = {
	VERSION: '0.0.1',
	ApiVersions: {
		GATEWAY: 6,
		VOICE_GATEWAY: 4
	},
	SocketStates: {
		CLOSED: 0,
		CONNECTING: 1,
		CONNECTED: 2
	},
	MAX: {
		UINT8:  0xFF,
		UINT16: 0xFFFF,
		UINT32: 0xFFFFFFFF,
	},
	Gateway: {
		Encoding: ['etf', 'json'],
		MAX_HEARTBEAT_THRESHOLD: 3 * 60 * 1000,
		READY_TIMEOUT: 1 * 60 * 1000,
		STATUS: {
			ONLINE: 'online',
			DND: 'dnd',
			IDLE: 'idle',
			INVISIBLE: 'invisible',
			OFFLINE: 'offline'
		},
		ZLIB_SUFFIX: Buffer.from([0x0, 0x0, 0xff, 0xff])
	},
	Voice: {
		MODES: ['xsalsa20_poly1305_lite', 'xsalsa20_poly1305_suffix', 'xsalsa20_poly1305'],
		PACKET: {
			HEADER: {
				TYPE: 0x80,
				VERSION: 0x70
			},
			SILENCE: [0xF8, 0xFF, 0xFE],
			RTP: {
				LOCAL_IDENTIFER: 0b1111,
				HEADERS: {
					ONE_BYTE: [0xBE, 0xDE]
				}
			},
			RTCP: {
				UNIXTIME_OFFSET_70_YEARS_OR_SO: 2208988800000,
				is: (type) => (type >= 0xC0 && type <= 0xC3) || (type >= 0xC8 && type <= 0xD1),
				OFFSET: {
					MSW_TIMESTAMP: 8,
					LSW_TIMESTAMP: 12,
					RTP_TIMESTAMP: 16,
					PACKETS_SENT: 20,
					BYTES_SENT: 24
				},
				TYPE: {
					SENDER_REPORT: 0xC8,
					RECEIVER_REPORT: 0xC9,
					SOURCE_DESCRIPTION: 0xCA
				},
				RTP: {
					VERSION_TWO: 0x80,
					VERSION_TWO_SOURCE_ONE: 0x81
				}
			}
		},
		SPEAKING: {
			NONE:       0,
			VOICE:      1 << 0,
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
			SYNC_GUILD:            12
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
			CLIENT_CONNECT:      12,
			CLIENT_DISCONNECT:   13
		}
	}
};