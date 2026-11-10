import * as C from './core/protect.js';

const $ = (s) => document.querySelector(s);
const fmtH = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return m ? `${h} h ${String(m).padStart(2, '0')} m` : `${h} h`; };
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;
const bh = (load) => C.beamMinutes(load) / 60;
const N_OUTAGES = 500, LEAD = 15;

const data = await (await fetch('data/network.json')).json();
const A = C.analyze(data);
const { inst, shared, dedicated, none } = A;
const satById = new Map(inst.sats.map((s) => [s.id, s]));
const protSats = inst.sats.filter((s) => s.prio <= 1);
const certified = protSats.filter((s) => shared.status.get(s.id).protected);
const certSet = new Set(certified.map((s) => s.id));

// ---------- Monte Carlo over random single-site outages (same draws for every policy) ----------
const policies = [
  { key: 'today', name: 'Plan at the SLA, reactive rebooking after the outage (today\u2019s pattern)', plan: none, strategy: 'reactive' },
  { key: 'tight', name: 'Protection-aware plan, reactive rebooking', plan: shared, strategy: 'reactive' },
  { key: 'ded', name: 'Protection-aware plan + dedicated backups per satellite', plan: dedicated, strategy: 'protected' },
  { key: 'shared', name: 'Protection-aware plan + shared reserve (Protected passes)', plan: shared, strategy: 'protected' },
];
const mc = Object.fromEntries(policies.map((p) => [p.key, { breaches: 0, preempted: 0, maxPre: 0 }]));
const rnd = C.mulberry32(7);
for (let i = 0; i < N_OUTAGES; i++) {
  const site = Math.floor(rnd() * inst.sites.length), start = Math.floor(rnd() * inst.H), dur = 30 + Math.floor(rnd() * 1410);
  const o = { site, start, end: Math.min(inst.HE, start + dur) };
  for (const p of policies) {
    const r = C.simulateOutage(inst, p.plan, o, { strategy: p.strategy, lead: LEAD });
    let pre = 0;
    for (const s of inst.sats) { const v = r.perSat.get(s.id); if (certSet.has(s.id) && v.breach) mc[p.key].breaches++; pre += v.preempted.length; }
    mc[p.key].preempted += pre; mc[p.key].maxPre = Math.max(mc[p.key].maxPre, pre);
  }
}

// ---------- header copy + KPIs ----------
const totalBeamH = inst.sites.reduce((s, x) => s + x.beams * 24, 0);
const resH = bh(shared.R.map((a) => a.subarray(0, inst.H)));
const dedH = bh(dedicated.R.map((a) => a.subarray(0, inst.H)));
const preCount = [...shared.preemptible].filter((id) => inst.cand[id].start < inst.H).length;
$('#eyebrow').textContent = `Protection · ${data.epochUtc.slice(0, 10)} · ${inst.sats.length} satellites · ${inst.sites.length} sites`;
$('#lede').innerHTML = `<b>${certified.length} of ${protSats.length}</b> protected satellites are certified: each keeps its max-gap SLA through any single-site outage that starts at any minute of the day. Backups are pre-validated passes at other sites. Their beams are shared across failure scenarios and lent to Standard traffic as preemptible capacity until a site actually fails.`;
$('#kpis').innerHTML = `
  <div class="kpi"><div class="v">${certified.length}<small>/ ${protSats.length} satellites</small></div>
    <div class="l"><span class="tag">Certified</span>${protSats.length - certified.length} need a longer SLA on this network (quotes below)</div></div>
  <div class="kpi"><div class="v">${mc.shared.breaches}<small>vs ${mc.today.breaches.toLocaleString()} reactive</small></div>
    <div class="l">SLA breaches on certified satellites across ${N_OUTAGES} simulated single-site outages</div></div>
  <div class="kpi"><div class="v">${resH.toFixed(1)}<small>beam-h reserved</small></div>
    <div class="l">${(100 * resH / totalBeamH).toFixed(1)}% of network beam-hours; dedicated per-satellite backups would hold ${dedH.toFixed(1)}</div></div>
  <div class="kpi"><div class="v">${preCount}<small>passes on reserve</small></div>
    <div class="l">Standard passes riding reserved beams as preemptible; worst simulated outage preempts ${mc.shared.maxPre}</div></div>`;

