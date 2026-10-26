// Tests for the credential, challenge, time and remote-command protocol, end to end,
// with real P-256 signatures (WebCrypto).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Barrier } from '../src/barrier/barrier.js';
import { Cloud } from '../src/cloud/cloud.js';
import { MemorySigner, signPayload } from '../src/protocol/crypto.js';
import { canonicalJson } from '../src/protocol/encoding.js';
import type { PhoneCommand } from '../src/protocol/messages.js';
import { Phone } from '../src/phone/phone.js';
import { World } from '../src/sim/world.js';

async function lowered(w: World) {
  await w.phoneAction('priya', 'lower');
  w.advance(3000);
}

describe('phone commands', () => {
  it('a valid phone lowers the barrier', async () => {
    const w = await World.create();
    const d = await w.phoneAction('priya', 'lower');
    expect(d).toMatchObject({ ok: true, from: 'UP', to: 'LOWERING' });
    w.advance(3000);
    expect(w.barrier.state).toBe('DOWN_EMPTY');
  });

  it('a recorded command replayed later is refused (challenge is single use)', async () => {
    const w = await World.create();
    const ch = w.barrier.issueChallenge();
    const req = await w.people.priya!.phone.request(ch, 'lower');
    expect((await w.barrier.handlePhone(req)).ok).toBe(true);
    w.advance(3000);
    await w.phoneAction('priya', 'raise'); w.advance(3000);
    const again = await w.barrier.handlePhone(req);
    expect(again).toMatchObject({ ok: false, code: 'unknown_or_used_challenge' });
  });

  it('an expired challenge is refused', async () => {
    const w = await World.create();
    const ch = w.barrier.issueChallenge();
    w.advance(31_000);
    const d = await w.barrier.handlePhone(await w.people.priya!.phone.request(ch, 'lower'));
    expect(d.code).toBe('unknown_or_used_challenge');
  });

  it('a pass older than 72 hours is refused offline, and works again after a refresh online', async () => {
    const w = await World.create();
    w.advance(73 * 3600 * 1000);
    await w.gatewayTimeSync();
    w.phoneOnline = false;
    expect((await w.phoneAction('priya', 'lower')).code).toBe('credential_expired');
    w.phoneOnline = true;
    expect(await w.refreshCredential('priya')).toBe(true);
    expect((await w.phoneAction('priya', 'lower')).ok).toBe(true);
  });

  it('a pass for another bay is refused', async () => {
    const w = await World.create();
    const p = w.people.priya!;
    p.phone.credential = await w.cloud.issueCredential({ deviceId: p.phone.deviceId, devicePub: await p.phone.publicKey(), personId: 'Priya Shah', role: 'driver', accessPoints: ['B11'] });
    expect((await w.phoneAction('priya', 'lower')).code).toBe('credential_not_for_this_barrier');
  });

  it('a pass signed by another organisation is refused', async () => {
    const w = await World.create();
    const otherOrg = await Cloud.create({ now: () => w.now });
    const p = w.people.priya!;
    p.phone.credential = await otherOrg.issueCredential({ deviceId: p.phone.deviceId, devicePub: await p.phone.publicKey(), personId: 'Priya Shah', role: 'driver', accessPoints: ['B12'] });
    expect((await w.phoneAction('priya', 'lower')).code).toBe('bad_credential_signature');
  });

  it('a stolen pass used from a different phone is refused', async () => {
    const w = await World.create();
    const thief = await Phone.create('dev-priya'); // same claimed device id, different key
    thief.credential = w.people.priya!.phone.credential;
    const ch = w.barrier.issueChallenge();
    const d = await w.barrier.handlePhone(await thief.request(ch, 'lower'));
    expect(d.code).toBe('bad_command_signature');
  });

  it('a tampered command (action changed after signing) is refused', async () => {
    const w = await World.create();
    await lowered(w);
    const ch = w.barrier.issueChallenge();
    const req = await w.people.priya!.phone.request(ch, 'lower');
    req.command.payload.action = 'raise';
    expect((await w.barrier.handlePhone(req)).code).toBe('bad_command_signature');
  });

  it('a revoked phone is refused, even if the barrier only hears about it from another phone', async () => {
    const w = await World.create();
    w.gatewayOnline = false; // the gateway can't push the list
    await w.revoke('priya');
    w.phoneOnline = false;
    // Priya's phone is offline and doesn't know. Alan's phone connects first and carries the list.
    const alan = w.people.alan!;
    alan.phone.learnRevocation(w.cloud.revocationList());
    expect((await w.phoneAction('alan', 'lower')).ok).toBe(true);
    w.advance(3000);
    expect((await w.phoneAction('priya', 'raise')).code).toBe('device_revoked');
  });

  it('a driver cannot switch on maintenance; an admin can', async () => {
    const w = await World.create();
    expect((await w.phoneAction('priya', 'maint_on')).code).toBe('role_not_allowed');
    expect((await w.phoneAction('alan', 'maint_on')).ok).toBe(true);
  });
});

