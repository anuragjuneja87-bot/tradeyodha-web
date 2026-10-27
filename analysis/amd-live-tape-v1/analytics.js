(() => {
  'use strict';
  const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const average = values => values.reduce((a, b) => a + b, 0) / values.length;
  const percentile = (values, value) => Math.round(100 * values.filter(x => x <= value).length / values.length);
  const deviation = (values, center, floor) => Math.max(floor, Math.sqrt(average(values.map(x => (x - center) ** 2))));
  const historyIndex = new WeakMap();
  const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  function indexedHistory(library) {
    if (!historyIndex.has(library)) {
      const byWindow = new Map();
      for (const row of library.windows) byWindow.set(`${row[0]}|${row[2]}|${row[1]}`, row);
      historyIndex.set(library, byWindow);
    }
    return historyIndex.get(library);
  }
  function followThrough(row, horizon, index) {
    const start = minute(row[1]);
    const end = start + horizon;
    // Premarket and RTH use different session-open baselines; never join them.
    if (end >= (row[1] < '08:30' ? 8 * 60 + 30 : 11 * 60)) return null;
    const future = index.get(`${row[0]}|${row[2]}|${clock(end)}`);
    if (!future || !Number.isFinite(row[8]) || !Number.isFinite(future[8])) return null;
    return 10000 * ((1 + future[8] / 10000) / (1 + row[8] / 10000) - 1);
  }

  function analyze(bars, date, width, library) {
    if (!library?.windows?.length) return {reason:'Historical AMD windows are unavailable'};
    if (!bars.length || bars.at(-1).t < '06:00' || bars.at(-1).t >= '11:00')
      return {reason:'Historical comparison covers 06:00–11:00 CT only'};
    const premarket = bars.at(-1).t < '08:30';
    const session = bars.filter(row => row.t >= (premarket?'06:00':'08:30') && row.t < (premarket?'08:30':'11:00'));
    if (session.length < width) return {reason:`Waiting for ${width} complete ${premarket?'premarket':'regular-session'} minutes`};
    const rows = session.slice(-width);
    if (rows.some((row, i) => i && minute(row.t) - minute(rows[i - 1].t) !== 1))
      return {reason:'Minute gap in the current window; comparison paused'};
    const buy = rows.reduce((total, row) => total + (row.buy || 0), 0);
    const sell = rows.reduce((total, row) => total + (row.sell || 0), 0);
    const classified = buy + sell;
    const ofis = rows.map(row => row.ofi).filter(Number.isFinite);
    const coverages = rows.map(row => row.coveragePct).filter(Number.isFinite);
    if (classified < (width < 5 ? 250 * width : 1000) || ofis.length < Math.max(width < 5 ? 1 : 3, Math.ceil(width * .6)) || coverages.length !== width || average(coverages) < 65 || !rows[0].o || !rows.at(-1).c)
      return {reason:'Trade classification or quote coverage is too thin for a comparison'};
    const priced = session.filter(row => Number.isFinite(row.o) && Number.isFinite(row.c));
    const sessionOpen = priced[0]?.o;
    const high = Math.max(...session.map(row => row.h).filter(Number.isFinite));
    const low = Math.min(...session.map(row => row.l).filter(Number.isFinite));
    const current = {
      end:rows.at(-1).t, width, buy, sell, classified,
      delta:(buy - sell) / classified,
      ofi:average(ofis),
      priceBps:10000 * (rows.at(-1).c / rows[0].o - 1),
      coverage:average(coverages),
      sessionBps:sessionOpen?10000*(rows.at(-1).c/sessionOpen-1):null,
      rangePosition:Number.isFinite(high)&&Number.isFinite(low)&&high>low?(rows.at(-1).c-low)/(high-low):.5,
    };
    const endMinute = minute(current.end);
    const peers = library.windows.filter(row => row[2] === width && row[0] < date && Math.abs(minute(row[1]) - endMinute) <= 15 && row[7] >= 65 && (row[1]<'08:30')===premarket && (!premarket || (Number.isFinite(row[8])&&Number.isFinite(row[9]))));
    const days = new Set(peers.map(row => row[0])).size;
    if (days < 15) return {reason:`Only ${days} prior comparable sessions; waiting for more history`,current};
    const deltaRank = percentile(peers.map(row => row[3]), current.delta);
    const ofiRank = percentile(peers.map(row => row[4]), current.ofi);
    let label = 'Inside historical range', kind = 'neutral';
    if (deltaRank >= 80 && ofiRank >= 60 && current.priceBps > 0) {label='Buyer imbalance with quote confirmation';kind='buy'}
    else if (deltaRank <= 20 && ofiRank <= 40 && current.priceBps < 0) {label='Seller imbalance with quote confirmation';kind='sell'}
    else if (deltaRank >= 80 && ofiRank < 50) {label='Buyer trades; quotes have not confirmed';kind='mixed'}
    else if (deltaRank <= 20 && ofiRank > 50) {label='Seller trades; quotes have not confirmed';kind='mixed'}
    else if ((deltaRank >= 80 && current.priceBps <= 0) || (deltaRank <= 20 && current.priceBps >= 0)) {label='Aggression without price follow-through';kind='mixed'}
    const deltaMean=average(peers.map(row=>row[3])),ofiMean=average(peers.map(row=>row[4])),priceMean=average(peers.map(row=>row[5]));
    const deltaScale=deviation(peers.map(row=>row[3]),deltaMean,.08);
    const ofiScale=deviation(peers.map(row=>row[4]),ofiMean,.04);
    const priceScale=deviation(peers.map(row=>row[5]),priceMean,8);
    const sessionMean=premarket?average(peers.map(row=>row[8])):0;
    const sessionScale=premarket?deviation(peers.map(row=>row[8]),sessionMean,20):1;
    const rangeMean=premarket?average(peers.map(row=>row[9])):0;
    const rangeScale=premarket?deviation(peers.map(row=>row[9]),rangeMean,.15):1;
    const analogs=[];
    const index=indexedHistory(library);
    const outcomes=[];
    for(const row of peers.map(row=>({row,distance:
      ((current.delta-row[3])/deltaScale)**2+
      ((current.ofi-row[4])/ofiScale)**2+
      .5*((current.priceBps-row[5])/priceScale)**2+
      .2*Math.log(current.classified/row[6])**2+
      (premarket?.7*((current.sessionBps-row[8])/sessionScale)**2:0)+
      (premarket?.5*((current.rangePosition-row[9])/rangeScale)**2:0)
    })).sort((a,b)=>a.distance-b.distance)){
      if(analogs.some(item=>item[0]===row.row[0]))continue;
      analogs.push(row.row);
      const next5=followThrough(row.row,5,index);
      const next15=followThrough(row.row,15,index);
      if(next5!==null)outcomes.push({date:row.row[0],time:row.row[1],next5,next15,distance:row.distance});
      if(analogs.length===5 && outcomes.length===5)break;
    }
    const nearest=analogs[0];
    const closeMatch=nearest && Math.abs(current.delta-nearest[3])<=deltaScale &&
      Math.abs(current.ofi-nearest[4])<=ofiScale &&
      Math.abs(current.priceBps-nearest[5])<=priceScale &&
      (!premarket || (Math.abs(current.sessionBps-nearest[8])<=sessionScale &&
        Math.abs(current.rangePosition-nearest[9])<=rangeScale));
    return {current,label,kind,deltaRank,ofiRank,days,peers:peers.length,analogs:analogs.slice(0,5),outcomes:outcomes.slice(0,5),premarket,closeMatch:!!closeMatch};
  }

  const feature = (name, index, weight, floor, transform = value => value) => ({name,index,weight,floor,transform});
  const commonFeatures = [
    feature('trade delta',3,1,.08), feature('quote OFI',4,1,.04),
    feature('price response',5,.65,8),
    feature('AMD activity',6,.25,.25,Math.log),
  ];
  const richFeatures = [...commonFeatures,feature('AMD queue',10,.2,.08),
    feature('AMD midpoint response',11,.3,8),feature('AMD spread',12,.1,1)];
  const premarketFeatures = [feature('session move',8,.6,20),feature('range position',9,.5,.15)];
  function numeric(value) { return typeof value === 'number' && Number.isFinite(value) }
  function embeddingDistance(current, row, specs, scales) {
    let total=0,weights=0;
    for(const spec of specs){
      const left=current[spec.index],right=row[spec.index];
      if(!numeric(left)||(spec.name.includes('activity')&&left<=0))continue;
      if(!numeric(right)||(spec.name.includes('activity')&&right<=0)){
        total+=spec.weight;weights+=spec.weight;continue;
      }
      const diff=(spec.transform(left)-spec.transform(right))/scales.get(spec.name);
      total+=spec.weight*diff*diff;weights+=spec.weight;
    }
    return weights?Math.sqrt(total/weights):Infinity;
  }
  function matchRows(current, candidates, specs, outcome) {
    const scales=new Map();
    for(const spec of specs){
      const values=candidates.map(row=>row[spec.index]).filter(value=>numeric(value)&&(!spec.name.includes('activity')||value>0)).map(spec.transform);
      scales.set(spec.name,values.length>1?deviation(values,average(values),spec.floor):spec.floor);
    }
    const ranked=candidates.map(row=>({row,distance:embeddingDistance(current,row,specs,scales)}))
      .filter(item=>Number.isFinite(item.distance)).sort((a,b)=>a.distance-b.distance);
    const used=new Set(),matches=[];
    for(const item of ranked){
      if(used.has(item.row[0]))continue;
      const next5=outcome(item.row,5),next15=outcome(item.row,15);
      if(next5===null)continue;
      used.add(item.row[0]);
      const coreDistance=Math.max(...specs.slice(0,3).map(spec=>
        Math.abs((current[spec.index]-item.row[spec.index])/scales.get(spec.name))));
      matches.push({date:item.row[0],time:item.row[1],next5,next15,distance:item.distance,coreDistance});
      if(matches.length===5)break;
    }
    return matches;
  }
  const averageOrNull = values => {const valid=values.filter(numeric);return valid.length?average(valid):null};
  function richCurrent(bars,base) {
    const times=bars.filter(row=>row.t>=(base.premarket?'06:00':'08:30')&&row.t<=(base.current.end)).slice(-base.current.width);
    const queue=averageOrNull(times.map(row=>row.queue));
    const spread=averageOrNull(times.map(row=>row.medianSpreadCents));
    const mid=times.map(row=>row.midMoveCents).filter(numeric);
    return [null,base.current.end,base.current.width,base.current.delta,base.current.ofi,
      base.current.priceBps,base.current.classified,base.current.coverage,base.current.sessionBps,
      base.current.rangePosition,queue,
      mid.length?100*mid.reduce((a,b)=>a+b,0)/times.at(-1).c:null,
      spread===null?null:100*spread/times.at(-1).c];
  }
  function thesis(bars,date,width,library) {
    const base=analyze(bars,date,width,library);
    if(base.reason)return base;
    const premarket=base.premarket;
    const end=minute(base.current.end);
    const vector=richCurrent(bars,base);
    const rich=(library.richWindows||[]).filter(row=>row[0]<date&&row[2]===width&&
      Math.abs(minute(row[1])-end)<=15&&(row[1]<'08:30')===premarket);
    const richDays=new Set(rich.map(row=>row[0])).size;
    let mode='AMD year',matches=base.outcomes,current=base.current;
    if(richDays>=10){
      const specs=premarket?[...richFeatures,...premarketFeatures]:richFeatures;
      matches=matchRows(vector,rich,specs,(row,horizon)=>row[horizon===5?13:14]);
      mode=width<5?'AMD short-window detailed tape':'AMD detailed tape';current={...base.current,queue:vector[10],midResponseBps:vector[11],spreadBps:vector[12]};
    } else {
      const peer=library.windows.filter(row=>row[0]<date&&row[2]===width&&
        Math.abs(minute(row[1])-end)<=15&&(row[1]<'08:30')===premarket&&row[7]>=65);
      const vector=[null,base.current.end,width,base.current.delta,base.current.ofi,base.current.priceBps,
        base.current.classified,base.current.coverage,base.current.sessionBps,base.current.rangePosition];
      const specs=premarket?[...commonFeatures,...premarketFeatures]:commonFeatures;
      matches=matchRows(vector,peer,specs,(row,horizon)=>followThrough(row,horizon,indexedHistory(library)));
    }
    const close=matches.length>=3&&matches[0].distance<=.65&&matches[0].coreDistance<=1;
    const returns=matches.map(item=>item.next5).sort((a,b)=>a-b);
    const middle=Math.floor(returns.length/2);
    const median=returns.length?(returns.length%2?returns[middle]:(returns[middle-1]+returns[middle])/2):null;
    const up=returns.filter(value=>value>0).length,down=returns.filter(value=>value<0).length;
    const signs=[];
    if(base.current.delta>.15)signs.push('buyer-initiated trades');
    if(base.current.delta<-.15)signs.push('seller-initiated trades');
    if(base.current.ofi>.03)signs.push('positive quote pressure');
    if(base.current.ofi<-.03)signs.push('negative quote pressure');
    if(numeric(current.queue)&&Math.abs(current.queue)>.15)signs.push(current.queue>0?'bid queue heavier':'ask queue heavier');
    if(numeric(current.midResponseBps)&&Math.abs(current.midResponseBps)>3)
      signs.push(current.midResponseBps>0?'midpoint rising':'midpoint falling');
    const queueAgainstBuy=numeric(current.queue)&&current.queue<-.15;
    const queueAgainstSell=numeric(current.queue)&&current.queue>.15;
    const bullish=base.current.delta>.15&&base.current.ofi>.03&&base.current.priceBps>0&&
      !queueAgainstBuy&&(!numeric(current.midResponseBps)||current.midResponseBps>=0);
    const bearish=base.current.delta<-.15&&base.current.ofi<-.03&&base.current.priceBps<0&&
      !queueAgainstSell&&(!numeric(current.midResponseBps)||current.midResponseBps<=0);
    let headline='No close historical match',kind='neutral';
    if(close){
      if(bullish){headline='Buyer pressure aligns; watch whether bids hold';kind='buy'}
      else if(bearish){headline='Seller pressure aligns; watch whether offers hold';kind='sell'}
      else if(base.current.delta>.15&&base.current.ofi>.03&&queueAgainstBuy){headline='Buying trades and OFI, but ask queue conflicts';kind='mixed'}
      else if(base.current.delta<-.15&&base.current.ofi<-.03&&queueAgainstSell){headline='Selling trades and OFI, but bid queue conflicts';kind='mixed'}
      else if(Math.sign(base.current.delta)!==Math.sign(base.current.ofi)&&Math.abs(base.current.delta)>.15){headline='Trades and quotes diverge; direction unconfirmed';kind='mixed'}
      else if(Math.sign(base.current.delta)!==Math.sign(base.current.priceBps)&&Math.abs(base.current.delta)>.15){headline='Aggression has not moved price; watch for a flip';kind='mixed'}
      else {headline='No clear pressure alignment in this window';kind='neutral'}
    }
    return {...base,current,mode,matches,matchDays:mode.includes('detailed tape')?richDays:base.days,
      closeMatch:close,thesis:{headline,kind,evidence:signs.join(' · ')||'Trade and quote pressure are near neutral',
        up,down,median,nearest:matches[0]||null}};
  }
  function rollingPressureScore(bars, endStampMs, width, date, library) {
    const end=endStampMs+width*60000;
    const lookback=width;
    const start=end-lookback*60000;
    const atEnd=bars.find(row=>row.stampMs===end-60000);
    if(!atEnd)return null;
    const firstClock=minute(atEnd.t)-lookback+1;
    // Never carry premarket pressure into the regular-session score.
    if(firstClock<(atEnd.t<'08:30'?360:510))return null;
    const rows=bars.filter(row=>row.stampMs>=start&&row.stampMs<end);
    if(rows.length!==lookback||rows.some((row,i)=>row.stampMs!==start+i*60000))return null;
    if(rows.some(row=>!numeric(row.buy)||!numeric(row.sell)||!numeric(row.ofi)||
        !numeric(row.coveragePct)||row.coveragePct<65||!numeric(row.c)))return null;
    const buy=rows.reduce((n,row)=>n+row.buy,0),sell=rows.reduce((n,row)=>n+row.sell,0);
    if(buy+sell<=0)return null;
    const trade=(buy-sell)/(buy+sell);
    const ofi=average(rows.map(row=>row.ofi));
    const peers=(library?.windows||[]).filter(row=>row[0]<date&&row[2]===lookback&&
      Math.abs(minute(row[1])-minute(atEnd.t))<=15&&
      (row[1]<'08:30')===(atEnd.t<'08:30')&&row[7]>=65&&
      numeric(row[3])&&numeric(row[4]));
    const referenceDays=new Set(peers.map(row=>row[0])).size;
    if(referenceDays<15)return null;
    const scale=(index,floor)=>{
      const magnitudes=peers.map(row=>Math.abs(row[index])).sort((a,b)=>a-b);
      return Math.max(floor,magnitudes[Math.floor(.75*(magnitudes.length-1))]);
    };
    const tradeScale=scale(3,.08),ofiScale=scale(4,.03);
    const clip=value=>Math.max(-1,Math.min(1,value));
    const score=Math.round(50*(clip(trade/tradeScale)+clip(ofi/ofiScale)));
    const price=rows.at(-1).c-rows[0].o;
    const mixed=Math.sign(trade)!==Math.sign(ofi)&&Math.abs(trade)>.1&&Math.abs(ofi)>.03;
    const divergence=Math.sign(score)!==Math.sign(price)&&Math.abs(score)>=15&&Math.abs(price)>.001;
    return {score,trade,ofi,price,lookback,referenceDays,tradeScale,ofiScale,
      state:mixed?'mixed':divergence?'price divergence':'aligned'};
  }
  function halfMinutePressureScore(bars, stampMs, date, library) {
    const row=bars.find(item=>item.stampMs===stampMs);
    if(!row||!numeric(row.buy)||!numeric(row.sell)||!numeric(row.ofi)||
       !numeric(row.coveragePct)||row.coveragePct<65||!numeric(row.o)||!numeric(row.c)||
       row.buy+row.sell<=0)return null;
    const seconds=clock=>{const parts=clock.split(':').map(Number);return parts[0]*3600+parts[1]*60+(parts[2]||0)};
    const target=seconds(row.t);
    const peers=(library?.windows||[]).filter(item=>item[0]<date&&
      Math.abs(seconds(item[1])-target)<=900&&
      (item[1]<'08:30')===(row.t<'08:30')&&item[5]>=65&&
      numeric(item[2])&&numeric(item[3]));
    const referenceDays=new Set(peers.map(item=>item[0])).size;
    if(referenceDays<15)return null;
    const scale=(index,floor)=>{const values=peers.map(item=>Math.abs(item[index])).sort((a,b)=>a-b);
      return Math.max(floor,values[Math.floor(.75*(values.length-1))])};
    const trade=(row.buy-row.sell)/(row.buy+row.sell),ofi=row.ofi;
    const clip=value=>Math.max(-1,Math.min(1,value));
    const tradeScale=scale(2,.08),ofiScale=scale(3,.03);
    const score=Math.round(50*(clip(trade/tradeScale)+clip(ofi/ofiScale)));
    const price=row.c-row.o;
    const mixed=Math.sign(trade)!==Math.sign(ofi)&&Math.abs(trade)>.1&&Math.abs(ofi)>.03;
    const divergence=Math.sign(score)!==Math.sign(price)&&Math.abs(score)>=15&&Math.abs(price)>.001;
    return {score,trade,ofi,price,lookback:0.5,referenceDays,tradeScale,ofiScale,
      state:mixed?'mixed':divergence?'price divergence':'aligned'};
  }
  // Exploratory weighting, not fitted to two days of microstructure data.
  // Each feature is computed using information available by the candle close.
  function expandedFlowScore(core, micro) {
    if(!core||!micro)return null;
    const clip=value=>Math.max(-1,Math.min(1,value));
    const total=micro.buy+micro.sell;
    if(!total||!Number.isFinite(micro.depthOfi))return null;
    const queueTotal=micro.bidReplenishment+micro.bidDepletion;
    const sweepTotal=micro.buySweepShares+micro.sellSweepShares;
    const components=[
      {name:'Classified trades + best-quote OFI',weight:.40,value:core.score/100},
      {name:'Depth OFI',weight:.15,value:clip(micro.depthOfi/.15)},
      {name:'Bid queue net',weight:.10,value:queueTotal?clip((micro.bidReplenishment-micro.bidDepletion)/queueTotal):0},
      {name:'Sweep candidates',weight:.10,value:sweepTotal?clip((micro.buySweepShares-micro.sellSweepShares)/Math.max(total*.10,1)):0},
      {name:'Seller run',weight:.05,value:-clip(micro.sellRun/Math.max(total*.15,1))},
      {name:'Sell impact / 2.5K',weight:.10,value:micro.impact==null?null:clip(micro.impact/50)},
      {name:'Sweep 10s',weight:.10,value:sweepTotal&&!micro.matured?null:
        micro.matured?clip((micro.continuation||0)/25)*Math.sign(micro.buySweepShares-micro.sellSweepShares):0}
    ];
    const available=components.filter(item=>Number.isFinite(item.value));
    const weight=available.reduce((n,item)=>n+item.weight,0);
    if(weight<.65)return null;
    const score=Math.round(100*available.reduce((n,item)=>n+item.weight*item.value,0)/weight);
    const mixed=core.state==='mixed';
    const divergent=Math.sign(score)!==Math.sign(core.price)&&Math.abs(score)>=15&&Math.abs(core.price)>.001;
    return {score,state:mixed?'mixed':divergent?'price divergence':'aligned',
      components,availableWeight:weight,referenceDays:core.referenceDays,price:core.price};
  }
  window.AMD_TAPE_ANALYTICS={analyze,thesis,rollingPressureScore,halfMinutePressureScore,expandedFlowScore};
})();

