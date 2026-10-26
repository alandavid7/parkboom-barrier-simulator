// The pretend barrier: what the real firmware must do, written in TypeScript as the reference.
// The firmware (C or Rust) is a port of this file plus the state table, and must pass the same tests.
//
// Order of checks for a phone command (cheapest and safest first):
//   powered → version → signed time (optional) → revocation list (optional) → credential signature
//   → credential for this barrier → clock trusted → credential in date → device not revoked
//   → challenge known and unused → command signature → role allowed → state machine.

import spec from '../../spec/barrier-states.json' with { type: 'json' };
import { MemorySigner, signPayload, verifyPayload, type Signed, type Signer } from '../protocol/crypto.js';
import { randomId } from '../protocol/encoding.js';
import type {
  Action, BarrierEvent, Challenge, Decision, DecisionCode, PhoneRequest, RemoteCommand, RevocationList, Role, SignedTime,
} from '../protocol/messages.js';
import { BarrierStateMachine, type Spec, type StepResult } from './stateMachine.js';

export const TRAVEL_MS = 2500;
export const NOBODY_TIMEOUT_MS = 5 * 60 * 1000;
export const CHALLENGE_TTL_MS = 30 * 1000;
export const MAX_REMOTE_TTL_S = 30;

const ROLE_ACTIONS: Record<Role, Action[]> = {
  driver: ['lower', 'raise'],
  guest: [],
  temp_admin: ['lower', 'raise', 'maint_on', 'maint_off', 'clear_fault'],
  admin: ['lower', 'raise', 'maint_on', 'maint_off', 'clear_fault'],
};
const ACTION_EVENT: Record<Action, string> = {
  lower: 'CMD_LOWER', raise: 'CMD_RAISE', maint_on: 'MAINT_ON', maint_off: 'MAINT_OFF', clear_fault: 'CLEAR_FAULT',
};

export interface BarrierOptions { barrierId: string; trustAnchor: string; signer?: Signer; spec?: Spec }

export class Barrier {
  readonly id: string;
  readonly sm: BarrierStateMachine;
  readonly events: Signed<BarrierEvent>[] = [];

  powered = true;
  /** Monotonic local milliseconds; never goes backwards. */
  private localMs = 0;
  /** Trusted wall-clock seconds at the moment localMs was `anchorMs`; null while untrusted. */
  private trusted: { t: number; anchorMs: number } | null = null;
  /** Highest trusted time ever seen. Survives power loss; time can never be set below it. */
  private highWater = 0;
  private revocation = { epoch: 0, devices: new Set<string>() };
  private challenges = new Map<string, number>();
  private seenRemote = new Map<string, number>();
  private seq = 0;
  private motion: { remainingMs: number } | null = null;
  private nobodyTimer: { remainingMs: number } | null = null;
  private signing: Promise<unknown> = Promise.resolve();

  private constructor(private readonly trustAnchor: string, private readonly signer: Signer, s: Spec, id: string) {
    this.id = id;
    this.sm = new BarrierStateMachine(s);
  }

  static async create(o: BarrierOptions): Promise<Barrier> {
    return new Barrier(o.trustAnchor, o.signer ?? (await MemorySigner.generate(o.barrierId)), o.spec ?? (spec as Spec), o.barrierId);
  }

  publicKey(): Promise<string> { return this.signer.publicKey(); }
  get state(): string { return this.sm.state; }
  get clockTrusted(): boolean { return this.trusted !== null; }
  get moving(): boolean { return this.motion !== null; }
  /** 0 = flat, 1 = fully up. For the demo drawing only. */
  height = 1;

  trustedNow(): number | null {
    if (!this.trusted) return null;
    return this.trusted.t + Math.floor((this.localMs - this.trusted.anchorMs) / 1000);
  }

  // ---------- Bluetooth ----------

  issueChallenge(): Challenge {
    if (!this.powered) throw new Error('Barrier has no power');
    const nonce = randomId();
    this.challenges.set(nonce, this.localMs + CHALLENGE_TTL_MS);
    return { v: 1, type: 'challenge', barrierId: this.id, nonce };
  }

