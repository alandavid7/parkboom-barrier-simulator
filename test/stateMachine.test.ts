// Tests for the state table alone: structure, worked examples and safety properties
// checked against thousands of random event sequences.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import specJson from '../spec/barrier-states.json' with { type: 'json' };
import { BarrierStateMachine, validateSpec, type Input, type Source, type Spec } from '../src/barrier/stateMachine.js';

const spec = specJson as Spec;
const EVENTS = Object.keys(spec.events);
const SOURCES: Source[] = ['phone', 'gateway', 'sensor', 'system'];
const inputArb = fc.record({ event: fc.constantFrom(...EVENTS), source: fc.constantFrom(...SOURCES) });
const RUNS = 3000;

describe('state table', () => {
  it('is valid: every state, event, guard and action is defined and implemented', () => {
    expect(() => validateSpec(spec)).not.toThrow();
  });

  it('every state is reachable from the initial state', () => {
    const seen = new Set([spec.initial]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of spec.transitions) {
        if ((t.from === '*' || seen.has(t.from)) && !seen.has(t.to)) { seen.add(t.to); grew = true; }
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(spec.states).sort());
  });

  it('every state has a way back to Up and locked', () => {
    const canReachUp = new Set(['UP']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of spec.transitions) {
        const froms = t.from === '*' ? Object.keys(spec.states) : [t.from];
        for (const f of froms) if (canReachUp.has(t.to) && !canReachUp.has(f)) { canReachUp.add(f); grew = true; }
      }
    }
    expect([...canReachUp].sort()).toEqual(Object.keys(spec.states).sort());
  });
});

describe('worked examples', () => {
  it('lower, park, leave, raise on site', () => {
    const m = new BarrierStateMachine(spec);
    const seq: Input[] = [
      { event: 'CMD_LOWER', source: 'phone' }, { event: 'MOTION_DONE', source: 'system' },
      { event: 'CAR_ARRIVES', source: 'sensor' }, { event: 'CAR_LEAVES', source: 'sensor' },
      { event: 'CMD_RAISE', source: 'phone' }, { event: 'MOTION_DONE', source: 'system' },
    ];
    const states = seq.map((i) => m.step(i).to);
    expect(states).toEqual(['LOWERING', 'DOWN_EMPTY', 'DOWN_OCCUPIED', 'DOWN_EMPTY', 'RAISING', 'UP']);
  });

  it('refuses to raise with a car over the post', () => {
    const m = new BarrierStateMachine(spec);
    m.step({ event: 'CMD_LOWER', source: 'phone' }); m.step({ event: 'MOTION_DONE', source: 'system' });
    m.step({ event: 'CAR_ARRIVES', source: 'sensor' });
    const r = m.step({ event: 'CMD_RAISE', source: 'phone' });
    expect(r.accepted).toBe(false);
    expect(m.state).toBe('DOWN_OCCUPIED');
  });

  it('refuses a raise from the gateway even when the bay is empty', () => {
    const m = new BarrierStateMachine(spec);
    m.step({ event: 'CMD_LOWER', source: 'gateway' }); m.step({ event: 'MOTION_DONE', source: 'system' });
    const r = m.step({ event: 'CMD_RAISE', source: 'gateway' });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/phone on site/);
  });

  it('reverses and lowers when something is detected during a raise', () => {
    const m = new BarrierStateMachine(spec);
    for (const i of [{ event: 'CMD_LOWER', source: 'phone' }, { event: 'MOTION_DONE', source: 'system' }, { event: 'CMD_RAISE', source: 'phone' }] as Input[]) m.step(i);
    const r = m.step({ event: 'OBSTRUCTION', source: 'sensor' });
    expect(r.to).toBe('LOWERING');
    expect(r.actions).toContain('motorReverseDown');
  });

  it('treats a faulty sensor as occupied: no raise until the fault is cleared', () => {
    const m = new BarrierStateMachine(spec);
    m.step({ event: 'CMD_LOWER', source: 'phone' }); m.step({ event: 'MOTION_DONE', source: 'system' });
    m.step({ event: 'SENSOR_FAULT', source: 'sensor' });
    expect(m.state).toBe('FAULT');
    expect(m.step({ event: 'CMD_RAISE', source: 'phone' }).accepted).toBe(false);
  });

  it('flags nobody arriving after a lower, and still will not raise on its own', () => {
    const m = new BarrierStateMachine(spec);
    m.step({ event: 'CMD_LOWER', source: 'phone' });
    expect(m.step({ event: 'MOTION_DONE', source: 'system' }).actions).toContain('startNobodyTimer');
    const r = m.step({ event: 'NOBODY_TIMEOUT', source: 'system' });
    expect(r.to).toBe('DOWN_NOBODY');
    expect(r.actions).toEqual(['emitReminder']);
  });
});

