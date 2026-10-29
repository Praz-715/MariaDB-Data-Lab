// Prints estimated row counts and storage for each preset (or a JSON config file).
// Usage: node scripts/estimate.js [config.json]
import fs from 'node:fs';
import { normalizeConfig, estimate, PRESETS } from '../server/generators/plan.js';

const fmt = (n) => n.toLocaleString('en-US');

function show(name, cfg) {
  const t0 = performance.now();
  const e = estimate(cfg);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`\n${name}: ${fmt(e.totalRows)} rows, ~${(e.estimatedBytes / 1024 ** 2).toFixed(0)} MiB (estimated in ${ms} ms)`);
  for (const [t, n] of Object.entries(e.rows)) console.log(`  ${t.padEnd(26)} ${fmt(n).padStart(12)}`);
}

if (process.argv[2]) {
  show(process.argv[2], normalizeConfig(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), { maxWorkers: 64 }));
} else {
  for (const key of Object.keys(PRESETS)) show(key, normalizeConfig({ preset: key }, { maxWorkers: 64 }));
}
