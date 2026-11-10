import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../core/protect.js';
import { generate } from '../data/generate.mjs';

const data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url)));
const A = C.analyze(data);
const { inst, shared, dedicated, none } = A;

test('seeded generator reproduces the committed network.json', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(generate())), data);
});

test('orbits: circular radius is constant and GEO stays on station', () => {
  const leo = inst.sats.find((s) => s.id === 'KST-01').el;
  for (const t of [0, 1000, 50000]) {
    const r = Math.hypot(...C.eci(leo, t));
    assert.ok(Math.abs(r - leo.a) < leo.a * leo.e + 1e-6 + 10, `radius ${r}`);
  }
  const geo = inst.sats.find((s) => s.id === 'GEO-01').el;
  const g0 = data.epochGmstDeg * Math.PI / 180;
  const lon = (t) => { const p = C.eciToEcef(C.eci(geo, t), t, g0); return Math.atan2(p[1], p[0]) * 180 / Math.PI; };
  assert.ok(Math.abs(lon(0) - -105) < 0.01);
  assert.ok(Math.abs(lon(86400) - lon(0)) < 1.0, `GEO drift ${lon(86400) - lon(0)} deg/day`);
});

test('J2: sun-synchronous orbit precesses about +0.9856 deg/day', () => {
  const el = { a: C.RE + 700, e: 0, i: 98.19, raan: 0, argp: 0, m0: 0 };
  const deg = C.j2Rates(el).raanDot * 86400 * 180 / Math.PI;
  assert.ok(Math.abs(deg - 0.9856) < 0.02, `raan rate ${deg}`);
});

test('passes: elevation is above the mask inside and at the mask on the edges', () => {
  const s = inst.sats.find((x) => x.id === 'TRN-01');
  const g0 = data.epochGmstDeg * Math.PI / 180;
  const site = data.sites[3];
  const ps = C.findPasses(s.el, site, 86400, g0);
  assert.ok(ps.length > 3);
  for (const p of ps) {
    const mid = C.elevationDeg(s.el, site, (p.start + p.end) / 2, g0, C.j2Rates(s.el));
    assert.ok(mid >= 10, `mid elevation ${mid}`);
    if (p.start > 0) assert.ok(Math.abs(C.elevationDeg(s.el, site, p.start, g0, C.j2Rates(s.el)) - 10) < 0.05);
  }
});

test('maxGap counts the start edge, interior gaps, and runs to the look-ahead end', () => {
  assert.equal(C.maxGap([], 100, 160), 160);
  assert.equal(C.maxGap([{ start: 30, end: 40 }, { start: 90, end: 95 }, { start: 150, end: 155 }], 100, 160), 55);
  assert.equal(C.maxGap([{ start: 10, end: 20 }, { start: 30, end: 40 }], 100, 160), 120);
});

test('farthest-reach cover is minimum-cardinality (brute force on random instances)', () => {
  const rnd = C.mulberry32(3);
  for (let trial = 0; trial < 60; trial++) {
    const H = 200, HE = 260, G = 40 + Math.floor(rnd() * 40);
    const opts = Array.from({ length: 9 }, (_, k) => { const a = Math.floor(rnd() * 240); return { id: k, start: a, end: a + 3 + Math.floor(rnd() * 15) }; });
    const g = C.gapCover([], opts, G, H, undefined, HE);
    let best = Infinity;
    for (let m = 0; m < 1 << opts.length; m++) {
      const sub = opts.filter((_, k) => m & (1 << k));
      if (C.maxGap(sub, H, HE) <= G) best = Math.min(best, sub.length);
    }
    if (best === Infinity) assert.ok(g.residual > G);
    else { assert.ok(g.residual <= G); assert.equal(g.picked.length, best); }
  }
});

test('capacity: firm load (protected primaries + firm standard) plus reserve never exceeds beams', () => {
  const firm = C.makeLoad(inst.sites.length, inst.HE);
  for (const s of inst.sats) for (const c of shared.plan.get(s.id)) if (!shared.preemptible.has(c.id)) for (let t = c.start; t < c.end; t++) firm[c.site][t]++;
  inst.sites.forEach((site, j) => { for (let t = 0; t < inst.HE; t++) assert.ok(firm[j][t] + shared.R[j][t] <= site.beams, `${site.id} t=${t}`); });
  // and total load without reserve always fits
  inst.sites.forEach((site, j) => { for (let t = 0; t < inst.HE; t++) assert.ok(shared.P[j][t] <= site.beams); });
});

test('shared reserve never needs more beam-minutes than dedicated per-satellite backups', () => {
  assert.ok(C.beamMinutes(shared.R) <= C.beamMinutes(dedicated.R));
});

test('guarantee: certified satellites never breach under 600 random single-site outages; reactive does', () => {
  const ok = inst.sats.filter((s) => s.prio <= 1 && shared.status.get(s.id).protected);
  assert.ok(ok.length >= 20);
  const rnd = C.mulberry32(11);
  let viol = 0, reactive = 0;
  for (let i = 0; i < 600; i++) {
    const site = Math.floor(rnd() * inst.sites.length), start = Math.floor(rnd() * inst.H), dur = 10 + Math.floor(rnd() * 1400);
    const o = { site, start, end: Math.min(inst.HE, start + dur) };
    const a = C.simulateOutage(inst, shared, o, { strategy: 'protected' });
    const z = C.simulateOutage(inst, none, o, { strategy: 'reactive' });
    for (const s of ok) { if (a.perSat.get(s.id).breach) viol++; if (z.perSat.get(s.id).breach) reactive++; }
  }
  assert.equal(viol, 0);
  assert.ok(reactive > 50, `reactive breaches ${reactive}`);
});

test('activated backups are never at the failed site and start after failure + lead', () => {
  for (const o of [{ site: 3, start: 400, end: 900 }, { site: 0, start: 37, end: 2000 }, { site: 4, start: 1201, end: 1300 }]) {
    const a = C.simulateOutage(inst, shared, o, { strategy: 'protected', lead: 15 });
    for (const v of a.perSat.values()) for (const c of v.activated) { assert.notEqual(c.site, o.site); assert.ok(c.start >= o.start + 15); }
  }
});

test('monte carlo is deterministic for a seed', () => {
  const x = C.monteCarlo(inst, shared, none, { n: 40, seed: 5 });
  const y = C.monteCarlo(inst, shared, none, { n: 40, seed: 5 });
  assert.deepEqual(x.prot, y.prot);
  assert.ok(x.prot.p <= x.prot.r);
});
