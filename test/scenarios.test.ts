// Whole-system scenarios from the PRD failure table (section 7), run on the simulated car park.

import { describe, expect, it } from 'vitest';
import { NOBODY_TIMEOUT_MS } from '../src/barrier/barrier.js';
import { World } from '../src/sim/world.js';

describe('PRD failure scenarios', () => {
  it('F-06 / F-21: power cut mid-lower stops the post where it is; nothing moves when power returns', async () => {
    const w = await World.create();
    await w.phoneAction('priya', 'lower');
    w.advance(1000);
    const heightAtCut = w.barrier.height;
    w.barrier.powerLoss();
    expect(w.barrier.state).toBe('STOPPED');
    w.advance(60_000);
    w.barrier.powerRestore();
    w.advance(10_000);
    expect(w.barrier.state).toBe('STOPPED');
    expect(w.barrier.height).toBeCloseTo(heightAtCut, 5);
    // From Stopped only a lower is allowed: the safe direction.
    expect((await w.phoneAction('priya', 'raise')).ok).toBe(false);
    expect((await w.phoneAction('priya', 'lower')).ok).toBe(true);
  });

  it('F-07: something in the bay while rising stops and lowers the post', async () => {
    const w = await World.create();
    await w.phoneAction('priya', 'lower'); w.advance(3000);
    await w.phoneAction('priya', 'raise'); w.advance(1000);
    w.barrier.physical('OBSTRUCTION');
    expect(w.barrier.state).toBe('LOWERING');
    w.advance(3000);
    expect(w.barrier.state).toBe('DOWN_EMPTY');
    expect(w.barrier.height).toBe(0);
  });

  it('F-08: a car over the post blocks the raise', async () => {
    const w = await World.create();
    await w.phoneAction('priya', 'lower'); w.advance(3000);
    w.barrier.physical('CAR_ARRIVES');
    const d = await w.phoneAction('priya', 'raise');
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/car over the post|not reading empty/i);
    expect(w.barrier.state).toBe('DOWN_OCCUPIED');
  });

  it('F-09: a faulty sensor keeps the post down until cleared on site', async () => {
    const w = await World.create();
    await w.phoneAction('priya', 'lower'); w.advance(3000);
    w.barrier.physical('SENSOR_FAULT');
    expect(w.barrier.state).toBe('FAULT');
    expect((await w.phoneAction('priya', 'raise')).ok).toBe(false);
    expect((await w.remote('lower')).ok).toBe(false);
  });

  it('F-14: a removed driver is locked out within one gateway push', async () => {
    const w = await World.create();
    await w.revoke('priya');
    w.phoneOnline = false;
    expect((await w.phoneAction('priya', 'lower')).code).toBe('device_revoked');
  });

  it('F-24: a remote lower that arrives late is dropped', async () => {
    const w = await World.create();
    expect((await w.remote('lower', 'Alan', 60_000)).code).toBe('remote_expired');
  });

  it('F-25: a post forced down without a command is logged as tamper', async () => {
    const w = await World.create();
    w.barrier.physical('FORCED_DOWN');
    await w.barrier.flush();
    expect(w.barrier.state).toBe('DOWN_OCCUPIED');
    expect(w.barrier.events.some((e) => e.payload.detail.includes('emitTamper'))).toBe(true);
  });

  it('F-26: lowered and nobody parks: reminder after 5 minutes, and the post stays down', async () => {
    const w = await World.create();
    await w.phoneAction('priya', 'lower'); w.advance(3000);
    w.advance(NOBODY_TIMEOUT_MS);
    expect(w.barrier.state).toBe('DOWN_NOBODY');
    expect(w.barrier.height).toBe(0);
    expect((await w.phoneAction('priya', 'raise')).ok).toBe(true);
  });

  it('F-03: no mobile signal: lowering works over Bluetooth with the stored pass', async () => {
    const w = await World.create();
    w.phoneOnline = false; w.gatewayOnline = false;
    expect((await w.phoneAction('priya', 'lower')).ok).toBe(true);
  });

  it('gateway offline: remote commands are dropped, not queued', async () => {
    const w = await World.create();
    w.gatewayOnline = false;
    expect((await w.remote('lower')).ok).toBe(false);
    w.gatewayOnline = true;
    w.advance(5000);
    expect(w.barrier.state).toBe('UP');
  });
});
