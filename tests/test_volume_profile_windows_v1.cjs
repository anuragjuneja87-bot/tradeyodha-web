const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'../analysis/amd-live-tape-v1');
const context={window:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'analytics.js'),'utf8'),context);
const profile=context.window.TRADEYODHA_VOLUME_PROFILE;
const clock=minute=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
const rows=Array.from({length:121},(_,index)=>({
  t:clock(510+index),litShares:100+index,offExchangeShares:20,
  buy:40+index,sell:30
}));

const at832=profile.marketHalfHours(rows,'08:32');
assert.equal(at832[0].state,'forming');
assert.equal(at832[0].observed,2);
assert.equal(at832[0].recorded,241);
assert.equal(at832[0].buy,81);
assert.equal(at832[1].state,'waiting');

const at900=profile.marketHalfHours(rows,'09:00');
assert.equal(at900[0].state,'complete');
assert.equal(at900[0].observed,30);
assert.equal(at900[1].state,'waiting','09:00 belongs to the next window');
assert.equal(at900[0].recorded,profile.summarize(rows,'09:00').market.recorded);

const at1030=profile.marketHalfHours(rows,'10:30');
assert(at1030.every(bucket=>bucket.state==='complete'));
assert.equal(at1030.reduce((sum,bucket)=>sum+bucket.recorded,0),
  profile.summarize(rows,'10:30').market.recorded);
assert.equal(at1030[3].endCt,'10:30');
assert.equal(profile.marketHalfHours(rows,'11:00')[3].recorded,at1030[3].recorded,
  'Later trades do not enter the fixed four windows');

const missing=profile.marketHalfHours(rows.filter(row=>row.t!=='09:17'),'09:30')[1];
assert.equal(missing.state,'incomplete');
assert.equal(missing.observed,29);
assert.equal(profile.marketHalfHours([...rows,rows[0]],'09:00')[0].state,'unavailable',
  'Duplicate minutes cannot be counted twice');
assert.equal(profile.marketHalfHours(null,'09:00')[0].state,'unavailable');

const archived=JSON.parse(fs.readFileSync(path.join(root,'replay/2026-10-13.json'),'utf8')).bars.AMD;
const replay=profile.marketHalfHours(archived,'09:31');
assert.equal(replay[0].state,'complete');
assert.equal(replay[1].state,'complete');
assert.equal(replay[2].state,'forming');
assert.equal(replay[3].state,'waiting');
assert.equal(replay.reduce((sum,bucket)=>sum+bucket.recorded,0),
  profile.summarize(archived,'09:31').market.recorded);
console.log('volume profile windows: pass');
