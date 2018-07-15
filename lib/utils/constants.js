const Constants = require('detritus-utils').Constants;

module.exports = Object.assign({
	VERSION: '0.1.8',
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
		ZLIB_SUFFIX: [0x0, 0x0, 0xff, 0xff]
	},
	Voice: {
		Codecs: {
			AUDIO: ['opus'],
			VIDEO: ['VP8', 'VP9', 'H264'],
			VALID: ['opus', 'VP8', 'VP9', 'H264', 'rtx']
		},
		MODES: ['xsalsa20_poly1305_lite', 'xsalsa20_poly1305_suffix', 'xsalsa20_poly1305'],
		Packet: {
			RTPHeader: {
				VERSION: 0x80,
				PayloadTypes: {
					OPUS: 0x78,
					VP8: 0x65,
					VP9: 0x67,
					H264: 0x69
				}
			},
			RTCPHeader: {
				VERSION: 0x80,
				PacketTypes: {
					SENDER_REPORT: 200,
					RECEIVER_REPORT: 201,
					SOURCE_DESCRIPTION: 202,
					BYE: 203,
					APP: 204,
					RTPFB: 205,
					PSFB: 206
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
		}
	}
}, Constants);