// Table-driven barrier state machine.
// The rules live in spec/barrier-states.json; this file only knows how to read and run them.
// Real firmware should generate its transition table from the same JSON file.

export type Position = 'up' | 'moving_down' | 'moving_up' | 'down' | 'unknown' | 'hold';
export type Source = 'phone' | 'gateway' | 'sensor' | 'system';

export interface StateDef { position: Position; label: string }
export interface Transition { from: string; event: string; to: string; guards?: string[]; actions: string[] }
export interface Spec {
  name: string; version: string; initial: string;
  states: Record<string, StateDef>;
  events: Record<string, string>;
  guards: Record<string, string>;
  actions: Record<string, string>;
  transitions: Transition[];
}

export interface Context {
  /** Last bay-sensor reading: true = something is over the post. */
  occupied: boolean;
  /** False after a sensor self-test failure. An unhealthy sensor is treated as occupied. */
  sensorHealthy: boolean;
}

export interface Input { event: string; source: Source }

export interface StepResult {
  accepted: boolean;
  from: string;
  to: string;
  event: string;
  source: Source;
  actions: string[];
  /** Why an input was rejected, in words a person can read. */
  reason?: string;
}

export const GUARDS: Record<string, (ctx: Context, input: Input) => boolean> = {
  bayEmpty: (ctx) => ctx.sensorHealthy && !ctx.occupied,
  fromPhone: (_ctx, input) => input.source === 'phone',
  fromGateway: (_ctx, input) => input.source === 'gateway',
};

const SENSOR_EVENTS = new Set(['CAR_ARRIVES', 'CAR_LEAVES', 'SENSOR_FAULT']);

/** Checks the table is complete and consistent. Throws on the first problem. */
export function validateSpec(spec: Spec): void {
  if (!spec.states[spec.initial]) throw new Error(`Initial state ${spec.initial} is not defined`);
  for (const [i, t] of spec.transitions.entries()) {
    const where = `transition ${i} (${t.from} --${t.event}--> ${t.to})`;
    if (t.from !== '*' && !spec.states[t.from]) throw new Error(`${where}: unknown 'from' state`);
    if (!spec.states[t.to]) throw new Error(`${where}: unknown 'to' state`);
    if (!spec.events[t.event]) throw new Error(`${where}: unknown event`);
    for (const g of t.guards ?? []) {
      if (!spec.guards[g]) throw new Error(`${where}: guard ${g} not described in the spec`);
      if (!GUARDS[g]) throw new Error(`${where}: guard ${g} has no implementation`);
    }
    for (const a of t.actions) if (!spec.actions[a]) throw new Error(`${where}: unknown action ${a}`);
  }
  for (const g of Object.keys(spec.guards)) if (!GUARDS[g]) throw new Error(`Guard ${g} has no implementation`);
}

export class BarrierStateMachine {
  state: string;
  readonly ctx: Context;

  constructor(readonly spec: Spec, ctx: Partial<Context> = {}) {
    validateSpec(spec);
    this.state = spec.initial;
    this.ctx = { occupied: false, sensorHealthy: true, ...ctx };
  }

  get position(): Position { return this.spec.states[this.state]!.position; }
  get label(): string { return this.spec.states[this.state]!.label; }

  /** Feed one input. Sensor readings always update the context, even when no transition matches. */
  step(input: Input): StepResult {
    const from = this.state;
    if (!this.spec.events[input.event]) {
      return { accepted: false, from, to: from, event: input.event, source: input.source, actions: [], reason: 'Unknown event' };
    }
    if (input.event === 'CAR_ARRIVES') this.ctx.occupied = true;
    if (input.event === 'CAR_LEAVES') this.ctx.occupied = false;
    if (input.event === 'SENSOR_FAULT') this.ctx.sensorHealthy = false;

    let guardFailure: string | undefined;
    for (const t of this.spec.transitions) {
      if (t.event !== input.event) continue;
      if (t.from !== '*' && t.from !== from) continue;
      const failed = (t.guards ?? []).find((g) => !GUARDS[g]!(this.ctx, input));
      if (failed) { guardFailure ??= failed; continue; }
      this.state = t.to;
      // Only an accepted, on-site clear restores trust in the sensor. A refused one changes nothing.
      if (input.event === 'CLEAR_FAULT') this.ctx.sensorHealthy = true;
      return { accepted: true, from, to: t.to, event: input.event, source: input.source, actions: [...t.actions] };
    }
    const reason = guardFailure
      ? guardText(guardFailure)
      : SENSOR_EVENTS.has(input.event) ? 'Sensor reading noted' : `Not allowed while ${this.label.toLowerCase()}`;
    return { accepted: false, from, to: from, event: input.event, source: input.source, actions: [], reason };
  }
}

function guardText(guard: string): string {
  switch (guard) {
    case 'bayEmpty': return 'The bay is not reading empty, so the post will not rise';
    case 'fromPhone': return 'Only allowed from a phone on site';
    case 'fromGateway': return 'Only allowed through the gateway';
    default: return `Guard ${guard} failed`;
  }
}
