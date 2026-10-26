const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..', 'analysis', 'amd-live-tape-v1');
const context = {window:{}};
vm.createContext(context);
for (const name of ['history-windows.js', 'short-history-windows.js', 'half-history-windows.js', 'analytics.js'])
  vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);

const demo = JSON.parse(fs.readFileSync(path.join(root, 'demo-2026-10-06.json'), 'utf8'));
const bars = demo.bars.AMD.filter(row => row.t <= '08:57');
const analyze = context.window.AMD_TAPE_ANALYTICS.analyze;
const library = context.window.AMD_ANALYTICS_HISTORY;
const shortLibrary = context.window.AMD_SHORT_ANALYTICS_HISTORY;
const rollingScore = context.window.AMD_TAPE_ANALYTICS.rollingPressureScore;
const expandedScore = context.window.AMD_TAPE_ANALYTICS.expandedFlowScore;
const microCase = {buy:6000,sell:4000,depthOfi:.12,bidReplenishment:1500,bidDepletion:500,
  buySweepShares:2000,sellSweepShares:0,sellRun:300,impact:-10,continuation:12,matured:1};
const expanded = expandedScore({score:40,price:1,referenceDays:30,state:'aligned'},microCase);
assert(expanded && expanded.score > 40 && expanded.score <= 100);
assert.equal(expanded.components.reduce((sum,item)=>sum+item.weight,0), 1);
assert.equal(expanded.availableWeight, 1);
assert.equal(expandedScore(null,microCase), null);
assert.equal(expandedScore({score:40,price:1,referenceDays:30,state:'aligned'},
  {...microCase,depthOfi:null}), null, 'Missing raw quote depth suppresses expanded score');
const immature = expandedScore({score:40,price:1,referenceDays:30,state:'aligned'},
  {...microCase,matured:0,continuation:null});
assert(immature && immature.availableWeight < 1,
  'Sweep follow-through must not be credited before its confirming quote arrives');
assert(expandedScore({score:40,price:1,referenceDays:30,state:'aligned'},
  {...microCase,impact:null,matured:0,continuation:null}).availableWeight >= .65);
const halfBars = JSON.parse(fs.readFileSync(path.join(root, 'replay30', '2026-10-12.json'), 'utf8')).bars.AMD;
const halfRow = halfBars.find(row => row.t === '08:36:00');
const halfScore = context.window.AMD_TAPE_ANALYTICS.halfMinutePressureScore(
  halfBars, halfRow.stampMs, '2026-10-12', context.window.AMD_HALF_ANALYTICS_HISTORY);
assert(halfScore && Number.isFinite(halfScore.score) && halfScore.referenceDays >= 15);
assert.equal(context.window.AMD_TAPE_ANALYTICS.halfMinutePressureScore(
  halfBars, halfRow.stampMs + 15_000, '2026-10-12', context.window.AMD_HALF_ANALYTICS_HISTORY), null,
  'An unfinished half-minute has no score');
const endStamp = demo.bars.AMD.find(row=>row.t==='08:57').stampMs;
for (const width of [1, 2, 5, 15]) {
  const history = width < 5 ? shortLibrary : library;
  const scored = rollingScore(demo.bars.AMD, endStamp-(width-1)*60000,
    width, '2026-10-06', history);
  assert(scored && Number.isFinite(scored.score) && scored.lookback === width);
  assert(scored.score >= -100 && scored.score <= 100);
  assert(scored.referenceDays >= 15);
}
const noScore = rollingScore(demo.bars.AMD.filter(row=>row.t!=='08:56'),
  endStamp-60000, 2, '2026-10-06', shortLibrary);
assert.equal(noScore, null, 'A gap must suppress a two-minute score');
const openingStamp = demo.bars.AMD.find(row=>row.t==='08:30').stampMs;
assert(rollingScore(demo.bars.AMD, openingStamp, 1, '2026-10-06', shortLibrary));
assert.equal(rollingScore(demo.bars.AMD, openingStamp-4*60000, 5, '2026-10-06', library), null,
  'A score must not carry premarket minutes into the opening window');
