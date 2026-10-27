const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const context={window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,
  '../analysis/amd-live-tape-v1/replay-chart.js'),'utf8'),context);
const chart=context.window.TRADEYODHA_REPLAY_CHART;
assert.deepEqual({...chart.priceScaleMargins(0)},{top:.09,bottom:.09});
assert.ok(chart.priceScaleMargins(2).top>chart.priceScaleMargins(0).top);
assert.ok(chart.priceScaleMargins(-2).top<chart.priceScaleMargins(0).top);
assert.ok(chart.priceScaleMargins(100).top<.5);
const start=Date.UTC(2026,9,15,13,30);
const row=(offset,o,h,l,c)=>({stampMs:start+offset*30_000,o,h,l,c});
const tape=[
  row(0,100,101,99,100.5),row(1,100.5,102,100,101),
  row(2,101,102,100,101.5),row(3,101.5,103,101,102),
  row(4,102,104,102,103),row(5,103,105,102,104),
  row(6,104,104,98,99),row(7,99,101,98,100),
  row(8,100,102,99,101),row(9,101,103,100,102)
];
const one=chart.candles(tape,5,start+60_000,30_000);
assert.equal(one.length,1);
assert.deepEqual([one[0].o,one[0].h,one[0].l,one[0].c],[100,102,99,101]);
assert.equal(one[0].forming,true);
assert.equal(one[0].observed,2);
assert.equal(one[0].expected,10);
const full=chart.candles(tape,5,start+300_000,30_000);
assert.equal(full[0].complete,true);
assert.equal(full[0].c,102);
const missing=chart.candles(tape.filter(item=>item.stampMs!==start+30_000),5,
  start+300_000,30_000);
assert.equal(missing[0].complete,false);
assert.equal(missing[0].forming,false);
assert.equal(chart.candles(tape,.5,start+30_000,30_000).length,1);
const minute=[
  {stampMs:start,o:100,h:102,l:99,c:101},
  {stampMs:start+60_000,o:101,h:103,l:100,c:102},
  {stampMs:start+120_000,o:102,h:105,l:101,c:104},
  {stampMs:start+180_000,o:104,h:104,l:98,c:100},
  {stampMs:start+240_000,o:100,h:103,l:99,c:102}
];
const repaired=chart.candlesWithFallback(tape.filter(item=>item.stampMs!==start+30_000),
  minute,5,start+300_000);
assert.equal(repaired[0].complete,true);
assert.equal(repaired[0].sourceMs,60_000);
const pointInTime=chart.candlesWithFallback(tape,minute,5,start+60_000);
assert.equal(pointInTime[0].forming,true);
assert.equal(pointInTime[0].sourceMs,30_000);
assert.equal(pointInTime[0].h,102);
assert.equal(chart.candlesWithFallback(tape,minute,.5,start+30_000).length,1);
const volumeTape=[
  {...row(0,100,101,99,100.5),buy:70,sell:20,litShares:100},
  {...row(1,100.5,102,100,101),buy:10,sell:60,litShares:80}
];
const formingVolume=chart.candles(volumeTape,1,start+30_000,30_000)[0];
assert.deepEqual([formingVolume.buy,formingVolume.sell,formingVolume.unclassified,
  formingVolume.litShares,formingVolume.forming],[70,20,10,100,true]);
const completedVolume=chart.candles(volumeTape,1,start+60_000,30_000)[0];
assert.deepEqual([completedVolume.buy,completedVolume.sell,completedVolume.unclassified,
  completedVolume.litShares],[80,80,20,180]);
assert.equal(chart.candleDeltaClass(completedVolume),'delta-neutral');
assert.equal(chart.candleDeltaClass({...completedVolume,buy:90,sell:70}),'delta-positive');
assert.equal(chart.candleDeltaClass({...completedVolume,buy:70,sell:90}),'delta-negative');
assert.equal(chart.candleDeltaClass({...completedVolume,buy:90,sell:70,complete:false}),
  'delta-unavailable');
assert.equal(chart.candleDeltaClass({...completedVolume,buy:null}),'delta-unavailable');
assert.equal(chart.candleDeltaClass({...completedVolume,buy:190}),'delta-unavailable');
const prismRow={...completedVolume,complete:true,priceOnly:false,ofi:.25,
  quoteUpdates:4,quoteAgeMs:200,quoteUsableMinutes:1,medianSpreadCents:1.2};
