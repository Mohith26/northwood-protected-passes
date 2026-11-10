// Protected passes: shared backup capacity for a multi-beam ground network.
// Pure functions, no DOM. Runs in the browser (ES module) and in Node (node --test).
//
// Pipeline
//   1. propagate()        Keplerian orbit + J2 secular drift -> ECI -> ECEF
//   2. findPasses()       elevation >= mask windows per (satellite, site), bisection-refined
//   3. candidates()       pass windows -> bookable contacts on a 1-minute grid
//   4. planPrimary()      gap-SLA scheduling with per-site beam capacity (farthest-reach cover)
//   5. protect()          shared backup capacity: for every site k, pre-reserve backups at
//                         sites != k so each protected satellite still meets its max-gap SLA
//                         if k goes dark. Reserve at site j = max over k (not sum), because
//                         only one site fails at a time (shared-risk protection, as in
//                         shared backup path protection for optical networks).
//   6. simulateOutage()   replay an outage (site, start, duration) with either the protected
//                         plan (activate reserved backups) or reactive rescheduling into
//                         whatever capacity is free after a notice lead time.

export const RE = 6378.137;            // km, WGS84 equatorial radius
export const MU = 398600.4418;         // km^3/s^2
export const J2 = 1.08262668e-3;
export const OMEGA_E = 7.2921150e-5;   // rad/s
const F = 1 / 298.257223563;
const D2R = Math.PI / 180;

// ---------- seeded RNG ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- orbits ----------
export function j2Rates(el) {
  const a = el.a, e = el.e || 0, i = el.i * D2R;
  const n = Math.sqrt(MU / (a * a * a));
  const p = a * (1 - e * e);
  const k = J2 * (RE / p) ** 2;
  const c = Math.cos(i);
  return {
    n,
    raanDot: -1.5 * n * k * c,
    argpDot: 0.75 * n * k * (5 * c * c - 1),
    mDot: n * (1 + 0.75 * k * Math.sqrt(1 - e * e) * (3 * c * c - 1)),
  };
}

function solveKepler(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 20; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

// position in ECI (km) at t seconds after epoch
export function eci(el, t, rates = j2Rates(el)) {
  const e = el.e || 0, i = el.i * D2R;
  const raan = el.raan * D2R + rates.raanDot * t;
  const argp = (el.argp || 0) * D2R + rates.argpDot * t;
  const M = el.m0 * D2R + rates.mDot * t;
  const E = solveKepler(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), e);
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const r = el.a * (1 - e * Math.cos(E));
  const u = argp + nu;
  const cO = Math.cos(raan), sO = Math.sin(raan), ci = Math.cos(i), si = Math.sin(i);
  const cu = Math.cos(u), su = Math.sin(u);
  return [r * (cO * cu - sO * su * ci), r * (sO * cu + cO * su * ci), r * su * si];
}

export function eciToEcef(v, t, gmst0) {
  const th = gmst0 + OMEGA_E * t;
  const c = Math.cos(th), s = Math.sin(th);
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}

export function siteEcef(site) {
  const lat = site.lat * D2R, lon = site.lon * D2R, h = (site.alt || 0) / 1000;
  const e2 = F * (2 - F);
  const N = RE / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const r = [(N + h) * Math.cos(lat) * Math.cos(lon), (N + h) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h) * Math.sin(lat)];
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  return { r, up };
}