describe('trusted time', () => {
  it('after a power cut the barrier refuses passes until it gets fresh signed time', async () => {
    const w = await World.create();
    w.barrier.powerLoss();
    w.advance(60_000);
    w.barrier.powerRestore();
    w.phoneOnline = false; w.gatewayOnline = false;
    expect((await w.phoneAction('priya', 'lower')).code).toBe('clock_untrusted');
    w.phoneOnline = true; // the phone fetches signed time bound to this barrier's challenge
    expect((await w.phoneAction('priya', 'lower')).ok).toBe(true);
  });

  it('an old signed-time message cannot be replayed to wind the clock back', async () => {
    const w = await World.create();
    const ch = w.barrier.issueChallenge();
    const old = await w.cloud.signedTime('B12', ch.nonce);
    w.advance(10_000);
    expect(await w.barrier.acceptSignedTime(old)).toBe(true); // still answers a live challenge
    w.barrier.powerLoss(); w.barrier.powerRestore();
    expect(await w.barrier.acceptSignedTime(old)).toBe(false); // challenge gone after power loss
  });

  it('time never moves backwards, even with a fresh challenge', async () => {
    const w = await World.create();
    const ch1 = w.barrier.issueChallenge();
    const early = await w.cloud.signedTime('B12', ch1.nonce);
    w.wallMs += 3600_000;
    await w.gatewayTimeSync();
    expect(await w.barrier.acceptSignedTime(early)).toBe(false);
  });
});

describe('remote commands through the gateway', () => {
  it('a cloud-signed remote lower works', async () => {
    const w = await World.create();
    expect((await w.remote('lower')).ok).toBe(true);
  });

  it('a remote raise is refused by the barrier even though the cloud signed it', async () => {
    const w = await World.create();
    await w.remote('lower'); w.advance(3000);
    expect((await w.remote('raise')).code).toBe('remote_raise_refused');
    expect(w.barrier.state).toBe('DOWN_EMPTY');
  });

  it('a remote command delivered late (gateway was offline) is dropped, never run later', async () => {
    const w = await World.create();
    expect((await w.remote('lower', 'Alan', 45_000)).code).toBe('remote_expired');
    expect(w.barrier.state).toBe('UP');
  });

  it('the same remote command delivered twice runs once', async () => {
    const w = await World.create();
    const cmd = await w.cloud.remoteCommand('B12', 'lower', 'Alan');
    expect((await w.deliverRemote(cmd)).ok).toBe(true);
    w.advance(3000);
    expect((await w.deliverRemote(cmd)).code).toBe('remote_replayed');
  });

  it('a gateway cannot forge a command without the cloud key', async () => {
    const w = await World.create();
    const gatewayKey = await MemorySigner.generate('rogue-gateway');
    const forged = await signPayload(gatewayKey, { v: 1 as const, type: 'remote_command' as const, commandId: 'x', barrierId: 'B12', action: 'lower' as const, issuedAt: w.now, expiresAt: w.now + 30, requestedBy: 'rogue' });
    expect((await w.barrier.handleRemote(forged)).code).toBe('bad_remote_signature');
  });
});