// ---------- mission table ----------
const missionRows = data.missions.filter((m) => !m.tier.startsWith('Standard')).map((m) => {
  const sats = protSats.filter((s) => s.mission === m.id);
  const cert = sats.filter((s) => certSet.has(s.id)).length;
  const worst = Math.max(...sats.map((s) => shared.margin.get(s.id).n1));
  const margins = sats.map((s) => shared.margin.get(s.id).margin);
  return { m, n: sats.length, cert, worst, mMin: Math.min(...margins), mMax: Math.max(...margins) };
});
let selMission = null;
$('#missions tbody').innerHTML = missionRows.map((r) => `
  <tr data-m="${r.m.id}">
    <td>${r.m.name}</td>
    <td><span class="pill ${r.m.tier.includes('Gov') ? 'gov' : ''}">${r.m.tier.replace('Protected · ', '')}</span></td>
    <td class="r">${fmtH(r.m.slaMin)}</td>
    <td class="r ${r.cert === r.n ? 'ok' : 'warn'}">${r.cert} / ${r.n}</td>
    <td class="r ${r.worst <= r.m.slaMin ? '' : 'warn'}">${fmtH(r.worst)}</td>
    <td class="r">${r.mMin === r.mMax ? `${r.mMin} min` : `${r.mMin}\u2013${r.mMax} min`}</td>
  </tr>`).join('');
document.querySelectorAll('#missions tbody tr').forEach((tr) => tr.addEventListener('click', () => {
  selMission = selMission === tr.dataset.m ? null : tr.dataset.m;
  document.querySelectorAll('#missions tbody tr').forEach((x) => x.classList.toggle('sel', x.dataset.m === selMission));
  render();
}));

// ---------- ablation + quotes ----------
const preH = (p) => bh(p.plan.P.map((a) => a.subarray(0, inst.H)));
$('#ablation tbody').innerHTML = policies.map((p) => `
  <tr><td>${p.name}</td><td class="r">${mc[p.key].breaches.toLocaleString()}</td><td class="r">${preH(p).toFixed(1)}</td>
  <td class="r">${p.strategy === 'reactive' ? '0' : bh(p.plan.R.map((a) => a.subarray(0, inst.H))).toFixed(1)}</td><td class="r">${mc[p.key].preempted}</td></tr>`).join('');
const tightGain = mc.today.breaches - mc.tight.breaches;
$('#ablation-note').innerHTML = `Same ${N_OUTAGES} random outages (any site, any start, 30 min to a full day, ${LEAD}-minute notice) replayed under four policies. The biggest step is planning: farthest-reach scheduling packs passes right at the SLA limit, which leaves nothing to recover with, so certified satellites are planned with the smallest margin that keeps them survivable (${tightGain.toLocaleString()} fewer breaches). Reactive rebooking on that plan still loses ${mc.tight.breaches}: by the time it looks, the free beams or the next usable passes are gone. The reserve closes that gap and turns \u201cusually recovers\u201d into a check you can put in an SLA. Sharing the reserve across failure scenarios holds ${(dedH - resH).toFixed(1)} fewer beam-hours than per-satellite backups on this load.`;
const quotes = protSats.filter((s) => !certSet.has(s.id)).map((s) => {
  const st = shared.status.get(s.id), mg = shared.margin.get(s.id);
  const crit = Object.entries(st.residual).sort((a, b) => b[1] - a[1])[0];
  const q = Math.ceil(mg.n1 / 15) * 15;
  return `<div class="q"><b>${s.id}</b><span>Contracted ${fmtH(s.sla)} \u00b7 certifiable at <b class="n">${fmtH(q)}</b> \u00b7 binding failure ${inst.sites[+crit[0]].id} ${inst.sites[+crit[0]].name}</span></div>`;
});
$('#quotes').innerHTML = `<p class="eyebrow" style="margin:34px 0 8px">SLA quotes for uncertified satellites</p>${quotes.join('')}`;
const day = (a) => a.subarray(0, inst.H);
const sum = (a) => a.reduce((x, v) => x + v, 0) / 60;
$('#bysite tbody').innerHTML = inst.sites.map((st, j) => {
  const onRes = [...shared.preemptible].filter((id) => inst.cand[id].site === j && inst.cand[id].start < inst.H).length;
  return `<tr><td><b class="sid">${st.id}</b> ${st.name}</td><td class="r">${st.beams}</td><td class="r">${sum(day(shared.P[j])).toFixed(1)}</td><td class="r">${sum(day(shared.R[j])).toFixed(1)}</td><td class="r">${sum(day(dedicated.R[j])).toFixed(1)}</td><td class="r">${onRes}</td></tr>`;
}).join('');