  async handlePhone(req: PhoneRequest): Promise<Decision> {
    if (!this.powered) return this.refuse('barrier_off', 'The barrier has no power');
    const { command, credential } = req;
    if (command.payload.v !== 1 || credential.payload.v !== 1) return this.refuse('bad_version', 'Unsupported message version');

    if (req.time) await this.acceptSignedTime(req.time);
    if (req.revocation) await this.acceptRevocation(req.revocation);

    const cred = credential.payload;
    if (!(await verifyPayload(this.trustAnchor, credential))) return this.refuse('bad_credential_signature', 'Credential not signed by this organisation');
    if (!cred.accessPoints.includes(this.id)) return this.refuse('credential_not_for_this_barrier', 'This pass is not for this bay');
    const now = this.trustedNow();
    if (now === null) return this.refuse('clock_untrusted', 'Barrier clock not trusted yet; waiting for signed time');
    if (now < cred.notBefore) return this.refuse('credential_not_yet_valid', 'Pass not valid yet');
    if (now > cred.notAfter) return this.refuse('credential_expired', 'Pass expired; the phone must refresh it online');
    if (this.revocation.devices.has(cred.deviceId)) return this.refuse('device_revoked', 'This phone’s access has been removed');

    const nonce = command.payload.nonce;
    const expires = this.challenges.get(nonce);
    if (expires === undefined || expires < this.localMs || command.payload.barrierId !== this.id) {
      return this.refuse('unknown_or_used_challenge', 'Old or unknown challenge (possible replay)');
    }
    this.challenges.delete(nonce); // single use, whatever happens next
    if (command.payload.deviceId !== cred.deviceId) return this.refuse('device_mismatch', 'Command and pass are from different phones');
    if (!(await verifyPayload(cred.devicePub, command))) return this.refuse('bad_command_signature', 'Command not signed by the phone named in the pass');
    if (!ROLE_ACTIONS[cred.role].includes(command.payload.action)) return this.refuse('role_not_allowed', `A ${cred.role} can't ${command.payload.action}`);

    return this.apply(ACTION_EVENT[command.payload.action], 'phone', `${cred.personId} via phone`);
  }

  // ---------- Gateway ----------

  async handleRemote(signed: Signed<RemoteCommand>): Promise<Decision> {
    if (!this.powered) return this.refuse('barrier_off', 'The barrier has no power');
    const c = signed.payload;
    if (c.v !== 1) return this.refuse('bad_version', 'Unsupported message version');
    if (!(await verifyPayload(this.trustAnchor, signed)) || c.barrierId !== this.id) return this.refuse('bad_remote_signature', 'Remote command not signed by the cloud for this barrier');
    if (c.action !== 'lower') return this.refuse('remote_raise_refused', 'Remote raise is not allowed in the pilot');
    const now = this.trustedNow();
    if (now === null) return this.refuse('clock_untrusted', 'Barrier clock not trusted yet');
    if (c.expiresAt - c.issuedAt > MAX_REMOTE_TTL_S || now > c.expiresAt || now < c.issuedAt - 5) return this.refuse('remote_expired', 'Remote command too old; nothing is ever queued');
    if (this.seenRemote.has(c.commandId)) return this.refuse('remote_replayed', 'Remote command already used');
    this.seenRemote.set(c.commandId, c.expiresAt);
    return this.apply('CMD_LOWER', 'gateway', `remote by ${c.requestedBy}`);
  }

  async acceptSignedTime(signed: Signed<SignedTime>): Promise<boolean> {
    const p = signed.payload;
    if (p.barrierId !== this.id || !(await verifyPayload(this.trustAnchor, signed))) return false;
    const exp = this.challenges.get(p.nonce);
    if (exp === undefined || exp < this.localMs) return false; // must answer a live challenge: proves it is fresh
    if (p.t < this.highWater) return false; // time only moves forward
    this.trusted = { t: p.t, anchorMs: this.localMs };
    this.highWater = p.t;
    return true;
  }

  async acceptRevocation(signed: Signed<RevocationList>): Promise<boolean> {
    if (signed.payload.epoch <= this.revocation.epoch) return false;
    if (!(await verifyPayload(this.trustAnchor, signed))) return false;
    this.revocation = { epoch: signed.payload.epoch, devices: new Set(signed.payload.revokedDeviceIds) };
    this.log('revocation', `Revocation list ${signed.payload.epoch} installed`);
    return true;
  }

  // ---------- Physical world ----------