describe('signed barrier events', () => {
  it('the cloud keeps one copy of each event, however many times it is relayed', async () => {
    const w = await World.create();
    await lowered(w);
    const first = await w.syncEvents();
    const second = await w.syncEvents();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    const seqs = w.cloud.events('B12').map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('a forged event is rejected', async () => {
    const w = await World.create();
    await lowered(w); await w.barrier.flush();
    const e = structuredClone(w.barrier.events[0]!);
    e.payload.detail = 'nothing happened';
    expect(await w.cloud.ingestEvent(e)).toBe('forged');
  });
});

describe('protocol property: only valid, fresh, correctly signed commands move the post', () => {
  it('random mixes of valid and attacking requests', async () => {
    const attack = fc.constantFrom('valid', 'replay', 'tamper', 'wrong_device_key', 'stale_challenge', 'remote_raise', 'remote_replay', 'remote_late');
    await fc.assert(fc.asyncProperty(fc.array(attack, { minLength: 1, maxLength: 12 }), async (plan) => {
      const w = await World.create();
      const priya = w.people.priya!;
      const thief = await Phone.create('dev-priya');
      thief.credential = priya.phone.credential;
      let lastReq: Awaited<ReturnType<Phone['request']>> | undefined;
      let lastRemote: Awaited<ReturnType<Cloud['remoteCommand']>> | undefined;
      for (const step of plan) {
        const stateBefore = w.barrier.state;
        let d;
        const action = stateBefore === 'UP' ? 'lower' : 'raise';
        if (step === 'valid') {
          const ch = w.barrier.issueChallenge();
          lastReq = await priya.phone.request(ch, action);
          d = await w.barrier.handlePhone(lastReq);
        } else if (step === 'replay') {
          if (!lastReq) continue;
          d = await w.barrier.handlePhone(lastReq);
        } else if (step === 'tamper') {
          const ch = w.barrier.issueChallenge();
          const req = await priya.phone.request(ch, 'lower');
          (req.command.payload as PhoneCommand).action = action === 'lower' ? 'raise' : 'lower';
          d = await w.barrier.handlePhone(req);
        } else if (step === 'wrong_device_key') {
          d = await w.barrier.handlePhone(await thief.request(w.barrier.issueChallenge(), action));
        } else if (step === 'stale_challenge') {
          const ch = w.barrier.issueChallenge();
          w.advance(31_000);
          d = await w.barrier.handlePhone(await priya.phone.request(ch, action));
        } else if (step === 'remote_raise') {
          d = await w.remote('raise');
        } else if (step === 'remote_replay') {
          if (!lastRemote) {
            // First time: a genuine remote lower, delivered once. Later steps replay this same message.
            lastRemote = await w.cloud.remoteCommand('B12', 'lower', 'Alan');
            await w.deliverRemote(lastRemote);
            w.advance(3000);
            continue;
          }
          d = await w.deliverRemote(lastRemote);
        } else {
          d = await w.remote('lower', 'Alan', 45_000);
        }
        const valid = step === 'valid';
        // Anything other than a valid request must leave the state unchanged.
        if (!valid && d.ok) return false;
        if (!valid && w.barrier.state !== stateBefore) return false;
        w.advance(3000); // let any movement finish
      }
      return true;
    }), { numRuns: 60 });
  }, 120_000);
});

it('canonical JSON is stable regardless of key order', () => {
  expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

it('the barrier rejects a phone command when it has no power', async () => {
  const cloud = await Cloud.create({ now: () => 1_793_000_000 });
  const b = await Barrier.create({ barrierId: 'B12', trustAnchor: await cloud.trustAnchor() });
  b.powerLoss();
  expect(() => b.issueChallenge()).toThrow();
});