// ---------- outage replay ----------
let outage = null;
{ // default: the outage that hurts today's reactive pattern the most
  let best = null;
  for (let k = 0; k < inst.sites.length; k++) for (let s0 = 0; s0 < inst.H; s0 += 60) {
    const o = { site: k, start: s0, end: inst.HE };
    const z = C.simulateOutage(inst, none, o, { strategy: 'reactive', lead: LEAD });
    const b = certified.filter((s) => z.perSat.get(s.id).breach).length;
    if (!best || b > best.b) best = { o, b };
  }
  outage = best.o;
}
$('#sites').innerHTML = inst.sites.map((s, j) => `<div class="site" data-j="${j}"><div class="id">${s.id}</div><div class="nm">${s.name}</div></div>`).join('');
document.querySelectorAll('.site').forEach((el) => el.addEventListener('click', () => { outage.site = +el.dataset.j; render(); }));
$('#start').value = outage.start;
$('#start').addEventListener('input', (e) => { outage.start = +e.target.value; render(); });
$('#dur').addEventListener('change', () => render());

function lanes(items) {
  const ends = [];
  for (const it of items.sort((a, b) => a.start - b.start || b.end - a.end)) {
    let l = ends.findIndex((e) => e <= it.start);
    if (l < 0) { l = ends.length; ends.push(0); }
    ends[l] = it.end; it.lane = l;
  }
  return ends.length;
}