  /** Sensor or physical events: CAR_ARRIVES, CAR_LEAVES, OBSTRUCTION, MOTOR_STALL, SENSOR_FAULT, FORCED_DOWN. */
  physical(event: string): StepResult | null {
    if (!this.powered) return null;
    const r = this.sm.step({ event, source: event === 'FORCED_DOWN' ? 'system' : 'sensor' });
    if (event === 'FORCED_DOWN' && r.accepted) this.height = 0;
    this.after(r, 'sensor');
    return r;
  }

  powerLoss(): void {
    if (!this.powered) return;
    if (this.motion) this.after(this.sm.step({ event: 'POWER_DIP', source: 'system' }), 'power');
    this.log('power', 'Power lost; post holds its position');
    this.powered = false;
    this.motion = null;
    this.nobodyTimer = null;
    this.trusted = null; // refuse time-limited passes until fresh signed time arrives
    this.challenges.clear();
  }

  powerRestore(): void {
    if (this.powered) return;
    this.powered = true;
    this.log('power', 'Power restored; waiting for signed time');
  }

  /** Advance local time. Drives motion and the nobody-arrived timer. */
  tick(ms: number): void {
    if (!this.powered) return;
    let left = ms;
    while (left > 0) {
      const stepMs = Math.min(left, 100);
      left -= stepMs;
      this.localMs += stepMs;
      if (this.motion) {
        const dir = this.sm.position === 'moving_up' ? 1 : -1;
        this.height = Math.min(1, Math.max(0, this.height + (dir * stepMs) / TRAVEL_MS));
        this.motion.remainingMs -= stepMs;
        if (this.motion.remainingMs <= 0) {
          this.motion = null;
          this.height = dir > 0 ? 1 : 0;
          this.after(this.sm.step({ event: 'MOTION_DONE', source: 'system' }), 'motion');
        }
      }
      if (this.nobodyTimer) {
        this.nobodyTimer.remainingMs -= stepMs;
        if (this.nobodyTimer.remainingMs <= 0) {
          this.nobodyTimer = null;
          this.after(this.sm.step({ event: 'NOBODY_TIMEOUT', source: 'system' }), 'timer');
        }
      }
    }
    for (const [n, exp] of this.challenges) if (exp < this.localMs) this.challenges.delete(n);
  }

  // ---------- internals ----------

  private apply(event: string, source: 'phone' | 'gateway', who: string): Decision {
    const r = this.sm.step({ event, source });
    this.after(r, who);
    if (!r.accepted) return { ok: false, code: 'state_refused', message: r.reason ?? 'Refused', from: r.from, to: r.to };
    return { ok: true, code: 'ok', message: `${r.from} → ${r.to}`, from: r.from, to: r.to };
  }

  private after(r: StepResult, who: string): void {
    for (const a of r.actions) {
      if (a === 'motorDown' || a === 'motorUp' || a === 'motorReverseDown') {
        const toGo = a === 'motorUp' ? 1 - this.height : this.height;
        this.motion = { remainingMs: Math.max(100, Math.round(toGo * TRAVEL_MS)) };
      }
      if (a === 'motorStop') this.motion = null;
      if (a === 'startNobodyTimer') this.nobodyTimer = { remainingMs: NOBODY_TIMEOUT_MS };
      if (a === 'cancelNobodyTimer') this.nobodyTimer = null;
    }
    const kind = r.accepted ? 'transition' : 'rejected';
    const detail = r.accepted
      ? `${r.event} (${who}): ${r.from} → ${r.to}${r.actions.length ? ` [${r.actions.join(', ')}]` : ''}`
      : `${r.event} (${who}) rejected: ${r.reason}`;
    this.log(kind, detail);
  }

  private refuse(code: DecisionCode, message: string): Decision {
    this.log('refused', `${code}: ${message}`);
    return { ok: false, code, message };
  }

  private log(kind: string, detail: string): void {
    const payload: BarrierEvent = { v: 1, type: 'barrier_event', barrierId: this.id, seq: ++this.seq, kind, detail, state: this.sm.state, at: this.trustedNow() };
    this.signing = this.signing.then(async () => { this.events.push(await signPayload(this.signer, payload)); });
  }

  /** Wait until every event has been signed. */
  flush(): Promise<unknown> { return this.signing; }
}
