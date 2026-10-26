// A small simulated car park: one cloud, one gateway, one barrier (B12) and two phones.
// Used by the scenario tests and the demo page. This file is simulator-only and is not reused in production.

import { Barrier } from '../barrier/barrier.js';
import { Cloud } from '../cloud/cloud.js';
import type { Signed } from '../protocol/crypto.js';
import type { Action, Decision, RemoteCommand, Role } from '../protocol/messages.js';
import { Phone } from '../phone/phone.js';

export const START_TIME = 1792999800; // Mon 26 Oct 2026, around 08:50 UTC

export interface Person { name: string; role: Role; phone: Phone }

export class World {
  wallMs = START_TIME * 1000;
  gatewayOnline = true;
  phoneOnline = true;
  readonly people: Record<string, Person> = {};

  private constructor(readonly cloud: Cloud, readonly barrier: Barrier) {}

  get now(): number { return Math.floor(this.wallMs / 1000); }

  static async create(): Promise<World> {
    const clock = { now: () => Math.floor(w.wallMs / 1000) };
    const cloud = await Cloud.create(clock);
    const barrier = await Barrier.create({ barrierId: 'B12', trustAnchor: await cloud.trustAnchor() });
    cloud.registerBarrier('B12', await barrier.publicKey());
    const w: World = new World(cloud, barrier);
    await w.addPerson('priya', 'Priya Shah', 'driver');
    await w.addPerson('alan', 'Alan', 'admin');
    await w.gatewayTimeSync();
    return w;
  }

  async addPerson(key: string, name: string, role: Role): Promise<Person> {
    const phone = await Phone.create(`dev-${key}`);
    phone.credential = await this.cloud.issueCredential({
      deviceId: phone.deviceId, devicePub: await phone.publicKey(), personId: name, role, accessPoints: ['B12'],
    });
    const p = { name, role, phone };
    this.people[key] = p;
    return p;
  }

  /** Advance simulated time for everything. */
  advance(ms: number): void {
    this.wallMs += ms;
    this.barrier.tick(ms);
  }

  /** Full Bluetooth exchange: challenge, optional fresh time and revocation list, signed command. */
  async phoneAction(personKey: string, action: Action): Promise<Decision> {
    const person = this.people[personKey];
    if (!person) throw new Error(`No person ${personKey}`);
    if (!this.barrier.powered) return { ok: false, code: 'barrier_off', message: 'The barrier has no power' };
    const challenge = this.barrier.issueChallenge();
    let time;
    if (this.phoneOnline) {
      time = await this.cloud.signedTime(this.barrier.id, challenge.nonce);
      person.phone.learnRevocation(this.cloud.revocationList());
    }
    const req = await person.phone.request(challenge, action, time);
    return this.barrier.handlePhone(req);
  }

  /** Remote lower or raise from the admin screen. Dropped if the gateway is offline: never queued. */
  async remote(action: 'lower' | 'raise', by = 'Alan', deliverAfterMs = 0): Promise<Decision> {
    const cmd = await this.cloud.remoteCommand(this.barrier.id, action, by);
    if (deliverAfterMs > 0) this.advance(deliverAfterMs);
    return this.deliverRemote(cmd);
  }

  async deliverRemote(cmd: Signed<RemoteCommand>): Promise<Decision> {
    if (!this.gatewayOnline) return { ok: false, code: 'state_refused', message: 'Gateway offline: command dropped, not queued' };
    return this.barrier.handleRemote(cmd);
  }

  /** The gateway asks the barrier for a challenge and answers it with signed time from the cloud. */
  async gatewayTimeSync(): Promise<boolean> {
    if (!this.gatewayOnline || !this.barrier.powered) return false;
    const ch = this.barrier.issueChallenge();
    return this.barrier.acceptSignedTime(await this.cloud.signedTime(this.barrier.id, ch.nonce));
  }

  async revoke(personKey: string): Promise<void> {
    const person = this.people[personKey]!;
    const list = await this.cloud.revoke(person.phone.deviceId);
    if (this.gatewayOnline && this.barrier.powered) await this.barrier.acceptRevocation(list);
  }

  async refreshCredential(personKey: string): Promise<boolean> {
    const p = this.people[personKey]!;
    if (!this.phoneOnline) return false;
    try {
      p.phone.credential = await this.cloud.issueCredential({
        deviceId: p.phone.deviceId, devicePub: await p.phone.publicKey(), personId: p.name, role: p.role, accessPoints: ['B12'],
      });
      return true;
    } catch { return false; }
  }

  /** Relay signed barrier events to the cloud (through the gateway). Duplicates are dropped by the cloud. */
  async syncEvents(): Promise<number> {
    await this.barrier.flush();
    if (!this.gatewayOnline) return 0;
    let stored = 0;
    for (const e of this.barrier.events) if ((await this.cloud.ingestEvent(e)) === 'stored') stored++;
    return stored;
  }
}