function render() {
  const dur = +$('#dur').value;
  outage.end = Math.min(inst.HE, outage.start + dur);
  $('#startLbl').textContent = hhmm(outage.start);
  document.querySelectorAll('.site').forEach((el) => el.classList.toggle('on', +el.dataset.j === outage.site));
  const site = inst.sites[outage.site];
  $('#replay-title').textContent = `${site.id} ${site.name} goes dark at ${hhmm(outage.start)}${dur >= 99999 ? ' for the rest of the day' : ` for ${fmtH(dur)}`}`;

  const P = C.simulateOutage(inst, shared, outage, { strategy: 'protected', lead: LEAD });
  const Z = C.simulateOutage(inst, none, outage, { strategy: 'reactive', lead: LEAD });

  // build items per site
  const rows = inst.sites.map(() => []);
  const lostIds = new Set(), cutIds = new Set();
  for (const s of inst.sats) {
    const v = P.perSat.get(s.id);
    v.lost.forEach((c) => lostIds.add(c.id));
    v.preempted.forEach((c) => cutIds.add(c.id));
  }
  for (const s of inst.sats) {
    const v = P.perSat.get(s.id);
    for (const c of shared.plan.get(s.id)) {
      if (c.start >= inst.H) continue;
      const kind = lostIds.has(c.id) ? 'lost' : cutIds.has(c.id) ? 'cut' : shared.preemptible.has(c.id) ? 'pre' : 'prim';
      rows[c.site].push({ ...c, kind, mission: s.mission });
    }
    for (const c of v.activated) if (c.start < inst.H) rows[c.site].push({ ...c, kind: 'bk', mission: s.mission });
    for (const c of v.rebooked) if (c.start < inst.H) rows[c.site].push({ ...c, kind: 'reb', mission: s.mission });
  }
  const W = $('#gantt').clientWidth - 100, LW = 78, PW = W - LW, laneH = 7, gap = 2;
  const x = (t) => LW + (t / inst.H) * PW;
  let y = 22, svg = '';
  let axis = '';
  for (let h = 0; h <= 24; h += 3) axis += `<text class="ax" x="${x(h * 60)}" y="11" text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}">${String(h).padStart(2, '0')}:00</text><line x1="${x(h * 60)}" x2="${x(h * 60)}" y1="16" y2="GRIDEND" stroke="rgba(241,241,241,.09)"/>`;
  const fill = { prim: 'rgba(241,241,241,.62)', pre: 'none', lost: '#bc3333', bk: '#d0f6ae', reb: 'none', cut: 'none' };
  const stroke = { prim: 'none', pre: 'rgba(241,241,241,.8)', lost: 'none', bk: 'none', reb: '#d0f6ae', cut: '#ff8a80' };
  inst.sites.forEach((st, j) => {
    const n = Math.max(st.beams, lanes(rows[j]));
    const h = n * (laneH + gap) + 6;
    if (j === outage.site) svg += `<rect x="${x(outage.start)}" y="${y - 3}" width="${Math.max(2, x(Math.min(inst.H, outage.end)) - x(outage.start))}" height="${h}" fill="rgba(188,51,51,.22)"/>`;
    svg += `<text class="rl" x="0" y="${y + 8}">${st.id}</text><text class="rb" x="0" y="${y + 21}">${st.beams} beams</text>`;
    svg += `<line x1="${LW}" x2="${LW + PW}" y1="${y + h - 3}" y2="${y + h - 3}" stroke="rgba(241,241,241,.16)"/>`;
    for (const it of rows[j]) {
      const bx = x(it.start), bw = Math.max(2.2, x(Math.min(it.end, inst.H)) - bx), by = y + it.lane * (laneH + gap);
      const hl = selMission && it.mission === selMission ? ' hl' : '';
      const dash = it.kind === 'pre' ? ' stroke-dasharray="2 1.5"' : '';
      svg += `<rect class="bar${hl}" data-t="${it.sat}|${st.id}|${hhmm(it.start)}\u2013${hhmm(it.end)}|${it.kind}" x="${bx.toFixed(1)}" y="${by}" width="${bw.toFixed(1)}" height="${laneH}" fill="${fill[it.kind]}" stroke="${stroke[it.kind]}" stroke-width="1"${dash}/>`;
    }
    y += h + 8;
  });
  $('#gantt').innerHTML = `<svg viewBox="0 0 ${W} ${y}" height="${y}" class="${selMission ? 'dim' : ''}">${axis.replaceAll('GRIDEND', y - 8)}${svg}</svg>`;
  wireTips();

  const tally = (R) => {
    const o = { lostP: 0, lostS: 0, hurt: 0, act: 0, rebP: 0, rebS: 0, pre: 0, breached: [] };
    for (const s of inst.sats) {
      const v = R.perSat.get(s.id), p = s.prio <= 1;
      if (p) { o.lostP += v.lostCount; o.rebP += v.rebooked.length; if (v.lostCount) o.hurt++; } else { o.lostS += v.lostCount; o.rebS += v.rebooked.length; }
      o.act += v.activated.length; o.pre += v.preempted.length;
      if (certSet.has(s.id) && v.breach) o.breached.push(`${s.id} (${fmtH(v.gap)} vs ${fmtH(s.sla)})`);
    }
    return o;
  };
  const a = tally(P), z = tally(Z);
  $('#cmp').innerHTML = `
    <div><p class="t">Protected passes</p><p class="n ${a.breached.length ? 'bad' : 'good'}">${a.breached.length} breaches</p>
      <p class="d">${a.lostP} protected passes lost across ${a.hurt} satellites. ${a.act} reserved backups activated at once, ${a.rebP} more rebooked; ${a.pre} Standard passes preempted.</p></div>
    <div><p class="t">Reactive rebooking (today)</p><p class="n ${z.breached.length ? 'bad' : 'good'}">${z.breached.length} breaches</p>
      <p class="d">${z.lostP} protected passes lost. ${z.rebP} rebooked into free beams after ${LEAD} min notice.${z.breached.length ? ` Still over SLA: ${z.breached.slice(0, 3).join(', ')}${z.breached.length > 3 ? ` and ${z.breached.length - 3} more` : ''}.` : ''}</p></div>`;
}

function wireTips() {
  const tip = $('#tip');
  const names = { prim: 'Booked pass', pre: 'Preemptible pass on reserved beam', lost: 'Lost to outage', bk: 'Backup activated', reb: 'Rebooked after outage', cut: 'Preempted for a backup' };
  document.querySelectorAll('#gantt .bar').forEach((el) => {
    el.addEventListener('mousemove', (e) => {
      const [sat, site, t, k] = el.dataset.t.split('|');
      const s = satById.get(sat);
      tip.innerHTML = `<b>${sat}</b> · ${data.missions.find((m) => m.id === s.mission).name}<br>${site} · ${t} UTC · ${names[k]}`;
      tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 12}px`; tip.style.opacity = 1;
    });
    el.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
  });
}

render();
window.addEventListener('resize', render);
