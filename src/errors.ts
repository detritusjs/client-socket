import {
  RTPHeader,
} from './mediapackets/rtp';

class BaseError extends Error {

}

export class DroppedPacketError extends BaseError {
  packet: any;

  constructor(
    packet: any,
    message?: string,
  ) {
    let errorMessage = 'Packet dropped';
    if (message) {
      errorMessage += `, reason: (${message})`;
    }

    super(errorMessage);
    this.packet = packet;
  }
}

export class SocketKillError extends BaseError {
  code: number;
  reason: null | string;

  constructor(code: number, reason?: null | string) {
    let message: string;
    if (reason) {
      message = `Socket closed with ${code} (${reason}), killing.`;
    } else {
      message = `Socket closed with ${code}, killing.`;
    }
    super(message);
    this.code = code;
    this.reason = reason || null;
  }
}

export class MediaPacketError extends BaseError {
  from: {
    address: string,
    port: number,
  };
  packet: Buffer;

  constructor(
    message: string,
    from: {
      address: string,
      port: number,
    },
    packet: Buffer,
  ) {
    super(message);
    this.from = from;
    this.packet = packet;
  }
}

export class MediaRTPError extends MediaPacketError {
  rtp: {
    header: RTPHeader,
    nonce?: Buffer,
    payload?: Buffer,
  };

  constructor(
    message: string,
    from: {
      address: string,
      port: number,
    },
    packet: Buffer,
    rtp: {
      header: RTPHeader,
      nonce?: Buffer,
      payload?: Buffer,
    },
  ) {
    super(message, from, packet);
    this.rtp = rtp;
  }
}

export class InflateError extends BaseError {
  code: number | string;

  constructor(
    message: string,
    code: number | string,
  ) {
    super(message);
    this.code = code;
  }
}