describe('safety properties (random sequences)', () => {
  it('P1: the post never starts rising unless the bay reads empty and the sensor is healthy', () => {
    fc.assert(fc.property(fc.array(inputArb, { maxLength: 60 }), (inputs) => {
      const m = new BarrierStateMachine(spec);
      for (const i of inputs) {
        const r = m.step(i);
        if (r.accepted && r.to === 'RAISING' && r.from !== 'RAISING') {
          if (!(m.ctx.sensorHealthy && !m.ctx.occupied)) return false;
        }
      }
      return true;
    }), { numRuns: RUNS });
  });

  it('P2: a raise only ever starts from a phone on site, never from the gateway or the system', () => {
    fc.assert(fc.property(fc.array(inputArb, { maxLength: 60 }), (inputs) => {
      const m = new BarrierStateMachine(spec);
      return inputs.every((i) => {
        const r = m.step(i);
        return !(r.accepted && r.actions.includes('motorUp')) || i.source === 'phone';
      });
    }), { numRuns: RUNS });
  });

  it('P3: if anything is detected while rising, the next state is lowering (or a safe stop)', () => {
    fc.assert(fc.property(fc.array(inputArb, { maxLength: 60 }), (inputs) => {
      const m = new BarrierStateMachine(spec);
      for (const i of inputs) {
        const before = m.state;
        const r = m.step(i);
        if (before === 'RAISING' && ['OBSTRUCTION', 'CAR_ARRIVES', 'SENSOR_FAULT'].includes(i.event)) {
          if (r.to !== 'LOWERING') return false;
        }
      }
      return true;
    }), { numRuns: RUNS });
  });

  it('P4: a rejected input never changes the state', () => {
    fc.assert(fc.property(fc.array(inputArb, { maxLength: 60 }), (inputs) => {
      const m = new BarrierStateMachine(spec);
      return inputs.every((i) => {
        const before = m.state;
        const r = m.step(i);
        return r.accepted || m.state === before;
      });
    }), { numRuns: RUNS });
  });

  it('P5: in Fault, Jammed or Maintenance, no input starts the motor except an on-site action that leaves that state', () => {
    fc.assert(fc.property(fc.array(inputArb, { maxLength: 60 }), (inputs) => {
      const m = new BarrierStateMachine(spec);
      return inputs.every((i) => {
        const before = m.state;
        const r = m.step(i);
        const locked = ['FAULT', 'JAMMED', 'MAINTENANCE'].includes(before);
        return !(locked && r.actions.some((a) => a === 'motorUp' || a === 'motorDown'));
      });
    }), { numRuns: RUNS });
  });

  it('P7: after a sensor fault, only an accepted on-site clear makes the sensor trusted again', () => {
    fc.assert(fc.property(fc.array(inputArb, { maxLength: 80 }), (inputs) => {
      const m = new BarrierStateMachine(spec);
      let faulty = false;
      for (const i of inputs) {
        const r = m.step(i);
        if (i.event === 'SENSOR_FAULT') faulty = true;
        if (i.event === 'CLEAR_FAULT' && r.accepted) faulty = false;
        if (faulty && m.ctx.sensorHealthy) return false;
      }
      return true;
    }), { numRuns: RUNS });
  });

  it('P6: the post never rises while the state machine believes the bay is occupied', () => {
    fc.assert(fc.property(fc.array(inputArb, { maxLength: 80 }), (inputs) => {
      const m = new BarrierStateMachine(spec);
      return inputs.every((i) => {
        m.step(i);
        return !(m.state === 'RAISING' && (m.ctx.occupied || !m.ctx.sensorHealthy));
      });
    }), { numRuns: RUNS });
  });
});
