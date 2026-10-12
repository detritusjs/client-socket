import { EventSpewer } from 'detritus-utils';

import {
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

  recoverFromInvalidTransition(transitionId: number): void {
    if (this.reinitializing) {
      return;
    }
    this.reinitializing = true;
    this.consecutiveFailures = 0;
    this.emit('invalidateTransition', transitionId);
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

  encrypt(packet: Buffer): Buffer {
    if (this.protocolVersion === 0 || !this.ready || packet.equals(SilencePacket)) {
      return packet;
    }
    return this.session.encryptOpus(packet);
  }

  /**
   * Returns null if the packet couldn't be decrypted
   */
  decrypt(packet: Buffer, userId: string): Buffer | null {
    if (packet.equals(SilencePacket) || !this.session) {
      return packet;
    }
    const canDecrypt = this.ready && (this.protocolVersion !== 0 || this.session.canPassthrough(userId));
    if (!canDecrypt) {
      return packet;
    }
    try {
      const data: Buffer = this.session.decrypt(userId, Davey.MediaType.AUDIO, packet);
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
