import { EventSpewer } from 'detritus-utils';

import {
  DaveCodecs,
  DaveMediaTypes,
  MediaCodecs,
  MediaDaveTransition,
  MediaSilencePacket,
  DAVE_MODULE,
} from './constants';


let Davey: any = null;
try {
  Davey = require(DAVE_MODULE);
} catch(error) {

}

const SilencePacket = Buffer.from(MediaSilencePacket);

// e2ee frames end with: supplemental data (tag, nonce, unencrypted ranges) | uint8 supplemental size | uint16 0xFAFA
const DAVE_MAGIC_MARKER = 0xFAFA;
// the smallest supplemental size libdave accepts: 8 byte tag + the size byte + the marker
const DAVE_SUPPLEMENTAL_MIN_SIZE = 11;

/**
 * If the frame carries a DAVE footer, it's e2ee ciphertext and must never be used as is
 */
function isDaveFrame(frame: Buffer): boolean {
  if (frame.length < DAVE_SUPPLEMENTAL_MIN_SIZE || frame.readUInt16BE(frame.length - 2) !== DAVE_MAGIC_MARKER) {
    return false;
  }
  const supplementalSize = frame[frame.length - 3];
  return DAVE_SUPPLEMENTAL_MIN_SIZE <= supplementalSize && supplementalSize <= frame.length;
}


export interface DaveTransitionResult {
  success: boolean,
  transitionId: number,
}

/**
 * End-to-End Encryption via Discord's Audio & Video End-to-End Encryption (DAVE) protocol
 * Wraps `@snazzah/davey`'s DAVESession (bindings for libdave)
 */
export class DaveSession extends EventSpewer {
  channelId: string;
  consecutiveFailures: number = 0;
  downgraded: boolean = false;
  // invalid commits/welcomes in a row, reset by any transition that goes through
  invalidTransitions: number = 0;
  lastTransitionId: null | number = null;
  pendingTransition: null | {protocolVersion: number, transitionId: number} = null;
  protocolVersion: number;
  reinitializing: boolean = false;
  session: any = null;
  userId: string;

  constructor(
    protocolVersion: number,
    userId: string,
    channelId: string,
  ) {
    super();
    if (!Davey) {
      throw new Error(`For media (video/voice) end-to-end encryption, please install ${DAVE_MODULE}`);
    }
    this.protocolVersion = protocolVersion;
    this.userId = userId;
    this.channelId = channelId;
  }

  static get available(): boolean {
    return !!Davey;
  }

  static get maxProtocolVersion(): number {
    return (Davey) ? Davey.DAVE_PROTOCOL_VERSION : 0;
  }

  get ready(): boolean {
    return !!this.session && this.session.ready;
  }

  get voicePrivacyCode(): null | string {
    if (this.protocolVersion !== 0 && this.ready) {
      return this.session.voicePrivacyCode || null;
    }
    return null;
  }

  setChannelId(channelId: string): void {
    this.channelId = channelId;
  }

  reinit(): void {
    if (this.protocolVersion > 0) {
      if (this.session) {
        this.session.reinit(this.protocolVersion, this.userId, this.channelId);
      } else {
        this.session = new Davey.DAVESession(this.protocolVersion, this.userId, this.channelId);
      }
      this.emit('keyPackage', this.session.getSerializedKeyPackage() as Buffer);
    } else if (this.session) {
      this.session.reset();
      this.session.setPassthroughMode(true, MediaDaveTransition.EXPIRY);
    }
  }

  setExternalSender(externalSender: Buffer): void {
    if (!this.session) {
      throw new Error('No DAVE session to set the external sender on');
    }
    this.session.setExternalSender(externalSender);
  }

  /**
   * Returns true if we need to send a transition ready
   */
  prepareTransition(transitionId: number, protocolVersion: number): boolean {
    this.pendingTransition = {protocolVersion, transitionId};
    // transition id 0 is a (re)initialization and can be executed immediately
    if (transitionId === 0) {
      this.executeTransition(transitionId);
      return false;
    }
    if (protocolVersion === 0 && this.session) {
      this.session.setPassthroughMode(true, MediaDaveTransition.EXPIRY_PENDING_DOWNGRADE);
    }
    return true;
  }

  executeTransition(transitionId: number): boolean {
    if (!this.pendingTransition) {
      return false;
    }
    let transitioned = false;
    if (transitionId === this.pendingTransition.transitionId) {
      const oldVersion = this.protocolVersion;
      this.protocolVersion = this.pendingTransition.protocolVersion;
      if (oldVersion !== this.protocolVersion && this.protocolVersion === 0) {
        this.downgraded = true;
      } else if (transitionId > 0 && this.downgraded) {
        this.downgraded = false;
        if (this.session) {
          this.session.setPassthroughMode(true, MediaDaveTransition.EXPIRY);
        }
      }
      transitioned = true;
      this.invalidTransitions = 0;
      this.reinitializing = false;
      this.lastTransitionId = transitionId;
    }
    this.pendingTransition = null;
    return transitioned;
  }

  prepareEpoch(epoch: number, protocolVersion: number): void {
    // epoch 1 means a new mls group is being created
    if (epoch === 1) {
      this.protocolVersion = protocolVersion;
      this.reinit();
    }
  }

