const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..', 'analysis', 'amd-live-tape-v1');
const context = {window:{}};
vm.createContext(context);
for (const name of ['history-windows.js', 'analytics.js'])
  vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);

const demo = JSON.parse(fs.readFileSync(path.join(root, 'demo-2026-10-06.json'), 'utf8'));
const bars = demo.bars.AMD.filter(row => row.t <= '08:57');
const analyze = context.window.AMD_TAPE_ANALYTICS.analyze;
const library = context.window.AMD_ANALYTICS_HISTORY;
const result = analyze(bars, '2026-10-06', 5, library);
assert.equal(result.current.end, '08:57');
assert.equal(result.current.buy, 105633);
assert.equal(result.current.sell, 53304);
assert(result.peers > 100);
assert(result.analogs.every(row => row[0] < '2026-10-06'));

const noPrior = analyze(bars, '2026-08-24', 5, library);
assert.match(noPrior.reason, /prior comparable sessions/);
const missingMinute = bars.filter(row => row.t !== '08:55');
assert.match(analyze(missingMinute, '2026-10-06', 5, library).reason, /Minute gap/);
const thinCoverage = bars.map(row => ({...row, coveragePct:0}));
assert.match(analyze(thinCoverage, '2026-10-06', 5, library).reason, /coverage is too thin/);
const afterArchiveHours = [...bars, {...bars.at(-1), t:'11:00'}];
assert.match(analyze(afterArchiveHours, '2026-10-06', 5, library).reason, /08:30–11:00/);
console.log('AMD analytics: real replay totals, causal history, gap and coverage guards passed');