/* Completed-candle, level-local observations. No trade direction or absorption claim. */
(() => {
  'use strict';
  function reaction(bar, profile, levels, band = .25) {
    if (!bar || !profile?.levels || !Number.isFinite(bar.o) || !Number.isFinite(bar.c) ||
        !Number.isFinite(bar.h) || !Number.isFinite(bar.l)) return null;
    const rows = profile.levels;
    const total = rows.reduce((sum, row) => sum + row[1], 0);
    const buy = rows.reduce((sum, row) => sum + row[2], 0);
    const sell = rows.reduce((sum, row) => sum + row[3], 0);
    if (total !== bar.litShares || buy !== bar.buy || sell !== bar.sell ||
        rows.some(row => row[1] < row[2] + row[3])) return null;
    const candidates = levels.filter(level => Number.isFinite(level.price) &&
      bar.l - band <= level.price && level.price <= bar.h + band);
    if (!candidates.length) return {kind:'none'};
    // The touched level closest to the closing price is the one a trader is looking at now.
    const level = candidates.sort((a,b) => Math.abs(a.price-bar.c)-Math.abs(b.price-bar.c))[0];
    const local = rows.filter(row => Math.abs(row[0]/100-level.price) <= band + 1e-9);
    const localShares = local.reduce((sum,row) => sum+row[1],0);
    const localBuy = local.reduce((sum,row) => sum+row[2],0);
    const localSell = local.reduce((sum,row) => sum+row[3],0);
    const startSide = bar.o > level.price + .01 ? 1 : bar.o < level.price - .01 ? -1 : 0;
    const endSide = bar.c > level.price + .01 ? 1 : bar.c < level.price - .01 ? -1 : 0;
    const kind = startSide * endSide < 0 ? 'crossed' :
      startSide === 1 && endSide === 1 ? 'held above' :
      startSide === -1 && endSide === -1 ? 'rejected below' :
      endSide === 0 ? 'closed at level' : endSide > 0 ? 'closed above' : 'closed below';
    return {kind,level,localShares,localBuy,localSell,localDelta:localBuy-localSell,
      localSharePct:total ? 100*localShares/total : 0,
      localCoveragePct:localShares ? 100*(localBuy+localSell)/localShares : 0,
      candleDelta:buy-sell,closeDistance:bar.c-level.price,
      ofi:Number.isFinite(bar.ofi)?bar.ofi:null};
  }
  window.AMD_LEVEL_REACTION = {reaction};
})();

