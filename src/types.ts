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
    d: any,
    op: number,
  }

  export interface ClientConnect {
    audio_ssrc: number,
    user_id: string,
    video_ssrc?: number,
  }

  export interface ClientDisconnect {
    user_id: string,
  }

  export interface Hello {
    heartbeat_interval: number,
    v: number,
  }

  export type HeartbeatAck = number;

  export interface Ready {
    experiments: Array<string>,
    ip: string,
    port: number,
    modes: Array<string>,
    ssrc: number,
  }

  export interface Resumed {

  }

  export interface SelectProtocolAckUDP {
    audio_codec: string,
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

  export interface VideoSinkWants {
    any: number,
  }
}
