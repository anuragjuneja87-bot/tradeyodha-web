'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,
  '../analysis/amd-live-tape-v1/zone-tape.js'), 'utf8'), context);
const {inspect} = context.TRADEYODHA_ZONE_TAPE;

const start = Date.UTC(2026, 9, 23, 13, 30);
const bucket = (offset, levels, o, c, quoteAgeMs = 100) => ({
  stampMs: start + offset * 30_000, complete: true,
  priceLevels: levels, litShares: levels.reduce((n, row) => n + row[1], 0),
  buy: levels.reduce((n, row) => n + row[2], 0),
  sell: levels.reduce((n, row) => n + row[3], 0),
  o, c, ofi: 0.1, quoteAgeMs, quoteUpdates: 4,
});
const rows = [
  bucket(0, [[10000, 20, 15, 3], [10100, 30, 2, 25]], 99, 101),
  bucket(1, [[10000, 40, 4, 32], [10200, 20, 18, 1]], 101, 102),
];
const zone = {startMs: start, endMs: start + 60_000, lowCents: 10000, highCents: 10000};
const result = inspect(rows, zone, zone.endMs);
assert.equal(result.status, 'available');
assert.deepEqual([result.buy, result.sell, result.unknown, result.delta], [19, 35, 6, -16]);
assert.equal(result.fullWindowPriceMove, 3, 'Price must use the full-market candles');
assert.deepEqual(Array.from(result.series, row => row.delta), [12, -28]);
assert.deepEqual(Array.from(result.series, row => row.priceClose), [101, 102]);
assert.deepEqual(Array.from(result.topPrices, row => row.cents), [10000]);
assert.equal(inspect(rows, zone, zone.endMs - 1).status, 'insufficient',
  'A replay cursor before the completed boundary must not reveal the last bucket');

const missing = inspect(rows.slice(0, 1), zone, zone.endMs);
assert.equal(missing.status, 'partial');
assert.equal(missing.series[1].gap, true);
assert.equal(missing.fullWindowPriceMove, null);
assert.equal(missing.observedBucketCount, 1);

const minute = inspect(rows, zone, zone.endMs, {intervalMs: 60_000, referenceBars: [{
  stampMs: start, complete: true, o: 99, c: 102, litShares: 110, buy: 39, sell: 61,
}]});
assert.equal(minute.status, 'available');
assert.equal(minute.series[0].delta, -16, 'In-zone delta must remain price filtered');
assert.equal(minute.series[0].priceClose, 102);
const mismatched = inspect(rows, zone, zone.endMs, {intervalMs: 60_000, referenceBars: [{
  stampMs: start, complete: true, o: 99, c: 102, litShares: 111, buy: 39, sell: 61,
}]});
assert.equal(mismatched.status, 'partial', 'Unreconciled chart candle must show a gap');
assert.equal(mismatched.series[0].gap, true);

const staleQuotes = inspect(rows.map(row => ({...row, quoteAgeMs: 5000})), zone, zone.endMs);
assert.match(staleQuotes.quoteContext.warning, /lack fresh usable quote context/);
console.log('Zone tape: price filtering, complete-boundary, gap, reconciliation and quote-quality checks passed');