// Descriptive share accounting for the compact workspace. Historical classified
// tape begins at 06:00 CT; the live collector can provide completed 03:00+ bars.
(() => {
  'use strict';
  const clockMinute = value => /^\d{2}:\d{2}$/.test(value || '') ?
    Number(value.slice(0,2))*60+Number(value.slice(3,5)) : NaN;
  const validShares = value => Number.isFinite(value)&&value>=0;
  function summarize(rows, endCt, startCt='06:00') {
    const end=clockMinute(endCt),start=clockMinute(startCt);
    if(!Array.isArray(rows)||!Number.isFinite(end)||!['03:00','06:00'].includes(startCt)||end<=start)return null;
    const premarket={recorded:0,lit:0,buy:0,sell:0,unknown:0,bars:0};
    const market={recorded:0,lit:0,buy:0,sell:0,unknown:0,bars:0};
    for(const row of rows){
      const minute=clockMinute(row?.t);
      if(!Number.isFinite(minute)||minute<start||minute>=end||minute>=900)continue;
      const values=['litShares','offExchangeShares','buy','sell'].map(key=>row[key]);
      if(!values.every(validShares)||values[2]+values[3]>values[0])return null;
      const part=minute<510?premarket:market;
      part.recorded+=values[0]+values[1];part.lit+=values[0];
      part.buy+=values[2];part.sell+=values[3];
      part.unknown+=values[0]-values[2]-values[3];part.bars++;
    }
    return {premarket:premarket.bars?premarket:null,market:end>510&&market.bars?market:null,
      endCt,scope:`recorded ${startCt}–08:29 CT; lit plus off-exchange shares`};
  }
  function meanOf14(rowsByDate,endCt,part){
    if(!Array.isArray(rowsByDate)||rowsByDate.length!==14)return null;
    const values=rowsByDate.map(rows=>summarize(rows,endCt)?.[part]?.recorded);
    return values.every(value=>Number.isFinite(value))?
      Math.round(values.reduce((sum,value)=>sum+value,0)/14):null;
  }
  // Fixed market-open windows use the same completed minute share accounting
  // as the cumulative profile. Missing minutes remain visibly incomplete.
  function marketHalfHours(rows,endCt){
    const end=clockMinute(endCt);
    return [510,540,570,600].map(start=>{
      const stop=start+30;
      const clock=minute=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
      const result={startCt:clock(start),endCt:clock(stop),recorded:0,buy:0,sell:0,
        observed:0,expected:Number.isFinite(end)?Math.max(0,Math.min(end,stop)-start):0,
        state:'waiting'};
      if(!Number.isFinite(end)||end<=start)return result;
      if(!Array.isArray(rows)){result.state='unavailable';return result;}
      const seen=new Set();
      for(const row of rows){
        const minute=clockMinute(row?.t);
        if(!Number.isInteger(minute)||minute<start||minute>=Math.min(end,stop))continue;
        const values=['litShares','offExchangeShares','buy','sell'].map(key=>row[key]);
        if(seen.has(minute)||!values.every(validShares)||values[2]+values[3]>values[0]){
          result.state='unavailable';return result;
        }
        seen.add(minute);result.recorded+=values[0]+values[1];
        result.buy+=values[2];result.sell+=values[3];
      }
      result.observed=seen.size;
      result.state=!seen.size?'missing':seen.size<result.expected?'incomplete':
        end<stop?'forming':'complete';
      return result;
    });
  }
  window.TRADEYODHA_VOLUME_PROFILE={summarize,meanOf14,marketHalfHours};
})();
