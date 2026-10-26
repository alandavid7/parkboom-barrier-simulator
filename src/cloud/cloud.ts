// The pretend cloud: issues device credentials, signed time, revocation lists and remote commands,
// and ingests signed barrier events. In production this logic becomes a module of the NestJS API,
// with the organisation Signer backed by AWS KMS.

import { MemorySigner, signPayload, verifyPayload, type Signed, type Signer } from '../protocol/crypto.js';
import { randomId } from '../protocol/encoding.js';
import type { BarrierEvent, DeviceCredential, RemoteCommand, RevocationList, Role, SignedTime } from '../protocol/messages.js';

export const CREDENTIAL_TTL_S = 72 * 3600;
export const REMOTE_TTL_S = 30;

export interface Clock { now(): number }

export class Cloud {
  private epoch = 1;
  private revoked = new Set<string>();
  private latestList: Signed<RevocationList> | undefined;
  private barrierKeys = new Map<string, string>();
  private seenEvents = new Map<string, Signed<BarrierEvent>>();

  private constructor(readonly orgSigner: Signer, private readonly clock: Clock) {}

  static async create(clock: Clock, orgSigner?: Signer): Promise<Cloud> {
    return new Cloud(orgSigner ?? (await MemorySigner.generate('org-aztec-1')), clock);
  }

  /** The public key installed on every barrier of this organisation when it is claimed. */
  trustAnchor(): Promise<string> { return this.orgSigner.publicKey(); }

  registerBarrier(barrierId: string, barrierPub: string): void { this.barrierKeys.set(barrierId, barrierPub); }

  async issueCredential(args: {
    deviceId: string; devicePub: string; personId: string; role: Role; accessPoints: string[]; ttlS?: number;
  }): Promise<Signed<DeviceCredential>> {
    if (this.revoked.has(args.deviceId)) throw new Error('Device is revoked');
    const now = this.clock.now();
    return signPayload<DeviceCredential>(this.orgSigner, {
      v: 1, type: 'device_credential',
      deviceId: args.deviceId, devicePub: args.devicePub, personId: args.personId, role: args.role,
      accessPoints: [...args.accessPoints].sort(),
      notBefore: now, notAfter: now + (args.ttlS ?? CREDENTIAL_TTL_S), epoch: this.epoch,
    });
  }

  /** Signed time bound to a barrier's challenge nonce, which proves it is fresh. */
  signedTime(barrierId: string, nonce: string): Promise<Signed<SignedTime>> {
    return signPayload<SignedTime>(this.orgSigner, { v: 1, type: 'signed_time', t: this.clock.now(), barrierId, nonce });
  }

  async revoke(deviceId: string): Promise<Signed<RevocationList>> {
    this.revoked.add(deviceId);
    this.epoch += 1;
    this.latestList = await signPayload<RevocationList>(this.orgSigner, {
      v: 1, type: 'revocation_list', epoch: this.epoch, issuedAt: this.clock.now(), revokedDeviceIds: [...this.revoked].sort(),
    });
    return this.latestList;
  }

  revocationList(): Signed<RevocationList> | undefined { return this.latestList; }

  remoteCommand(barrierId: string, action: 'lower' | 'raise', requestedBy: string): Promise<Signed<RemoteCommand>> {
    // The API refuses remote raise before it reaches a barrier (PRD v0.2). The barrier refuses it too.
    const now = this.clock.now();
    return signPayload<RemoteCommand>(this.orgSigner, {
      v: 1, type: 'remote_command', commandId: randomId(), barrierId, action, issuedAt: now, expiresAt: now + REMOTE_TTL_S, requestedBy,
    });
  }

  /** Keeps the first copy of each (barrier, seq). Returns false for duplicates and forgeries. */
  async ingestEvent(e: Signed<BarrierEvent>): Promise<'stored' | 'duplicate' | 'forged' | 'unknown_barrier'> {
    const pub = this.barrierKeys.get(e.payload.barrierId);
    if (!pub) return 'unknown_barrier';
    if (!(await verifyPayload(pub, e))) return 'forged';
    const key = `${e.payload.barrierId}#${e.payload.seq}`;
    if (this.seenEvents.has(key)) return 'duplicate';
    this.seenEvents.set(key, e);
    return 'stored';
  }

  events(barrierId: string): BarrierEvent[] {
    return [...this.seenEvents.values()].map((s) => s.payload).filter((p) => p.barrierId === barrierId).sort((a, b) => a.seq - b.seq);
  }
}