const prism=chart.flowPrismStyle(prismRow,1,180);
assert.equal(prism.tier,'neutral');
assert.equal(prism.depth,1);
assert.equal(prism.ofi,'positive');
assert.equal(chart.flowPrismStyle({...prismRow,ofi:-.2},1,180).ofi,'negative');
assert.equal(chart.flowPrismStyle({...prismRow,ofi:null},1,180).ofi,null);
assert.equal(chart.flowPrismStyle({...prismRow,ofiEvidence:{valid:false}},1,180).ofi,null);
assert.equal(chart.flowPrismStyle({...prismRow,quoteAgeMs:2001},1,180).ofi,null);
assert.equal(chart.flowPrismStyle({...prismRow,quoteUpdates:2},1,180).ofi,null);
assert.equal(chart.flowPrismStyle({...prismRow,complete:false},1,180).depth,null);
assert.equal(chart.flowPrismStyle({...prismRow,priceOnly:true},1,180).depth,null);
assert.equal(chart.flowPrismStyle({...prismRow,litShares:null},1,180).depth,null);
const colorRow=(priceUp,buy,sell,quality=true)=>({...prismRow,o:100,
  c:priceUp?101:99,buy,sell,litShares:buy+sell+100,
  deltaConstituentsValid:quality});
assert.equal(chart.candleBodyColor(colorRow(true,450,300),1),'#bed94e');
assert.equal(chart.candleBodyColor(colorRow(true,600,300),1),'#21d66e');
assert.equal(chart.candleBodyColor(colorRow(true,750,300),1),'#55caff');
assert.equal(chart.candleBodyColor(colorRow(true,900,300),1),'#f4fbff');
assert.equal(chart.candleBodyColor(colorRow(true,300,600),1),'#467fa0');
assert.equal(chart.candleBodyAppearance(colorRow(true,340,300),1).kind,'weak-flow');
assert.equal(chart.candleBodyColor(colorRow(false,300,450),1),'#9b772b');
assert.equal(chart.candleBodyColor(colorRow(false,300,600),1),'#f0444e');
assert.equal(chart.candleBodyColor(colorRow(false,300,750),1),'#ff8aa9');
assert.equal(chart.candleBodyColor(colorRow(false,300,900),1),'#ff8aa9');
assert.equal(chart.candleBodyColor(colorRow(false,600,300),1),'#9b772b');
assert.equal(chart.candleBodyColor(colorRow(true,900,300,false),1),'#335c70');
assert.equal(chart.candleBodyColor(colorRow(false,300,900,false),1),'#604b5b');
assert.equal(chart.candleBodyAppearance(colorRow(true,900,300,false),1).kind,'unavailable');
assert.equal(chart.candleBodyAppearance(colorRow(false,300,900,false),1).kind,'unavailable');
const conflictingQuality={...colorRow(true,900,300,false),
  deltaEvidence:{kind:'stale',label:'Stale quote'}};
assert.equal(chart.histogramDelta(conflictingQuality,1).source,'processed');
assert.match(chart.candleBodyAppearance(conflictingQuality,1).label,/processed candle: Insufficient classified volume/);
assert.doesNotMatch(chart.candleBodyAppearance(conflictingQuality,1).label,/raw tape:/);
const rawOnlyQuality={...colorRow(true,900,300),
  deltaEvidence:{kind:'stale',label:'Stale quote'}};
assert.equal(chart.histogramDelta(rawOnlyQuality,1).source,'raw');
assert.match(chart.candleBodyAppearance(rawOnlyQuality,1).label,/independent raw tape: Stale quote/);
assert.match(chart.candleBodyAppearance({...colorRow(true,900,300),
  deltaEvidence:{kind:'stale',label:'Stale quote'}},1).label,/Stale quote/);
assert.equal(chart.candleBodyColor(colorRow(true,2000,1000),5),'#21d66e');
assert.equal(chart.candleBodyColor(colorRow(false,1000,2500),5),'#ff8aa9');
const depthRows=[100,120,90,80].map((litShares,index)=>({...prismRow,
  stampMs:start+index*60_000,litShares}));
const beforeSpike=chart.prismVolumeReferences(depthRows);
const afterSpike=chart.prismVolumeReferences([...depthRows,{...prismRow,
  stampMs:start+4*60_000,litShares:100_000}]);
for(const candle of depthRows){
  assert.equal(afterSpike.get(candle.stampMs),beforeSpike.get(candle.stampMs));
  assert.equal(chart.flowPrismStyle(candle,1,afterSpike.get(candle.stampMs)).depth,
    chart.flowPrismStyle(candle,1,beforeSpike.get(candle.stampMs)).depth);
}
assert.equal(chart.prismVolumeReferences([{...depthRows[0],complete:false}]).size,0);
assert.equal(chart.prismVolumeReferences([{...depthRows[0],priceOnly:true}]).size,0);
assert.equal(chart.prismVolumeReferences([{...depthRows[0],litShares:null}]).size,0);
const decisionRows=[0,1,2].map(index=>({...prismRow,stampMs:start+index*60_000,
  buy:100+index*50,sell:80-index*10,litShares:220+index*40}));
