export namespace GatewayPackets {
  export interface Packet {
    d: any,
    op: number,
    s: number,
    t: string,
  }

  export interface Hello {
    _trace: Array<string>,
    heartbeat_interval: number,
  }

  export type Heartbeat = null;

  export type HeartbeatAck = null;

  export type InvalidSession = boolean;

  export type Reconnect = null;

  export namespace DispatchEvents {
    export interface GuildDelete {
      id: string,
      unavailable: boolean,
    }

    export interface VoiceServerUpdate {
      channel_id: string,
      endpoint: string,
      guild_id?: string,
      token: string,
    }

    export interface VoiceStateUpdate {
      channel_id: string,
      guild_id?: string,
      session_id: string,
      user_id: string,
    }
  }
}

export namespace MediaGatewayPackets {
  export interface Packet {
    binary?: boolean,
    d: any,
    op: number,
    seq?: number,
  }

  export interface ClientsConnect {
    user_ids: Array<string>,
  }

  export interface ClientConnect {
    audio_ssrc: number,
    streams?: Array<Stream>,
    user_id: string,
    video_ssrc?: number,
  }

  // one simulcast layer of a user's video, `quality` is 0-100 (100 being the full resolution layer)
  export interface Stream {
    active?: boolean,
    max_bitrate?: number,
    max_framerate?: number,
    max_resolution?: {
      height: number,
      type: string,
      width: number,
    },
    quality?: number,
    rid?: string,
    rtx_ssrc?: number,
    ssrc?: number,
    type: string, // MediaStreamTypes
  }

  export interface ClientDisconnect {
    user_id: string,
  }

  export interface Hello {
    heartbeat_interval: number,
    v: number,
  }

  export interface HeartbeatAck {
    t: number,
  }

  export interface Ready {
    experiments: Array<string>,
    ip: string,
    port: number,
    modes: Array<string>,
    ssrc: number,
    streams?: Array<Stream>,
  }

  export interface Resumed {

  }

  export interface SelectProtocolAckUDP {
    audio_codec: string,
    dave_protocol_version?: number,
    mode: string,
    media_session_id: string,
    secret_key: Array<number>,
    video_codec: string,
  }

  export interface SelectProtocolAckWebRTC {
    audio_codec: string,
    media_session_id: string,
    sdp: string,
    video_codec: string,
  }

  export interface SessionUpdate {
    audio_codec?: string,
    media_session_id: string,
    video_codec?: string,
    video_quality_changes?: Array<{
      quality: string, // MediaReceivedVideoQuality
      ssrc: number,
      user_id: string,
    }>,
  }

  export interface Speaking {
    speaking: number,
    ssrc: number,
    user_id: string,
  }

  // `any` applies to every ssrc not listed, values are 0-100 (0 asks the server to stop forwarding that ssrc)
  export interface MediaSinkWants {
    any?: number,
    [ssrc: string]: number | undefined,
  }

  export interface DavePrepareTransition {
    protocol_version: number,
    transition_id: number,
  }

  export interface DaveExecuteTransition {
    transition_id: number,
  }

  export interface DavePrepareEpoch {
    epoch: number,
    protocol_version: number,
  }
}