  /**
   * Every invalid commit/welcome gets reported and a new key package sent, even mid reinit, otherwise a bad welcome
   * after a reinit leaves us stuck. Decryption failures only call this when not already reinitializing
   */
  recoverFromInvalidTransition(transitionId: number): void {
    this.reinitializing = true;
    this.consecutiveFailures = 0;
    this.invalidTransitions++;
    this.emit('invalidateTransition', transitionId);
    if (MediaDaveTransition.MAX_INVALID_TRANSITIONS <= this.invalidTransitions) {
      // reinitializing again won't help, the owner reconnects with a fresh session instead
      this.emit('invalidTransitionsExceeded', this.invalidTransitions);
      return;
    }
    this.reinit();
  }

  /**
   * Returns the commit (with the welcome appended, if any) to send back, if any
   */
  processProposals(payload: Buffer, connectedUserIds: Iterable<string>): Buffer | null {
    if (!this.session) {
      throw new Error('No DAVE session to process proposals on');
    }
    const operationType = payload.readUInt8(0);
    const { commit, welcome } = this.session.processProposals(
      operationType,
      payload.subarray(1),
      Array.from(connectedUserIds),
    );
    if (!commit) {
      return null;
    }
    return (welcome) ? Buffer.concat([commit, welcome]) : commit;
  }

  processCommit(payload: Buffer): DaveTransitionResult {
    return this.processTransition(payload, (data) => this.session.processCommit(data));
  }

  processWelcome(payload: Buffer): DaveTransitionResult {
    return this.processTransition(payload, (data) => this.session.processWelcome(data));
  }

  protected processTransition(payload: Buffer, process: (data: Buffer) => void): DaveTransitionResult {
    const transitionId = payload.readUInt16BE(0);
    if (!this.session) {
      throw new Error('No DAVE session to process the transition on');
    }
    try {
      process(payload.subarray(2));
      if (transitionId === 0) {
        this.invalidTransitions = 0;
        this.reinitializing = false;
        this.lastTransitionId = transitionId;
      } else {
        this.pendingTransition = {protocolVersion: this.protocolVersion, transitionId};
      }
      return {success: true, transitionId};
    } catch(error) {
      this.emit('warn', error);
      this.recoverFromInvalidTransition(transitionId);
      return {success: false, transitionId};
    }
  }

  /**
   * Returns null if the packet must not be sent, the call is e2ee and we have no keys yet (before the welcome/commit)
   */
  encrypt(packet: Buffer): Buffer | null {
    // silence frames are never e2ee, libdave passes them through as well
    if (this.protocolVersion === 0 || packet.equals(SilencePacket)) {
      return packet;
    }
    if (!this.ready) {
      return null;
    }
    return this.session.encryptOpus(packet);
  }

  /**
   * Returns null if the packet couldn't be decrypted
   */
  decrypt(packet: Buffer, userId: string): Buffer | null {
    if (packet.equals(SilencePacket)) {
      return packet;
    }
    const canDecrypt = this.ready && (this.protocolVersion !== 0 || this.session.canPassthrough(userId));
    if (!canDecrypt) {
      // ciphertext from someone already in the e2ee group, before we were welcomed into it
      return (isDaveFrame(packet)) ? null : packet;
    }
    try {
      const data: Buffer = this.session.decrypt(userId, DaveMediaTypes.AUDIO, packet);
      this.consecutiveFailures = 0;
      return data;
    } catch(error) {
      if (!this.reinitializing && !this.pendingTransition) {
        this.consecutiveFailures++;
        if (MediaDaveTransition.FAILURE_TOLERANCE < this.consecutiveFailures) {
          if (this.lastTransitionId !== null) {
            this.recoverFromInvalidTransition(this.lastTransitionId);
          } else {
            this.emit('warn', error);
          }
        }
      }
    }
    return null;
  }

  /**
   * Video is encrypted per frame, before it's split into rtp packets (h264 as annex b)
   * The codec matters, DAVE leaves the parts of a frame the sfu and decoders need to read (nal headers, frame tags) as is
   * Returns null if the frame must not be sent, like `encrypt()`
   */
  encryptVideo(frame: Buffer, codec: MediaCodecs | string): Buffer | null {
    if (this.protocolVersion === 0) {
      return frame;
    }
    if (!this.ready) {
      return null;
    }
    let daveCodec = DaveCodecs.UNKNOWN;
    switch (codec) {
      case MediaCodecs.H264: daveCodec = DaveCodecs.H264; break;
      case MediaCodecs.VP8: daveCodec = DaveCodecs.VP8; break;
      case MediaCodecs.VP9: daveCodec = DaveCodecs.VP9; break;
    }
    return this.session.encrypt(DaveMediaTypes.VIDEO, daveCodec, frame);
  }

  /**
   * Video is encrypted per frame (before it's split into rtp packets), so this takes a whole reassembled frame
   * Returns null if the frame couldn't be decrypted
   */
  decryptVideo(frame: Buffer, userId: string): Buffer | null {
    const canDecrypt = this.ready && (this.protocolVersion !== 0 || this.session.canPassthrough(userId));
    if (!canDecrypt) {
      return (isDaveFrame(frame)) ? null : frame;
    }
    try {
      return this.session.decrypt(userId, DaveMediaTypes.VIDEO, frame);
    } catch(error) {
      // unlike audio, these don't count towards recovering the session, we only see video from users we asked for
      // and a codec quirk shouldn't be able to make us tear down the group
      return null;
    }
  }

  destroy(): void {
    if (this.session) {
      try {
        this.session.reset();
      } catch(error) {

      }
      this.session = null;
    }
    this.removeAllListeners();
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: 'invalidateTransition', listener: (transitionId: number) => any): this;
  on(event: 'keyPackage', listener: (keyPackage: Buffer) => any): this;
  on(event: 'warn', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