assert.equal(chart.decisionSnapshot(decisionRows,start+60_000,1),null);
const firstDecision=chart.decisionSnapshot(decisionRows,start+62_000,1);
assert.equal(firstDecision.row.stampMs,start);
assert.equal(firstDecision.firstKnowableMs,start+62_000);
assert.equal(firstDecision.delta,20);
assert.equal(firstDecision.unknown,40);
assert.equal(firstDecision.coverage,180/220);
assert.equal(firstDecision.previous.length,1);
assert.equal(chart.decisionSnapshot(decisionRows,start+120_000,1).row.stampMs,start);
const secondDecision=chart.decisionSnapshot(decisionRows,start+122_000,1);
assert.equal(secondDecision.row.stampMs,start+60_000);
assert.equal(secondDecision.delta,80);
assert.equal(secondDecision.previous.length,2);
assert.equal(chart.decisionSnapshot([decisionRows[0],decisionRows[2]],
  start+182_000,1).previous.length,1);
assert.equal(chart.decisionSnapshot(decisionRows,start+122_000,1,start+120_000).row.stampMs,
  start+60_000);
assert.equal(chart.decisionSnapshot(decisionRows,start+180_000,1,start+60_000).row.stampMs,
  start+60_000);
assert.equal(chart.decisionSnapshot([...decisionRows,{...decisionRows[2],buy:9999}],
  start+122_000,1).delta,secondDecision.delta);
assert.equal(chart.decisionSnapshot([{...decisionRows[0],priceOnly:true}],
  start+62_000,1).tradeValid,false);
assert.equal(chart.decisionSnapshot([{...decisionRows[0],quoteAgeMs:3000}],
  start+62_000,1).ofi,null);
const jumpClock=stamp=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(stamp);
const jumpRows=[decisionRows[0],{...decisionRows[0],stampMs:start+30*60_000},
  {...decisionRows[0],stampMs:start+60*60_000}];
assert.deepEqual(Array.from(chart.timelineJumpRows(jumpRows,start+31*60_000,1,jumpClock),
  item=>item.label),['08:30']);
assert.deepEqual(Array.from(chart.timelineJumpRows(jumpRows,start+31*60_000+2000,1,jumpClock),
  item=>item.label),['08:30','09:00']);
assert.deepEqual(Array.from(chart.timelineJumpRows([...jumpRows,
  {...decisionRows[0],stampMs:start+90*60_000}],start+31*60_000+2000,1,jumpClock),
  item=>item.label),['08:30','09:00']);
assert.deepEqual(Array.from(chart.timelineJumpRows([{...jumpRows[0],complete:false}],
  start+62_000,1,jumpClock)),[]);
const invalidVolume=chart.candles([{...volumeTape[0],buy:110}],.5,start+30_000,30_000)[0];
assert.equal(invalidVolume.buy,null);
assert.equal(chart.candles(volumeTape,1,start+60_000,30_000)[0].sell,80);
const chicago=stamp=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(stamp);
const sessionRows=[25,29,30,31].map(minute=>({stampMs:Date.UTC(2026,9,16,13,minute)}));
assert.equal(chart.marketOpenBoundaryIndex(sessionRows,chicago),2);
assert.equal(chart.marketOpenBoundaryIndex(sessionRows.slice(0,2),chicago),null);
assert.equal(chart.marketOpenBoundaryIndex(sessionRows.slice(2),chicago),0);
assert.equal(chart.marketOpenBoundaryIndex(sessionRows.slice(3),chicago),null);
assert.equal(chart.marketOpenBoundaryIndex([],chicago),null);
assert.deepEqual(Array.from(chart.nicePriceTicks(539.5,556.7,6)),[540,545,550,555]);
assert.deepEqual(Array.from(chart.nicePriceTicks(99.91,100.09,5)),[99.95,100,100.05]);
assert.deepEqual(Array.from(chart.nicePriceTicks(100,100,5)),[]);
const afternoonDomain=chart.chartPriceDomain([{h:624.5,l:617.8}]);
assert.ok(afternoonDomain.floor<617.8&&afternoonDomain.ceiling>624.5);
const levelY=price=>(afternoonDomain.ceiling-price)/
  (afternoonDomain.ceiling-afternoonDomain.floor)*372;