assert.deepEqual(Array.from(shortLibrary.dates), JSON.parse(fs.readFileSync(path.join(root, 'replay-manifest.json'), 'utf8')).dates);
assert(shortLibrary.richWindows.filter(row => row[1] >= '08:25' && row[1] < '08:30').every(row => row[13] === null));
assert(shortLibrary.richWindows.filter(row => row[1] >= '10:55').every(row => row[13] === null));
for (const width of [1, 2]) {
  const short = context.window.AMD_TAPE_ANALYTICS.thesis(bars, '2026-10-06', width, shortLibrary);
  assert.equal(short.current.width, width);
  assert.equal(short.mode, 'AMD short-window detailed tape');
  assert(short.matches.length >= 3);
  assert(short.matches.every(match => match.date < '2026-10-06'));
}
const result = analyze(bars, '2026-10-06', 5, library);
const thesis = context.window.AMD_TAPE_ANALYTICS.thesis(bars, '2026-10-06', 5, library);
assert.equal(result.current.end, '08:57');
assert.equal(result.current.buy, 105633);
assert.equal(result.current.sell, 53304);
assert(result.peers > 100);
assert(result.analogs.every(row => row[0] < '2026-10-06'));
assert.equal(result.outcomes.length, 5);
assert.equal(new Set(result.outcomes.map(row => row.date)).size, 5);
const first = result.outcomes[0];
const stamp = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const asTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const matched = library.windows.find(row => row[0] === first.date && row[1] === first.time && row[2] === 5);
const future = library.windows.find(row => row[0] === first.date && row[1] === asTime(stamp(first.time) + 5) && row[2] === 5);
assert(matched && future, 'Archived follow-through windows must exist');
assert(Math.abs(first.next5 - 10000 * ((1 + future[8] / 10000) / (1 + matched[8] / 10000) - 1)) < 1e-9);
assert(result.outcomes.every(row => row.date < '2026-10-06'));
assert.equal(thesis.mode, 'AMD detailed tape');
assert(thesis.matches.length >= 3);
assert(thesis.matches.every(row => row.date < '2026-10-06'));
assert(thesis.thesis.headline.length > 0);
assert(!JSON.stringify(thesis).includes('AMDL'));
const richMatch = thesis.matches[0];
const archivedRich = library.richWindows.find(row => row[0] === richMatch.date && row[1] === richMatch.time && row[2] === 5);
assert(archivedRich);
assert.equal(richMatch.next5, archivedRich[13]);
assert.equal(richMatch.next15, archivedRich[14]);
assert(library.richWindows.filter(row => row[1] >= '08:25' && row[1] < '08:30').every(row => row[13] === null));
assert(library.richWindows.filter(row => row[1] >= '10:55').every(row => row[13] === null));
const changedLabels = {...library, richWindows: library.richWindows.map(row => {
  const changed = row.slice(); changed[13] = row[13] === null ? null : -row[13]; return changed;
})};
const sameInputs = context.window.AMD_TAPE_ANALYTICS.thesis(bars, '2026-10-06', 5, changedLabels);
assert.deepEqual(sameInputs.matches.map(row => `${row.date} ${row.time}`), thesis.matches.map(row => `${row.date} ${row.time}`));
const fallback = context.window.AMD_TAPE_ANALYTICS.thesis(bars, '2026-10-06', 5, {...library, richWindows:[]});
assert.equal(fallback.mode, 'AMD year');
assert(fallback.matches.every(row => row.date < '2026-10-06'));

const noPrior = analyze(bars, '2025-09-01', 5, library);
assert.match(noPrior.reason, /prior comparable sessions/);
const missingMinute = bars.filter(row => row.t !== '08:55');
assert.match(analyze(missingMinute, '2026-10-06', 5, library).reason, /Minute gap/);
const thinCoverage = bars.map(row => ({...row, coveragePct:0}));
assert.match(analyze(thinCoverage, '2026-10-06', 5, library).reason, /coverage is too thin/);
const afterArchiveHours = [...bars, {...bars.at(-1), t:'11:00'}];
assert.match(analyze(afterArchiveHours, '2026-10-06', 5, library).reason, /06:00–11:00/);
const premarketBars = demo.bars.AMD.filter(row => row.t < '08:00');
if (library.version >= 2) {
  const premarket = analyze(premarketBars, '2026-10-06', 5, library);
  assert.equal(premarket.premarket, true);
  assert(premarket.days >= 15);
  assert(premarket.analogs.every(row => row[0] < '2026-10-06' && row[1] < '08:30'));
  assert(Number.isFinite(premarket.current.sessionBps));
  assert(Number.isFinite(premarket.current.rangePosition));
  assert(premarket.outcomes.every(row => stamp(row.time) + 5 < 8 * 60 + 30));
}
console.log('AMD analytics: replay totals, AMD-only retrieval thesis, causal outcomes, gap and coverage guards passed');