export function elevationDeg(el, site, t, gmst0, rates, sx = siteEcef(site)) {
  const p = eciToEcef(eci(el, t, rates), t, gmst0);
  const d = [p[0] - sx.r[0], p[1] - sx.r[1], p[2] - sx.r[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return Math.asin((d[0] * sx.up[0] + d[1] * sx.up[1] + d[2] * sx.up[2]) / n) / D2R;
}

// visibility windows [{start,end}] in seconds, elevation >= mask
export function findPasses(el, site, horizonS, gmst0, { step = 30, mask = site.mask ?? 10 } = {}) {
  const rates = j2Rates(el), sx = siteEcef(site);
  const f = (t) => elevationDeg(el, site, t, gmst0, rates, sx) - mask;
  const refine = (lo, hi, rising) => {
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if ((f(mid) >= 0) === rising) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const out = [];
  let prevT = 0, prev = f(0), open = prev >= 0 ? 0 : null;
  for (let t = step; t <= horizonS + 1e-9; t += step) {
    const tt = Math.min(t, horizonS), v = f(tt);
    if (open === null && prev < 0 && v >= 0) open = refine(prevT, tt, true);
    else if (open !== null && prev >= 0 && v < 0) { out.push({ start: open, end: refine(prevT, tt, false) }); open = null; }
    prevT = tt; prev = v;
  }
  if (open !== null) out.push({ start: open, end: horizonS });
  return out;
}

// ---------- network instance ----------
// data: { epochGmstDeg, horizonMin, sites:[{id,name,lat,lon,beams,mask}], missions:[{id,name,tier,slaMin,
//         minContactMin,maxContactMin,sats:[{id,el}]}] }
export function buildInstance(data, { step = 30 } = {}) {
  const H = data.horizonMin, HE = H + (data.lookaheadMin ?? 720), gmst0 = data.epochGmstDeg * D2R;
  const sats = [];
  for (const m of data.missions) for (const s of m.sats) sats.push({ ...s, mission: m.id, tier: m.tier, sla: m.slaMin, minC: m.minContactMin, maxC: m.maxContactMin, prio: tierPrio(m.tier) });
  const passes = [];
  for (const s of sats) data.sites.forEach((site, j) => {
    for (const w of findPasses(s.el, site, HE * 60, gmst0, { step })) passes.push({ sat: s.id, site: j, start: w.start / 60, end: w.end / 60 });
  });
  return { H, HE, sites: data.sites, missions: data.missions, sats, passes, cand: candidates(passes, sats) };
}

export function tierPrio(tier) { return tier === 'Protected · Gov' ? 0 : tier === 'Protected' ? 1 : 2; }

// Turn visibility windows into bookable contacts on a 1-minute grid.
// Short windows (LEO) -> one contact covering the usable part (capped at maxC);
// long windows (MEO/GEO) -> back-to-back slots of maxC minutes.
export function candidates(passes, sats) {
  const by = new Map(sats.map((s) => [s.id, s]));
  const out = [];
  for (const p of passes) {
    const s = by.get(p.sat);
    let a = Math.ceil(p.start), b = Math.floor(p.end);
    if (b - a < s.minC) continue;
    if (b - a <= s.maxC) {
      const mid = (a + b) / 2, half = Math.min(b - a, s.maxC) / 2;
      out.push({ sat: p.sat, site: p.site, start: Math.round(mid - half), end: Math.round(mid - half) + Math.min(b - a, s.maxC) });
    } else {
      for (let t = a; t + s.maxC <= b; t += s.maxC) out.push({ sat: p.sat, site: p.site, start: t, end: t + s.maxC });
    }
  }
  out.sort((x, y) => x.start - y.start || x.site - y.site);
  out.forEach((c, k) => (c.id = k));
  return out;
}

// ---------- gap metrics ----------
// Largest gap (minutes) that *opens* inside the planning day [0, H): from 0 to the first contact,
// and between consecutive contacts. Contacts after H (the look-ahead) only close gaps. If nothing
// closes a gap before HE (end of look-ahead), it runs to HE.
export function maxGap(contacts, H, HE = H) {
  const cs = [...contacts].sort((a, b) => a.start - b.start);
  let cur = 0, g = 0;
  for (const c of cs) { if (cur >= H) break; g = Math.max(g, c.start - cur); cur = Math.max(cur, c.end); }
  if (cur < H) g = Math.max(g, HE - cur);
  return g;
}

// Farthest-reach cover. Given fixed contacts and optional ones, pick the fewest optional
// contacts so that every gap <= G. Classic greedy (optimal for interval-gap covering when
// unconstrained): when the coverage frontier `cur` would leave a gap > G, choose the
// usable optional contact with start <= cur + G that ends latest. `usable(c)` lets the
// caller enforce capacity. Returns { picked, residual } where residual is the worst gap left.
export function gapCover(fixed, optional, G, H, usable = () => true, HE = H) {
  const fx = [...fixed].sort((a, b) => a.start - b.start);
  const op = [...optional].sort((a, b) => a.start - b.start);
  const picked = [];
  let cur = 0, fi = 0;
  const advanceFixed = () => { while (fi < fx.length && fx[fi].start <= cur + G) { cur = Math.max(cur, fx[fi].end); fi++; } };
  for (let guard = 0; guard < 100000; guard++) {
    advanceFixed();
    if (cur >= H || cur + G >= HE) break;
    // next fixed contact start (if any) bounds what we need
    let best = null;
    for (const c of op) {
      if (c.start > cur + G) break;
      if (c.end <= cur || picked.includes(c)) continue;
      if (!usable(c)) continue;
      if (!best || c.end > best.end) best = c;
    }
    if (best) { picked.push(best); cur = Math.max(cur, best.end); continue; }
    // SLA cannot be met at this frontier: jump to the next available contact (fixed or optional)
    const nf = fi < fx.length ? fx[fi] : null;
    let no = null;
    for (const c of op) if (c.start > cur && !picked.includes(c) && usable(c)) { no = c; break; }
    const nxt = !nf ? no : !no ? nf : (nf.start <= no.start ? nf : no);
    if (!nxt) break;
    if (nxt === no) picked.push(no); else fi++;
    cur = Math.max(cur, nxt.end);
  }
  return { picked, residual: maxGap([...fixed, ...picked], H, HE) };
}

// ---------- capacity ----------
export function makeLoad(nSites, H) { return Array.from({ length: nSites }, () => new Int16Array(H)); }
function fits(arrs, cap, c, extra = 0) {
  for (let t = c.start; t < c.end; t++) { let s = extra; for (const a of arrs) s += a[t]; if (s + 1 > cap) return false; }
  return true;
}
function add(arr, c, d = 1) { for (let t = c.start; t < c.end; t++) arr[t] += d; }

// Order satellites by tier, then scarcity (fewest candidate minutes first), then id.
export function satOrder(inst) {
  const bySat = groupBy(inst.cand, 'sat');
  return [...inst.sats].sort((a, b) => a.prio - b.prio || supply(bySat.get(a.id)) - supply(bySat.get(b.id)) || a.id.localeCompare(b.id));
}
function supply(list) { return (list || []).reduce((s, c) => s + (c.end - c.start), 0); }
export function groupBy(list, key) { const m = new Map(); for (const x of list) { if (!m.has(x[key])) m.set(x[key], []); m.get(x[key]).push(x); } return m; }

// Backup reservation for protected satellites, given their primaries in P.
//
// Failure model: one site k fails at time s0 and stays down for the rest of the horizon (the worst
// case; shorter outages lose a subset of contacts). A contact in progress at s0 is cut at s0. Backups
// can only be activated if they start at least `lead` minutes after the failure.
//
// Scenarios: sigma = (k, s0) on a `step`-minute grid. For an outage that really starts at s, we use
// scenario (k, floor(s/step)*step) and design its backups with lead + step, so every activated backup
// still starts >= s + lead, every contact the real outage loses is also lost in the scenario, and every
// contact the scenario keeps is also kept. Coverage under the real outage is therefore a superset.
//
// For each scenario, protected satellites (priority order) that would breach their max-gap SLA pick
// backups at sites != k by farthest-reach, subject to   P[j][t] + L_sigma[j][t] + 1 <= beams_j.
//   shared:    reserve R = max over sigma of L_sigma   (scenarios are mutually exclusive)
//   dedicated: every satellite keeps every backup it might ever need on its own beam:
//              R = sum over satellites of the union of their backups, P + R <= beams.
export function reserveBackups(inst, P, plan, order, { mode = 'shared', capacityScale = 1, step = 15, lead = 15 } = {}) {
  const { H, HE, sites, cand } = inst;
  const nS = sites.length;
  const R = makeLoad(nS, HE);
  const bySat = groupBy(cand, 'sat');
  const cap = (j) => Math.floor(sites[j].beams * capacityScale);
  const prot = order.filter((s) => s.prio <= 1);
  const scen = new Map();          // key `${k}@${s0}` -> Map(satId -> backups)
  const status = new Map(prot.map((s) => [s.id, { protected: true, residual: {}, scenarios: 0, worst: 0 }]));
  const held = new Map(prot.map((s) => [s.id, new Set()])); // dedicated: contact ids each satellite holds
  const L = makeLoad(nS, HE);
  for (let k = 0; k < nS; k++) {
    for (let s0 = 0; s0 < H; s0 += step) {
      for (const a of L) a.fill(0);
      const chosen = new Map();
      for (const s of prot) {
        const prim = plan.get(s.id) || [];
        if (!prim.some((c) => c.site === k && c.end > s0)) continue;
        const fixed = [];
        for (const c of prim) {
          if (c.site !== k || c.end <= s0) fixed.push(c);
          else if (c.start < s0) fixed.push({ ...c, end: s0 });
        }
        const st = status.get(s.id);
        if (maxGap(fixed, H, HE) <= s.sla + 1e-9) continue;
        st.scenarios++;
        const primIds = new Set(prim.map((c) => c.id));
        const opts = (bySat.get(s.id) || []).filter((c) => c.site !== k && !primIds.has(c.id) && c.start >= s0 + lead + step);
        const mine = held.get(s.id);
        const usable = (c) => {
          const j = c.site;
          if (mode === 'shared') { for (let t = c.start; t < c.end; t++) if (P[j][t] + L[j][t] + 1 > cap(j)) return false; return true; }
          if (mine.has(c.id)) return true;
          for (let t = c.start; t < c.end; t++) if (P[j][t] + R[j][t] + 1 > cap(j)) return false;
          return true;
        };
        // first try to ride on beams that are already reserved (no new reserve), then fall back
        const free = (c) => {
          if (!usable(c)) return false;
          if (mode === 'dedicated') return mine.has(c.id);
          for (let t = c.start; t < c.end; t++) if (L[c.site][t] + 1 > R[c.site][t]) return false;
          return true;
        };
        let { picked, residual: g } = gapCover(fixed, opts, s.sla, H, free, HE);
        if (g > s.sla + 1e-9) ({ picked, residual: g } = gapCover(fixed, opts, s.sla, H, usable, HE));
        if (g <= s.sla + 1e-9) {
          for (const c of picked) {
            add(L[c.site], c);
            if (mode === 'dedicated' && !mine.has(c.id)) { mine.add(c.id); add(R[c.site], c); }
          }
          chosen.set(s.id, picked);
          st.worst = Math.max(st.worst, g);
        } else {
          st.protected = false;
          st.residual[k] = Math.max(st.residual[k] || 0, g);
          chosen.set(s.id, []);
        }
      }
      if (mode === 'shared') for (let j = 0; j < nS; j++) { const r = R[j], l = L[j]; for (let t = 0; t < HE; t++) if (l[t] > r[t]) r[t] = l[t]; }
      if (chosen.size) scen.set(`${k}@${s0}`, chosen);
    }
  }
  return { R, scen, status, mode, step, lead };
}

// Backups that protect against an outage at `site` starting at minute `start`.
export function scenarioFor(planOrRes, site, start) {
  const s0 = Math.floor(start / planOrRes.step) * planOrRes.step;
  return planOrRes.scen.get(`${site}@${s0}`) || new Map();
}

// Can satellite s, flying `prim`, survive every single-site failure scenario (k, s0) if capacity were
// unlimited? Returns the worst gap seen (<= SLA means yes). Same scenario model as reserveBackups.
export function n1WorstGap(inst, s, prim, { step = 15, lead = 15 } = {}) {
  const { H, HE, sites } = inst;
  const opts = (inst._bySat || (inst._bySat = groupBy(inst.cand, 'sat'))).get(s.id) || [];
  const primIds = new Set(prim.map((c) => c.id));
  let worst = maxGap(prim, H, HE);
  for (let k = 0; k < sites.length; k++) for (let s0 = 0; s0 < H; s0 += step) {
    if (!prim.some((c) => c.site === k && c.end > s0)) continue;
    const fixed = [];
    for (const c of prim) { if (c.site !== k || c.end <= s0) fixed.push(c); else if (c.start < s0) fixed.push({ ...c, end: s0 }); }
    if (maxGap(fixed, H, HE) <= s.sla + 1e-9) continue;
    const o = opts.filter((c) => c.site !== k && !primIds.has(c.id) && c.start >= s0 + lead + step);
    worst = Math.max(worst, gapCover(fixed, o, s.sla, H, undefined, HE).residual);
    if (worst > s.sla + 600) return worst;
  }
  return worst;
}

// Full plan.
//   1. Protected satellites (Gov first) get primaries. Farthest-reach covers are as sparse as the SLA
//      allows, which leaves no room to recover from a failure, so with protection on we tighten the
//      planning target by the smallest margin (0, 60, ... 240 min) that makes the satellite survivable
//      under every single-site failure. With mode 'none' primaries are planned at the SLA (baseline).
//   2. mode 'shared' | 'dedicated': reserve backups for them. mode 'none': no reserve.
//   3. Standard satellites are scheduled into what is left. They may sit on reserved beams: those
//      contacts are booked as preemptible (they only lose the beam if the matching site fails).
export const MARGINS = [0, 60, 120, 180, 240];
export function buildPlan(inst, { mode = 'shared', capacityScale = 1, step = 15, lead = 15 } = {}) {
  const { H, HE, sites, cand } = inst;
  const P = makeLoad(sites.length, HE);
  const bySat = groupBy(cand, 'sat');
  const order = satOrder(inst);
  const plan = new Map(), margin = new Map();
  const cap = (j) => Math.floor(sites[j].beams * capacityScale);
  const usableP = (c) => fits([P[c.site]], cap(c.site), c);
  for (const s of order) {
    if (s.prio > 1) continue;
    let pick = null, best = null;
    for (const m of mode === 'none' ? [0] : MARGINS) {
      const { picked } = gapCover([], bySat.get(s.id) || [], Math.max(10, s.sla - m), H, usableP, HE);
      if (maxGap(picked, H, HE) > s.sla + 1e-9) continue;
      const w = mode === 'none' ? 0 : n1WorstGap(inst, s, picked, { step, lead });
      if (!best || w < best.w) best = { picked, m, w };
      if (w <= s.sla + 1e-9) { pick = { picked, m, w }; break; }
    }
    pick = pick || best || { picked: gapCover([], bySat.get(s.id) || [], s.sla, H, usableP, HE).picked, m: 0, w: Infinity };
    pick.picked.forEach((c) => add(P[c.site], c));
    plan.set(s.id, pick.picked);
    margin.set(s.id, { margin: pick.m, n1: pick.w });
  }
  const res = mode === 'none'
    ? { R: makeLoad(sites.length, HE), scen: new Map(), status: new Map(), mode, step, lead }
    : reserveBackups(inst, P, plan, order, { mode, capacityScale, step, lead });
  const preemptible = new Set();
  for (const s of order) {
    if (s.prio <= 1) continue;
    const { picked } = gapCover([], bySat.get(s.id) || [], s.sla, H, usableP, HE);
    for (const c of picked) {
      for (let t = c.start; t < c.end; t++) if (P[c.site][t] + res.R[c.site][t] + 1 > cap(c.site)) { preemptible.add(c.id); break; }
      add(P[c.site], c);
    }
    plan.set(s.id, picked);
  }
  return { P, plan, order, margin, ...res, preemptible, capacityScale };
}

export function beamMinutes(load) { let s = 0; for (const a of load) for (const v of a) s += v; return s; }

// ---------- outage replay ----------
// outage = { site, start, end } (minutes). At the failed site, a contact in progress at `start` is cut
// short at `start`; contacts beginning inside [start, end) are lost.
// strategy 'protected': activate the backups reserved for this site that have not already ended,
//   preempting standard contacts that were lent the reserved beams, then top up any remaining SLA
//   gap reactively (like any operator would).
// strategy 'reactive': ignore reserves; after start + lead minutes, rebook lost coverage greedily
//   into free capacity, satellites in priority order. This is today's "find a new antenna" recovery.
export function simulateOutage(inst, plan, outage, { strategy = 'protected', lead = 15 } = {}) {
  const { H, HE, sites, sats, cand } = inst;
  const hit = (c) => c.site === outage.site && c.start < outage.end && c.end > outage.start;
  const kept = new Map(), lost = new Map();
  for (const s of sats) {
    const keep = [], gone = [];
    for (const c of plan.plan.get(s.id) || []) {
      if (!hit(c)) keep.push(c);
      else { gone.push(c); if (c.start < outage.start) keep.push({ ...c, end: outage.start, truncated: true }); }
    }
    kept.set(s.id, keep); lost.set(s.id, gone);
  }
  const load = sites.map((_, j) => Int16Array.from(plan.P[j]));
  for (const s of sats) for (const c of lost.get(s.id)) for (let t = Math.max(c.start, outage.start); t < c.end; t++) load[c.site][t] -= 1;
  const capAt = (j, t) => (j === outage.site && t >= outage.start && t < outage.end) ? 0 : Math.floor(sites[j].beams * (plan.capacityScale || 1));
  const activated = new Map(), rebooked = new Map(), preempted = new Map();
  if (strategy === 'protected') {
    const chosen = scenarioFor(plan, outage.site, outage.start);
    for (const s of sats) {
      const bk = lost.get(s.id).length ? (chosen.get(s.id) || []).filter((c) => !hit(c)) : [];
      for (const c of bk) for (let t = c.start; t < c.end; t++) load[c.site][t] += 1;
      activated.set(s.id, bk);
    }
    // preempt standard contacts riding on reserved beams wherever activation overflows capacity
    const pre = [...sats].filter((s) => s.prio > 1).reverse();
    for (const s of pre) {
      const keep = kept.get(s.id), out = [];
      for (const c of keep) {
        if (!plan.preemptible.has(c.id)) { out.push(c); continue; }
        let over = false;
        for (let t = c.start; t < c.end && !over; t++) if (load[c.site][t] > capAt(c.site, t)) over = true;
        if (over) { for (let t = c.start; t < c.end; t++) load[c.site][t] -= 1; (preempted.get(s.id) || preempted.set(s.id, []).get(s.id)).push(c); }
        else out.push(c);
      }
      kept.set(s.id, out);
    }
  }
  const bySat = groupBy(cand, 'sat');
  const ready = outage.start + lead;
  const room = (c) => { for (let t = c.start; t < c.end; t++) if (load[c.site][t] + 1 > capAt(c.site, t)) return false; return true; };
  for (const s of plan.order) {
    const fixed = [...kept.get(s.id), ...(activated.get(s.id) || [])];
    const hurt = lost.get(s.id).length || (preempted.get(s.id) || []).length;
    if (!hurt || maxGap(fixed, H, HE) <= s.sla + 1e-9) { rebooked.set(s.id, []); continue; }
    const used = new Set([...(plan.plan.get(s.id) || []), ...(activated.get(s.id) || [])].map((c) => c.id));
    const opts = (bySat.get(s.id) || []).filter((c) => !used.has(c.id) && c.start >= ready);
    const { picked } = gapCover(fixed, opts, s.sla, H, room, HE);
    for (const c of picked) for (let t = c.start; t < c.end; t++) load[c.site][t] += 1;
    rebooked.set(s.id, picked);
  }
  const perSat = new Map();
  for (const s of sats) {
    const act = activated.get(s.id) || [], reb = rebooked.get(s.id) || [];
    const nominal = maxGap(plan.plan.get(s.id) || [], H, HE);
    const g = maxGap([...kept.get(s.id), ...act, ...reb], H, HE);
    // a breach is a new SLA violation caused by the outage (not one that already existed nominally)
    perSat.set(s.id, { gap: g, nominal, breach: g > s.sla + 1e-9 && g > nominal + 1e-9, activated: act, rebooked: reb, preempted: preempted.get(s.id) || [], lost: lost.get(s.id), lostCount: lost.get(s.id).length });
  }
  return { perSat, load };
}

// Full analysis bundle used by the page and the tests.
export function analyze(data, opts = {}) {
  const inst = buildInstance(data, opts);
  return { inst, shared: buildPlan(inst, { mode: 'shared' }), dedicated: buildPlan(inst, { mode: 'dedicated' }), none: buildPlan(inst, { mode: 'none' }) };
}

// Monte Carlo over random single-site outages (same draws for both strategies).
// protected = shared plan + 'protected' strategy; reactive = no-reserve plan + 'reactive' strategy.
export function monteCarlo(inst, sharedPlan, nonePlan, { n = 300, seed = 7, minDur = 60, maxDur = 720, lead = 15 } = {}) {
  const rnd = mulberry32(seed);
  const tiers = { prot: inst.sats.filter((s) => s.prio <= 1), std: inst.sats.filter((s) => s.prio > 1) };
  const acc = { n, prot: { p: 0, r: 0 }, std: { p: 0, r: 0 }, affected: 0, events: [] };
  for (let i = 0; i < n; i++) {
    const site = Math.floor(rnd() * inst.sites.length);
    const dur = Math.round(minDur + rnd() * (maxDur - minDur));
    const start = Math.floor(rnd() * (inst.H - 30));
    const outage = { site, start, end: Math.min(inst.HE, start + dur) };
    const A = simulateOutage(inst, sharedPlan, outage, { strategy: 'protected', lead });
    const Z = simulateOutage(inst, nonePlan, outage, { strategy: 'reactive', lead });
    const ev = { outage, prot: [0, 0], std: [0, 0] };
    for (const [key, list] of Object.entries(tiers)) for (const s of list) {
      if (A.perSat.get(s.id).breach) { acc[key].p++; ev[key][0]++; }
      if (Z.perSat.get(s.id).breach) { acc[key].r++; ev[key][1]++; }
      if (key === 'prot' && A.perSat.get(s.id).lostCount) acc.affected++;
    }
    acc.events.push(ev);
  }
  return acc;
}