assert.ok(levelY(617.8)-levelY(624.5)>20);
const oiDomain=chart.chartPriceDomain([{h:550,l:540}]);
assert.ok(oiDomain.ceiling<560&&oiDomain.floor<540);
const flatDomain=chart.chartPriceDomain([{h:550,l:550}]);
assert.ok(flatDomain.floor<550&&flatDomain.ceiling>550);
const packed=chart.packLevelLabels([{desired:12},{desired:16},{desired:46}],10,70,16,4);
assert.deepEqual(Array.from(packed),[12,32,52]);
const bottomPacked=chart.packLevelLabels([{desired:50},{desired:53},{desired:56}],10,70,16,4);
assert.deepEqual(Array.from(bottomPacked),[30,50,70]);
const oiSnapshot={available:true,referenceSpot:552.5,oiByStrike:{
  call:[{strike:540,openInterest:4274},{strike:550,openInterest:7205},
    {strike:560,openInterest:5046},{strike:600,openInterest:15530}],
  put:[{strike:540,openInterest:7666},{strike:550,openInterest:9906},
    {strike:560,openInterest:6240}]
}};
const oi=chart.notableOiStrikes(oiSnapshot);
assert.deepEqual(Array.from(oi,item=>[item.strike,item.callOi,item.putOi]),
  [[550,7205,9906],[540,4274,7666],[560,5046,6240]]);
assert.equal(chart.notableOiStrikes({...oiSnapshot,available:false}).length,0);
const nearPrice=chart.nearbyOiStrikes({available:true,oiByStrike:{
  call:[{strike:607.5,openInterest:798},{strike:610,openInterest:4024},
    {strike:612.5,openInterest:1185},{strike:620,openInterest:5965}],
  put:[{strike:607.5,openInterest:2864},{strike:610,openInterest:4671},
    {strike:612.5,openInterest:7878},{strike:620,openInterest:5088}]
}},608.5,3);
assert.deepEqual(Array.from(nearPrice,item=>item.strike),[607.5,610,612.5]);
assert.equal(chart.nearbyOiStrikes({available:false},608.5).length,0);
const quietSweeps=Array.from({length:10},()=>({complete:true,hasResearch:true,
  litShares:100,buySweeps:1,sellSweeps:0}));
const sweepJump={complete:true,hasResearch:true,litShares:300,buySweeps:3,
  sellSweeps:1,buySweepShares:3500,sellSweepShares:1000};
const sweepReadout=chart.sweepActivity([...quietSweeps,sweepJump]);
assert.equal(sweepReadout[9].elevated,false);
assert.equal(sweepReadout[10].elevated,true);
assert.equal(sweepReadout[10].buySweepShares,3500);
assert.equal(chart.sweepActivity([...quietSweeps,{...sweepJump,complete:false}])[10],null);
assert.equal(chart.sweepActivity([...quietSweeps,{...sweepJump,litShares:120}])[10].elevated,false);
const sweepBuckets=[
  {stampMs:0,sellSweepCandidates:2,buySweepCandidates:0,sellSweepShares:2400,buySweepShares:0},
  {stampMs:30_000,sellSweepCandidates:0,buySweepCandidates:1,sellSweepShares:0,buySweepShares:1300},
  {stampMs:60_000,sellSweepCandidates:0,buySweepCandidates:0,sellSweepShares:0,buySweepShares:0}];
assert.deepEqual({...chart.sweepCandidatesForCandle(sweepBuckets,0,60_000,60_000)},
  {sell:2,buy:1,sellShares:2400,buyShares:1300});
assert.deepEqual({...chart.sweepCandidatesForCandle(sweepBuckets,60_000,30_000,90_000)},
  {sell:0,buy:0,sellShares:0,buyShares:0});
const fiveMinuteSweeps=Array.from({length:10},(_,i)=>({
  stampMs:i*30_000,sellSweepCandidates:i===7?2:0,buySweepCandidates:i===2?1:0,
  sellSweepShares:i===7?2600:0,buySweepShares:i===2?1400:0}));
assert.deepEqual({...chart.sweepCandidatesForCandle(fiveMinuteSweeps,0,300_000,300_000)},
  {sell:2,buy:1,sellShares:2600,buyShares:1400});
assert.equal(chart.sweepCandidatesForCandle(fiveMinuteSweeps,0,300_000,299_999),null);
assert.equal(chart.sweepCandidatesForCandle(sweepBuckets,0,60_000,59_999),null);
assert.equal(chart.sweepCandidatesForCandle(sweepBuckets,0,120_000,120_000),null);
assert.equal(chart.sweepCandidatesForCandle([sweepBuckets[0],sweepBuckets[0]],0,60_000,60_000),null);
assert.equal(chart.sweepCandidatesForCandle([
  {...sweepBuckets[0],sellSweepCandidates:null},sweepBuckets[1]],0,60_000,60_000),null);
assert.equal(chart.buyerSellerRatio(29749,7103),'4.2:1');
assert.equal(chart.buyerSellerRatio(3,0),'B only');
assert.equal(chart.buyerSellerRatio(0,4),'S only');
assert.equal(chart.buyerSellerRatio(1,4),'1:4.0');
assert.equal(chart.buyerSellerRatio(0,0),'—');
assert.equal(chart.buyerSellerRatio(null,3),'N/A');
console.log('Replay chart: point-in-time formation and missing-source checks passed');
