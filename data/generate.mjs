// Seeded generator for the synthetic network (sites, missions, orbital elements).
// node data/generate.mjs  -> writes data/network.json
// Everything shown on the page (passes, plan, reserves, outage results) is computed from this file
// in the browser by core/protect.js. Nothing downstream is hard-coded.
import { writeFileSync } from 'node:fs';
import { mulberry32 } from '../core/protect.js';

export function generate(seed = 20261112) {
  const rnd = mulberry32(seed);
  const jit = (x, d) => +(x + (rnd() * 2 - 1) * d).toFixed(3);
  const RE = 6378.137;
  // Synthetic site locations (NOT Northwood's real sites): four in North America, two in Australia,
  // matching the public "six sites on two continents" shape only.
  const sites = [
    { id: 'NA-01', name: 'Mojave', region: 'California, US', lat: 35.05, lon: -117.6, beams: 3, mask: 10 },
    { id: 'NA-02', name: 'Permian', region: 'Texas, US', lat: 31.3, lon: -103.2, beams: 3, mask: 10 },
    { id: 'NA-03', name: 'Prairie', region: 'North Dakota, US', lat: 47.6, lon: -100.9, beams: 2, mask: 10 },
    { id: 'NA-04', name: 'Tanana', region: 'Alaska, US', lat: 64.8, lon: -147.6, beams: 4, mask: 10 },
    { id: 'AU-01', name: 'Wheatbelt', region: 'Western Australia', lat: -31.2, lon: 117.1, beams: 3, mask: 10 },
    { id: 'AU-02', name: 'Red Centre', region: 'Northern Territory, AU', lat: -23.8, lon: 133.7, beams: 2, mask: 10 },
  ];
  // Fictional operators. Orbits are typical of each mission type.
  const specs = [
    { id: 'GOV', name: 'USG TT&C Pathfinder', tier: 'Protected · Gov', slaMin: 600, minC: 4, maxC: 10, alt: 700, inc: 70, planes: 3, perPlane: 2 },
    { id: 'GEO', name: 'Atlas GEO Comsat', tier: 'Protected · Gov', slaMin: 120, minC: 10, maxC: 15, alt: 35786, inc: 0.05, planes: 1, perPlane: 3, geo: [-105, -80, 128] },
    { id: 'KST', name: 'Kestrel SAR', tier: 'Protected', slaMin: 600, minC: 4, maxC: 10, alt: 525, inc: 97.5, planes: 3, perPlane: 4 },
    { id: 'TRN', name: 'Tern Weather', tier: 'Protected', slaMin: 660, minC: 4, maxC: 12, alt: 820, inc: 98.7, planes: 2, perPlane: 3 },
    { id: 'LYR', name: 'Lyra MEO Relay', tier: 'Protected', slaMin: 360, minC: 10, maxC: 20, alt: 8000, inc: 55, planes: 3, perPlane: 2 },
    { id: 'OTV', name: 'Skiff Orbital Transfer', tier: 'Protected', slaMin: 720, minC: 3, maxC: 8, alt: 450, inc: 70, planes: 1, perPlane: 3 },
    { id: 'HAL', name: 'Halcyon EO', tier: 'Standard', slaMin: 480, minC: 4, maxC: 10, alt: 505, inc: 97.4, planes: 6, perPlane: 6 },
    { id: 'MRD', name: 'Meridian IoT', tier: 'Standard', slaMin: 720, minC: 4, maxC: 8, alt: 550, inc: 53, planes: 4, perPlane: 6 },
    { id: 'PKA', name: 'Pika Rideshare Fleet', tier: 'Standard', slaMin: 600, minC: 4, maxC: 8, alt: 510, inc: 97.6, planes: 16, perPlane: 4 },
  ];
  const epochGmstDeg = +(rnd() * 360).toFixed(4);
  const missions = specs.map((m) => {
    const sats = [];
    const raan0 = rnd() * 360;
    for (let p = 0; p < m.planes; p++) for (let q = 0; q < m.perPlane; q++) {
      let el;
      if (m.geo) {
        // GEO slots over each continent: the sub-satellite longitude fixes RAAN+M relative to GMST
        const lon = m.geo[q];
        el = { a: RE + m.alt, e: 0, i: m.inc, raan: 0, argp: 0, m0: +(((lon + epochGmstDeg) % 360 + 360) % 360).toFixed(4) };
      } else {
        el = {
          a: +(RE + jit(m.alt, 6)).toFixed(3), e: +(rnd() * 0.0012).toFixed(5), i: jit(m.inc, 0.08),
          raan: +((raan0 + (p * 360) / m.planes + (m.inc > 90 ? 0 : p * 7)) % 360).toFixed(3),
          argp: +(rnd() * 360).toFixed(3),
          m0: +(((q * 360) / m.perPlane + p * 23 + rnd() * 8) % 360).toFixed(3),
        };
      }
      sats.push({ id: `${m.id}-${String(p * m.perPlane + q + 1).padStart(2, '0')}`, el });
    }
    return { id: m.id, name: m.name, tier: m.tier, slaMin: m.slaMin, minContactMin: m.minC, maxContactMin: m.maxC, sats };
  });
  return { seed, epochUtc: '2026-11-12T00:00:00Z', epochGmstDeg, horizonMin: 1440, lookaheadMin: 720, sites, missions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('./network.json', import.meta.url);
  writeFileSync(out, JSON.stringify(generate(), null, 1));
  console.log('wrote', out.pathname);
}
