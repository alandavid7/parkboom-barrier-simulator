// Demo page for the simulator. Everything here runs the same code the tests run:
// real P-256 signatures, the JSON state table and the barrier's check order.

import type { Action, Decision, PhoneRequest } from '../src/protocol/messages.js';
import { World } from '../src/sim/world.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let w: World;
let who: 'priya' | 'alan' = 'priya';
let lastReq: PhoneRequest | undefined;
let busy = false;
const DOWN_STATES = new Set(['DOWN_EMPTY', 'DOWN_NOBODY', 'DOWN_OCCUPIED']);

const STATE_TONE: Record<string, string> = {
  UP: 'ok', DOWN_EMPTY: 'info', DOWN_OCCUPIED: 'info', DOWN_NOBODY: 'warn',
  LOWERING: 'move', RAISING: 'move', STOPPED: 'warn', JAMMED: 'bad', FAULT: 'bad', MAINTENANCE: 'warn',
};

function fmtTime(s: number | null): string {
  if (s === null) return 'untrusted';
  return new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function say(d: Decision | string, ok?: boolean) {
  const el = $('decision');
  if (typeof d === 'string') { el.textContent = d; el.dataset.tone = ok ? 'ok' : 'info'; return; }
  el.textContent = d.ok ? `Accepted: ${d.message}` : `Refused (${d.code}): ${d.message}`;
  el.dataset.tone = d.ok ? 'ok' : 'bad';
}

/** Same exchange as World.phoneAction, but keeps the request so it can be replayed. */
async function phone(action: Action): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (!w.barrier.powered) { say({ ok: false, code: 'barrier_off', message: 'The barrier has no power' }); return; }
    const p = w.people[who]!;
    const ch = w.barrier.issueChallenge();
    let time;
    if (w.phoneOnline) {
      time = await w.cloud.signedTime('B12', ch.nonce);
      p.phone.learnRevocation(w.cloud.revocationList());
    }
    lastReq = await p.phone.request(ch, action, time);
    say(await w.barrier.handlePhone(lastReq));
  } finally { busy = false; render(); }
}

function primaryAction(): Action {
  const s = w.barrier.state;
  return DOWN_STATES.has(s) ? 'raise' : 'lower';
}

// ---------- hold-to-act button ----------
function wireHold() {
  const btn = $('hold');
  const ring = $('ring');
  let timer: number | undefined; let start = 0; let raf = 0;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined; cancelAnimationFrame(raf);
    ring.style.setProperty('--p', '0');
    btn.classList.remove('holding');
  };
  const begin = (e: Event) => {
    e.preventDefault();
    if (btn.hasAttribute('disabled')) return;
    start = performance.now(); btn.classList.add('holding');
    const loop = () => { ring.style.setProperty('--p', String(Math.min(1, (performance.now() - start) / 1000))); raf = requestAnimationFrame(loop); };
    loop();
    timer = window.setTimeout(() => { cancel(); void phone(primaryAction()); }, 1000);
  };
  btn.addEventListener('pointerdown', begin);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, cancel));
  btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !timer && !e.repeat) begin(e); });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') cancel(); });
}

// ---------- what-if buttons ----------
const ACTIONS: Record<string, () => Promise<void> | void> = {
  car: () => { const occ = w.barrier.sm.ctx.occupied; const r = w.barrier.physical(occ ? 'CAR_LEAVES' : 'CAR_ARRIVES'); say(r ? `Bay sensor: ${occ ? 'car left' : 'car over the post'}` : 'Barrier has no power, sensor not read'); },
  obstruction: () => { const r = w.barrier.physical('OBSTRUCTION'); say(r?.accepted ? 'Obstruction: post reversed and lowering' : `Obstruction noted (${r?.reason ?? 'no power'})`); },
  fault: () => { w.barrier.physical('SENSOR_FAULT'); say('Bay sensor failed its self-test'); },
  forced: () => { const r = w.barrier.physical('FORCED_DOWN'); say(r?.accepted ? 'Post forced down by hand: tamper logged' : `Ignored: ${r?.reason ?? 'no power'}`); },
  power: () => {
    if (w.barrier.powered) { w.barrier.powerLoss(); say('Power cut. The post holds where it is and stops trusting its clock.'); }
    else { w.barrier.powerRestore(); say('Power back. Needs signed time from a phone or the gateway before it accepts passes.'); void w.gatewayTimeSync().then(render); }
  },
  gateway: async () => { w.gatewayOnline = !w.gatewayOnline; say(`Gateway ${w.gatewayOnline ? 'online' : 'offline'}`); if (w.gatewayOnline) await w.gatewayTimeSync(); },
  signal: () => { w.phoneOnline = !w.phoneOnline; say(`Phone signal ${w.phoneOnline ? 'on' : 'off (Bluetooth only)'}`); },
  rlower: async () => say(await w.remote('lower', 'Alan')),
  rraise: async () => say(await w.remote('raise', 'Alan')),
  rlate: async () => say(await w.remote('lower', 'Alan', 45_000)),
  replay: async () => { if (!lastReq) { say('Nothing to replay yet. Lower or raise first.'); return; } say(await w.barrier.handlePhone(lastReq)); },
  revoke: async () => { await w.revoke('priya'); say(w.gatewayOnline ? 'Priya removed. The gateway pushed the new list to the barrier.' : 'Priya removed in the cloud. The barrier hears when the gateway or any online phone next connects.'); },
  refresh: async () => { const ok = await w.refreshCredential(who); say(ok ? 'Pass renewed for 72 hours' : 'Could not renew: offline or removed'); },
  t5: () => { w.advance(5 * 60_000); say('Time moved on 5 minutes'); },
  t72: async () => { w.advance(72 * 3600_000); await w.gatewayTimeSync(); say('Time moved on 72 hours. Passes issued at the start have now expired.'); },
  maint_on: () => phone('maint_on'),
  maint_off: () => phone('maint_off'),
  clear: () => phone('clear_fault'),
  reset: async () => { w = await World.create(); lastReq = undefined; say('Fresh car park: post up, clock trusted, both passes valid'); },
};

function wireButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-do]').forEach((b) => {
    b.addEventListener('click', async () => {
      const f = ACTIONS[b.dataset.do!]; if (!f) return;
      b.disabled = true;
      try { await f(); } finally { b.disabled = false; render(); }
    });
  });
  document.querySelectorAll<HTMLInputElement>('input[name="who"]').forEach((r) => r.addEventListener('change', () => { who = r.value as 'priya' | 'alan'; render(); }));
}

// ---------- rendering ----------
let renderedEvents = -1;
function render() {
  const b = w.barrier;
  const tone = STATE_TONE[b.state] ?? 'info';
  $('state').textContent = b.sm.label; $('state').dataset.tone = tone;
  $('code').textContent = b.state;
  $('post').style.setProperty('--h', b.height.toFixed(3));
  $('car').style.display = b.sm.ctx.occupied ? '' : 'none';
  $('scene').classList.toggle('off', !b.powered);
  $('scene').classList.toggle('faulty', !b.sm.ctx.sensorHealthy);

  $('clock').textContent = fmtTime(b.trustedNow());
  $('clock').dataset.tone = b.clockTrusted ? 'ok' : 'bad';
  $('wall').textContent = fmtTime(w.now);
  $('chip-power').dataset.on = String(b.powered);
  $('chip-gw').dataset.on = String(w.gatewayOnline);
  $('chip-sig').dataset.on = String(w.phoneOnline);

  const p = w.people[who]!;
  const cred = p.phone.credential?.payload;
  $('pass').textContent = cred ? `${cred.personId} · ${cred.role} · bay ${cred.accessPoints.join(', ')} · until ${fmtTime(cred.notAfter)}` : 'No pass';
  const revoked = w.cloud.revocationList()?.payload.revokedDeviceIds.includes(p.phone.deviceId) ?? false;
  $('pass').dataset.tone = revoked ? 'bad' : cred && cred.notAfter > w.now ? 'ok' : 'warn';
  $('pass-note').textContent = revoked ? 'Removed by an admin' : cred && cred.notAfter <= w.now ? 'Expired: needs signal to renew' : 'Stored on the phone, works without signal';

  const act = primaryAction();
  const hold = $('hold');
  $('hold-label').textContent = act === 'raise' ? 'Hold to raise' : 'Hold to lower';
  $('hold-hint').textContent = act === 'raise' ? 'Only works on site, with the bay reading empty' : 'Lowers the post so you can park';
  hold.toggleAttribute('disabled', b.moving || busy);
  document.querySelectorAll<HTMLElement>('.admin-only').forEach((el) => { el.hidden = who !== 'alan'; });

  const signal = document.querySelector<HTMLButtonElement>('[data-do="signal"]')!;
  signal.textContent = w.phoneOnline ? 'Lose phone signal' : 'Restore phone signal';
  const power = document.querySelector<HTMLButtonElement>('[data-do="power"]')!;
  power.textContent = b.powered ? 'Cut power' : 'Restore power';
  const gw = document.querySelector<HTMLButtonElement>('[data-do="gateway"]')!;
  gw.textContent = w.gatewayOnline ? 'Take gateway offline' : 'Bring gateway online';
  const car = document.querySelector<HTMLButtonElement>('[data-do="car"]')!;
  car.textContent = b.sm.ctx.occupied ? 'Car leaves the bay' : 'Car parks over the post';

  if (b.events.length !== renderedEvents) renderLog();
}

function renderLog() {
  const b = w.barrier;
  renderedEvents = b.events.length;
  const rows = [...b.events].reverse().slice(0, 200).map((e) => {
    const x = e.payload;
    const t = x.at === null ? '—' : new Date(x.at * 1000).toISOString().slice(11, 19);
    return `<tr data-kind="${x.kind}"><td class="n">${x.seq}</td><td class="n">${t}</td><td><span class="kind">${x.kind}</span></td><td class="detail">${esc(x.detail)}</td><td class="sig" title="ECDSA P-256 signature">${e.sig.slice(0, 10)}…</td></tr>`;
  });
  $('log').innerHTML = rows.join('') || '<tr><td colspan="5" class="empty">No events yet. Hold the phone button to lower the post.</td></tr>';
  $('count').textContent = `${b.events.length} signed events`;
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

async function main() {
  w = await World.create();
  wireHold(); wireButtons();
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    w.advance(Math.min(500, now - last)); last = now;
    void w.barrier.flush().then(render);
  }, 100);
  render();
  say('Post is up. Hold the phone button for one second to lower it.');
}

main().catch((e) => { $('decision').textContent = `Could not start: ${String(e)}`; });
