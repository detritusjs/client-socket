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
  // a commit for a group we aren't in yet (or one without queued proposals)
  ignored: boolean,
  // the gateway expects a transition ready, never for transition id 0
  sendReady: boolean,
  success: boolean,
  transitionId: number,
}

/**
 * End-to-End Encryption via Discord's Audio & Video End-to-End Encryption (DAVE) protocol
 * Wraps `@snazzah/davey`'s DAVESession (bindings for libdave)
 *
 * The phase is spread over a few fields:
 * - plaintext: `protocolVersion` 0, incoming frames with a DAVE footer are dropped unless passthrough decrypts them
 * - `awaitingKeys`: e2ee without a key yet (until the welcome/commit's transition executes), outgoing frames are dropped
 * - e2ee: `canEncrypt` with `protocolVersion` > 0. A `reinit` keeps the old keys until the next transition, like libdave
 * - `pendingTransition`: between a prepare (or commit/welcome) and its execute, which switches our encryption key.
 *   A pending downgrade turns on passthrough until the execute
 * - `reinitializing`: recovering from an invalid commit/welcome or too many decrypt failures, until the next transition
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

  /**
   * We've been in a group and have decryption keys, stays true through a `reinit`
   */
  get ready(): boolean {
    return !!this.session && this.session.ready;
  }

  /**
   * We have a key to encrypt with, set once a welcome/commit's transition executes
   */
  get canEncrypt(): boolean {
    return !!this.session && this.session.canEncrypt;
  }

  /**
   * The call is e2ee but we have no key yet, so nothing goes out
   */
  get awaitingKeys(): boolean {
    return this.protocolVersion !== 0 && !this.canEncrypt;
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
        if (this.downgraded) {
          // upgrading from plaintext, others keep sending it until the upgrade's transition executes
          this.session.setPassthroughMode(true);
        }
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
   * From the gateway's prepare transition, returns true if we need to send a transition ready
   */
  prepareTransition(transitionId: number, protocolVersion: number): boolean {
    try {
      return this.prepareSessionTransition(transitionId, protocolVersion);
    } catch(error) {
      this.emit('warn', error);
      this.recoverFromInvalidTransition(transitionId);
      return false;
    }
  }

  /**
   * davey holds the transition until its execute, which switches the encryption key (transition id 0 right away)
   */
  protected prepareSessionTransition(transitionId: number, protocolVersion: number): boolean {
    this.pendingTransition = {protocolVersion, transitionId};
    if (this.session) {
      this.session.prepareTransition(transitionId, protocolVersion);
    }
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
    // davey already executed transition id 0 in its prepare, and tracks its own prepared transitions
    if (this.session && transitionId !== 0) {
      try {
        this.session.executeTransition(transitionId);
      } catch(error) {
        this.emit('warn', error);
      }
    }
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
          // back to e2ee, plaintext from others is only accepted for a bit longer
          this.session.setPassthroughMode(false, MediaDaveTransition.EXPIRY);
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
   * Runs even mid reinit, otherwise a bad welcome after a reinit leaves us stuck
   */
  recoverFromInvalidTransition(transitionId: number): void {
    this.reinitializing = true;
    this.consecutiveFailures = 0;
    this.invalidTransitions++;
    this.emit('invalidateTransition', transitionId);
    if (MediaDaveTransition.MAX_INVALID_TRANSITIONS <= this.invalidTransitions) {
      // reinitializing again won't help, the owner reconnects instead
      this.emit('invalidTransitionsExceeded', this.invalidTransitions);
      return;
    }
    this.reinit();
  }

  /**
   * Returns the commit (with the welcome appended, if any) to send back
   */
  processProposals(payload: Buffer, connectedUserIds: Iterable<string>): Buffer | null {
    if (!this.session) {
      throw new Error('No DAVE session to process proposals on');
    }
    const operationType = payload.readUInt8(0);
    const { commit, welcome } = this.session.processProposals(
      operationType,
      payload.subarray(1),
      this.recognizedUserIds(connectedUserIds),
    );
    if (!commit) {
      return null;
    }
    return (welcome) ? Buffer.concat([commit, welcome]) : commit;
  }

  processCommit(payload: Buffer): DaveTransitionResult {
    return this.processTransition(payload, (data) => this.session.processCommit(data));
  }

  /**
   * Members of the welcomed group that aren't connected (or us) get the welcome rejected
   */
  processWelcome(payload: Buffer, connectedUserIds: Iterable<string>): DaveTransitionResult {
    return this.processTransition(payload, (data) => {
      this.session.processWelcome(data, this.recognizedUserIds(connectedUserIds));
      return true;
    });
  }

  /**
   * `process` returns false if the commit/welcome was ignored
   */
  protected processTransition(payload: Buffer, process: (data: Buffer) => boolean): DaveTransitionResult {
    const transitionId = payload.readUInt16BE(0);
    if (!this.session) {
      throw new Error('No DAVE session to process the transition on');
    }
    try {
      if (!process(payload.subarray(2))) {
        return {ignored: true, sendReady: false, success: true, transitionId};
      }
      const sendReady = this.prepareSessionTransition(transitionId, this.protocolVersion);
      return {ignored: false, sendReady, success: true, transitionId};
    } catch(error) {
      this.emit('warn', error);
      this.recoverFromInvalidTransition(transitionId);
      return {ignored: false, sendReady: false, success: false, transitionId};
    }
  }

  /**
   * Everyone connected to the call, including us, since we're in the group too
   */
  protected recognizedUserIds(connectedUserIds: Iterable<string>): Array<string> {
    const userIds = new Set(connectedUserIds);
    userIds.add(this.userId);
    return Array.from(userIds);
  }

  /**
   * Returns null if the packet must not be sent, the call is e2ee and we have no keys yet
   */
  encrypt(packet: Buffer): Buffer | null {
    if (this.protocolVersion === 0) {
      return packet;
    }
    // silence frames too, like libdave
    if (!this.canEncrypt) {
      return null;
    }
    // davey returns silence frames as is, receivers accept them either way (https://daveprotocol.com/#silence-packets)
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
   * DAVE leaves the codec's nal headers and frame tags unencrypted for the sfu and decoders
   * Returns null if the frame must not be sent, like `encrypt()`
   */
  encryptVideo(frame: Buffer, codec: MediaCodecs | string): Buffer | null {
    if (this.protocolVersion === 0) {
      return frame;
    }
    if (!this.canEncrypt) {
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
   * Takes a whole reassembled frame, returns null if it couldn't be decrypted
   */
  decryptVideo(frame: Buffer, userId: string): Buffer | null {
    const canDecrypt = this.ready && (this.protocolVersion !== 0 || this.session.canPassthrough(userId));
    if (!canDecrypt) {
      return (isDaveFrame(frame)) ? null : frame;
    }
    try {
      return this.session.decrypt(userId, DaveMediaTypes.VIDEO, frame);
    } catch(error) {
      // unlike audio, these don't count towards recovering, a codec quirk shouldn't tear down the group
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
  on(event: 'invalidTransitionsExceeded', listener: (invalidTransitions: number) => any): this;
  on(event: 'keyPackage', listener: (keyPackage: Buffer) => any): this;
  on(event: 'warn', listener: (error: Error) => any): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
