// The pretend phone. In the real app, the message building here moves into React Native as-is,
// and the Signer becomes a native Swift module over a Secure Enclave key.

import { MemorySigner, signPayload, type Signed, type Signer } from '../protocol/crypto.js';
import type { Action, Challenge, DeviceCredential, PhoneRequest, RevocationList, SignedTime } from '../protocol/messages.js';

export class Phone {
  credential: Signed<DeviceCredential> | undefined;
  revocation: Signed<RevocationList> | undefined;

  private constructor(readonly deviceId: string, readonly signer: Signer) {}

  static async create(deviceId: string): Promise<Phone> {
    return new Phone(deviceId, await MemorySigner.generate(deviceId));
  }

  publicKey(): Promise<string> { return this.signer.publicKey(); }

  /** Keep the newest revocation list seen, so it can be carried to barriers. */
  learnRevocation(list: Signed<RevocationList> | undefined): void {
    if (list && (!this.revocation || list.payload.epoch > this.revocation.payload.epoch)) this.revocation = list;
  }

  /** Answer one barrier challenge with a signed command. */
  async request(challenge: Challenge, action: Action, time?: Signed<SignedTime>): Promise<PhoneRequest> {
    if (!this.credential) throw new Error('Phone has no credential');
    const command = await signPayload(this.signer, {
      v: 1 as const, type: 'phone_command' as const,
      barrierId: challenge.barrierId, action, nonce: challenge.nonce, deviceId: this.deviceId,
    });
    return { command, credential: this.credential, ...(this.revocation ? { revocation: this.revocation } : {}), ...(time ? { time } : {}) };
  }
}
