/* Classic chart helper embedded so the V2-only asset is never fetched by Classic. */
/* Point-in-time replay candles built only from recorded bars through the cursor. */
((root,factory)=>{
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.TRADEYODHA_REPLAY_CHART={...root.TRADEYODHA_REPLAY_CHART,...api};
})(typeof window==='undefined'?null:window,()=>{
  function candles(rows,widthMinutes,cutoffMs,sourceMs){
    const duration=widthMinutes*60_000;
    if(!Array.isArray(rows)||![.5,1,2,5,15].includes(widthMinutes)||
       ![30_000,60_000].includes(sourceMs)||duration<sourceMs||
       !Number.isFinite(cutoffMs))return [];
    const buckets=new Map();
    for(const row of rows){
      const stamp=row?.stampMs;
      if(!Number.isInteger(stamp)||stamp+sourceMs>cutoffMs||stamp%sourceMs!==0)continue;
      const start=Math.floor(stamp/duration)*duration;
      if(!buckets.has(start))buckets.set(start,new Map());
      buckets.get(start).set(stamp,row);
    }
    return [...buckets].sort((a,b)=>a[0]-b[0]).map(([stampMs,byStamp])=>{
      const observed=[...byStamp].sort((a,b)=>a[0]-b[0])
        .map(([,row])=>row).filter(row=>[row.o,row.h,row.l,row.c].every(Number.isFinite)&&
          row.h>=Math.max(row.o,row.c)&&row.l<=Math.min(row.o,row.c));
      if(!observed.length)return null;
      const expected=duration/sourceMs;
      const complete=stampMs+duration<=cutoffMs&&observed.length===expected&&
        observed.every((row,index)=>row.stampMs===stampMs+index*sourceMs);
      const volume=classifiedVolume(observed);
      const deltaConstituentsValid=observed.every(row=>
        [row.buy,row.sell,row.litShares].every(value=>Number.isFinite(value)&&value>=0)&&
        row.litShares>0&&row.buy+row.sell<=row.litShares&&
        (row.buy+row.sell)/row.litShares>=.65);
      const quoteUsable=observed.filter(row=>Number.isFinite(row.ofi)&&
        Math.abs(row.ofi)<=1&&Number.isFinite(row.quoteUpdates)&&row.quoteUpdates>=3&&
        Number.isFinite(row.quoteAgeMs)&&row.quoteAgeMs>=0&&row.quoteAgeMs<=2000).length;
      const ofi=complete&&quoteUsable===expected?
        observed.reduce((sum,row)=>sum+row.ofi,0)/expected:null;
      return {stampMs,o:observed[0].o,h:Math.max(...observed.map(row=>row.h)),
        l:Math.min(...observed.map(row=>row.l)),c:observed.at(-1).c,
        ...volume,deltaConstituentsValid,ofi,
        quoteUpdates:observed.every(row=>Number.isFinite(row.quoteUpdates))?
          observed.reduce((sum,row)=>sum+row.quoteUpdates,0):null,
        quoteAgeMs:quoteUsable===expected?Math.max(...observed.map(row=>row.quoteAgeMs)):null,
        quoteUsableMinutes:quoteUsable,quoteTotalMinutes:expected,
        observed:observed.length,expected,complete,forming:stampMs+duration>cutoffMs};
    }).filter(Boolean);
  }
  function classifiedVolume(rows){
    if(!rows?.length||!rows.every(row=>[row.buy,row.sell,row.litShares].every(value=>
      Number.isFinite(value)&&value>=0)))
      return {buy:null,sell:null,unclassified:null,litShares:null};
    const buy=rows.reduce((total,row)=>total+row.buy,0);
    const sell=rows.reduce((total,row)=>total+row.sell,0);
    const litShares=rows.reduce((total,row)=>total+row.litShares,0);
    if(buy+sell>litShares)
      return {buy:null,sell:null,unclassified:null,litShares:null};
    return {buy,sell,unclassified:litShares-buy-sell,litShares};
  }
  function candleDeltaClass(row){
    if(!row?.complete||![row.buy,row.sell,row.litShares].every(value=>
      Number.isFinite(value)&&value>=0)||row.buy+row.sell>row.litShares)
      return 'delta-unavailable';
    return row.buy>row.sell?'delta-positive':
      row.sell>row.buy?'delta-negative':'delta-neutral';
  }
  function histogramDelta(row,width){
    if(!row?.complete||row.priceOnly||!Number.isFinite(width)||width<=0)
      return {value:null,reason:'Incomplete or price-only candle',source:'processed'};
    const {buy,sell,litShares}=row;
    if(![buy,sell,litShares].every(value=>Number.isFinite(value)&&value>=0)||
       buy+sell>litShares||litShares<=0)
      return {value:null,reason:'Classified shares unavailable',source:'processed'};
    if(row.deltaConstituentsValid===false||buy+sell<(width<5?width*250:1000)||
       (buy+sell)/litShares<.65)
      return {value:null,reason:'Insufficient classified volume',source:'processed'};
    if(row.deltaEvidence&&row.deltaEvidence.kind!=='valid')
      return {value:null,reason:row.deltaEvidence.label||'Raw delta quality unavailable',source:'raw'};
    return {value:buy-sell,reason:null,source:null};
  }
  // Keep this embedded Classic helper in sync with replay-chart.js.
  function volumePressureTier(row,width){
    if(histogramDelta(row,width).value===null)return 'neutral';
    if(row.buy>0&&(row.sell===0||row.buy>=3*row.sell))return 'buyer-3';
    if(row.sell>0&&(row.buy===0||row.sell>=3*row.buy))return 'seller-3';
    if(row.buy>=2.5*row.sell)return 'buyer-2_5';
    if(row.sell>=2.5*row.buy)return 'seller-2_5';
    if(row.buy>=2*row.sell)return 'buyer-2';
    if(row.sell>=2*row.buy)return 'seller-2';
    if(row.buy>=1.5*row.sell)return 'buyer-1_5';
    if(row.sell>=1.5*row.buy)return 'seller-1_5';
    return 'neutral';
  }
  // Replay-only visual gate. The processed candle's coverage is not a valid
  // substitute for the raw-tape eligible-lit denominator in `item`.
  function replayDeltaEvidence(row,item,width){
    if(!row?.complete)return {kind:'incomplete',css:'delta-unavailable',label:'Incomplete candle'};
    if(![row.buy,row.sell,row.litShares].every(value=>Number.isFinite(value)&&value>=0)||
       row.buy+row.sell>row.litShares)
      return {kind:'missing',css:'delta-unavailable',label:'Buyer/seller shares missing'};
    if(!item)return {kind:'unavailable',css:'delta-unreliable',label:'Raw quality audit unavailable'};
    const minimum=width<5?width*250:1000;
    if(row.buy+row.sell<minimum||!Number.isFinite(item.rawClassified)||
       item.rawClassified<minimum||item.reason?.includes('insufficient classified shares'))
      return {kind:'unreliable',css:'delta-unreliable',label:'Too few classified shares'};
    if(!Number.isFinite(item.coverageAll)||item.coverageAll<65||
       item.reason?.includes('insufficient eligible-lit coverage'))
      return {kind:'unreliable',css:'delta-unreliable',label:'Insufficient eligible-lit coverage'};
    if(!Number.isFinite(item.quoteAgeMs)||item.quoteAgeMs>2000||
       item.reason?.includes('quote too old'))
      return {kind:'stale',css:'delta-unreliable',label:'Stale quote'};
    if(!Number.isFinite(item.validQuotePairs)||item.validQuotePairs<3||
       item.reason?.includes('insufficient valid quote events')||
       item.reason?.includes('incomplete constituent data'))
      return {kind:'unreliable',css:'delta-unreliable',label:'Incomplete raw quote evidence'};
    if(!Number.isFinite(item.rawTradeDelta))
      return {kind:'unavailable',css:'delta-unreliable',label:'Raw delta direction unavailable'};
    if(Math.sign(row.buy-row.sell)!==Math.sign(item.rawTradeDelta))
      return {kind:'unreliable',css:'delta-unreliable',label:'Archived and raw delta disagree'};
    if(item.reason&&item.reason!=='insufficient prior dates')
      return {kind:'unavailable',css:'delta-unreliable',label:item.reason};
    return {kind:'valid',css:candleDeltaClass(row),label:'Raw quality gate passed'};
  }
  function replayWindowKey(stampMs,width,clockTime){
    return clockTime(stampMs+(width===.5?0:(width-1)*60_000)).slice(0,width===.5?8:5);
  }
  function candlesWithFallback(halfRows,minuteRows,widthMinutes,cutoffMs){
    if(widthMinutes===.5)return candles(halfRows,.5,cutoffMs,30_000).map(row=>({...row,sourceMs:30_000}));
    const half=candles(halfRows,widthMinutes,cutoffMs,30_000);
    const minute=candles(minuteRows,widthMinutes,cutoffMs,60_000);
    const byStamp=new Map(minute.map(row=>[row.stampMs,{...row,sourceMs:60_000}]));
    for(const row of half){
      const existing=byStamp.get(row.stampMs);
      if(row.complete||row.forming||!existing?.complete&&row.observed*30_000>(existing?.observed||0)*60_000)
        byStamp.set(row.stampMs,{...row,sourceMs:30_000});
    }
    // A normalized 30-second quote ratio cannot reconstruct the archived
    // minute OFI denominator; keep that separate source for 1m+ views.
    const minuteQuotes=new Map(minute.map(row=>[row.stampMs,row]));
    return [...byStamp.values()].sort((a,b)=>a.stampMs-b.stampMs).map(row=>{
      const quote=minuteQuotes.get(row.stampMs);
      return {...row,ofi:quote?.ofi??null,quoteUpdates:quote?.quoteUpdates??null,
        quoteAgeMs:quote?.quoteAgeMs??null,
        quoteUsableMinutes:quote?.quoteUsableMinutes??0,
        quoteTotalMinutes:quote?.quoteTotalMinutes??widthMinutes};
    });
  }
  function marketOpenBoundaryIndex(rows,localTime){
    if(!Array.isArray(rows)||!rows.length||typeof localTime!=='function')return null;
    const first=localTime(rows[0].stampMs).slice(0,5);
    const last=localTime(rows.at(-1).stampMs).slice(0,5);
    if(first>'08:30'||last<'08:30')return null;
    const index=rows.findIndex(row=>localTime(row.stampMs).slice(0,5)>='08:30');
    return index<0?null:index;
  }
  function nicePriceTicks(floor,ceiling,target=6){
    if(!Number.isFinite(floor)||!Number.isFinite(ceiling)||ceiling<=floor)return [];
    const rough=(ceiling-floor)/Math.max(1,target-1);
    const magnitude=10**Math.floor(Math.log10(rough));
    const step=[1,2,2.5,5,10].map(value=>value*magnitude).find(value=>value>=rough)||10*magnitude;
    const first=Math.ceil((floor-1e-9)/step)*step;
    const ticks=[];
    for(let value=first;value<=ceiling+1e-9&&ticks.length<20;value+=step)
      ticks.push(Math.round(value*10000)/10000);
    return ticks;
  }
  function chartPriceDomain(candles,liveTick=false){
    const prices=(candles||[]).flatMap(row=>[row?.h,row?.l]).filter(Number.isFinite);
    if(!prices.length)return null;
    const low=Math.min(...prices),high=Math.max(...prices);
    const pad=liveTick?Math.max(.05,(high-low)*.18,Math.abs(high)*.001):
      Math.max(.05,(high-low)*.08,Math.abs(high)*.001);
    return {floor:low-pad,ceiling:high+pad};
  }
  function packLevelLabels(items,minimum,maximum,height,gap=4){
    if(!Array.isArray(items)||!items.length)return [];
    const positions=[];
    for(const item of items){
      const desired=Math.max(minimum,Math.min(maximum,item.desired));
      positions.push(Math.max(desired,positions.length?positions.at(-1)+height+gap:minimum));
    }
    const overflow=positions.at(-1)-maximum;
    if(overflow>0)for(let i=0;i<positions.length;i++)positions[i]-=overflow;
    const underflow=minimum-positions[0];
    if(underflow>0)for(let i=0;i<positions.length;i++)positions[i]+=underflow;
    return positions;
  }
  function oiStrikeRows(report){
    if(!report?.available)return [];
    const byStrike=new Map();
    for(const side of ['call','put']){
      for(const row of report.oiByStrike?.[side]||[]){
        const strike=row?.strike,oi=row?.openInterest;
        if(!Number.isFinite(strike)||strike<=0||!Number.isFinite(oi)||oi<0)continue;
        if(!byStrike.has(strike))byStrike.set(strike,{strike,callOi:0,putOi:0});
        byStrike.get(strike)[`${side}Oi`]+=oi;
      }
    }
    return [...byStrike.values()].filter(row=>row.callOi+row.putOi>0);
  }
  function notableOiStrikes(report,limit=3){
    const spot=report?.referenceSpot;
    if(!Number.isFinite(spot)||spot<=0||!Number.isInteger(limit)||limit<1)return [];
    return oiStrikeRows(report).filter(row=>row.strike>=spot*.97&&row.strike<=spot*1.03)
      .sort((a,b)=>b.callOi+b.putOi-a.callOi-a.putOi||
        Math.abs(a.strike-spot)-Math.abs(b.strike-spot)||a.strike-b.strike)
      .slice(0,limit);
  }
  function nearbyOiStrikes(report,price,limit=3){
    if(!Number.isFinite(price)||price<=0||!Number.isInteger(limit)||limit<1)return [];
    return oiStrikeRows(report).sort((a,b)=>Math.abs(a.strike-price)-Math.abs(b.strike-price)||
      b.callOi+b.putOi-a.callOi-a.putOi||a.strike-b.strike).slice(0,limit);
  }
  function sweepActivity(rows){
    const median=values=>{
      const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
      return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
    };
    return rows.map((row,index)=>{
      if(!row?.complete||!row.hasResearch||!Number.isFinite(row.litShares))return null;
      const prior=rows.slice(Math.max(0,index-20),index).filter(item=>
        item?.complete&&item.hasResearch&&Number.isFinite(item.litShares));
      const count=row.buySweeps+row.sellSweeps;
      const sweepMedian=prior.length>=10?median(prior.map(item=>item.buySweeps+item.sellSweeps)):null;
      const volumeMedian=prior.length>=10?median(prior.map(item=>item.litShares)):null;
      const priorVolume=prior.at(-1)?.litShares;
      return {buy:row.buySweeps,sell:row.sellSweeps,
        buySweepShares:row.buySweepShares,sellSweepShares:row.sellSweepShares,
        elevated:prior.length>=10&&count>=Math.max(3,2*sweepMedian)&&
          row.litShares>=1.5*volumeMedian&&row.litShares>=1.25*priorVolume,
        sweepMedian,volumeMedian,priorCount:prior.length};
    });
  }
  function buyerSellerRatio(buy,sell){
    if(!Number.isFinite(buy)||!Number.isFinite(sell)||buy<0||sell<0)return 'N/A';
    if(!buy&&!sell)return '—';
    if(!sell)return 'B only';
    if(!buy)return 'S only';
    return buy>=sell?`${(buy/sell).toFixed(1)}:1`:`1:${(sell/buy).toFixed(1)}`;
  }
  return {candles,classifiedVolume,candleDeltaClass,histogramDelta,volumePressureTier,replayDeltaEvidence,replayWindowKey,candlesWithFallback,marketOpenBoundaryIndex,nicePriceTicks,
    chartPriceDomain,
    packLevelLabels,notableOiStrikes,nearbyOiStrikes,sweepActivity,buyerSellerRatio};
});

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const replaySpeeds = [1000, 2000, 5000, 10000, 15000, 30000, 60000];
  const state = {mode:'choose', demo:null, live:null, half:null, micro:null, microManifest:null,
    sweeps:null,sweepManifest:null,
    index:0, halfIndex:0, chartFocusMs:null, detailsHidden:false,
    timer:null, speed:1000, timeframe:5, selectedStamp:null, replayDates:[], premarketLevels:null,
    premarketGap:null, replayLoadError:null,
    chartOptions:null, liveTick:null, liveTickVersion:null, liveTickRunId:null};
  // The always-on replay workspace reads live HTTP/SSE from the scheduled
  // collector. It never opens its own Massive WebSocket or treats archived
  // candles as live when that collector is unavailable.
  const sharedLiveWorkspace=location.port==='8791'&&
    (location.hostname==='127.0.0.1'||location.hostname==='localhost');
  const apiBase=()=>location.protocol==='file:'?'http://127.0.0.1:8765':
    sharedLiveWorkspace&&state.mode==='live'?'http://127.0.0.1:8765':'';
  // Phase 1 rollback: false restores the prior replay display. Live mode never
  // reads this research payload or uses the replay evidence styles.
  const REPLAY_EVIDENCE_V1=true;
  // Phase 2 rollback: false leaves the existing replay layout intact.
  const REPLAY_TRADER_V1=true;
  // Explicit local preview only; the server must separately start with
  // --observational-research. Neither flag is enabled by default.
  const OBSERVATIONAL_PREVIEW=new URLSearchParams(location.search).get('observational')==='1';
  state.observational=null;
  state.replayView='research';
  state.zoneInspectEnabled=false;state.zone=null;state.zoneKey=null;state.zoneResult=null;
  let zoneRequestGeneration=0,zoneAbort=null;
  function cancelZoneRequest(){zoneRequestGeneration++;zoneAbort?.abort();zoneAbort=null}
  const replayQualityCache=new Map();
  state.replayQuality=null;state.replayQualityStatus='unavailable';
  function replayQualityItem(stampMs,width=state.timeframe){
    const payload=state.replayQuality;
    if(!REPLAY_EVIDENCE_V1||state.mode!=='replay'||!payload||
       payload.symbol!==state.symbol||payload.date!==state.demo?.date)return null;
    const key=window.TRADEYODHA_REPLAY_CHART.replayWindowKey(stampMs,width,
      width===.5?clockTimeSeconds:clockTime);
    return payload.windows?.[String(width)]?.[key]||null;
  }
  function setupPressureFirstLayout(){
    const header=document.querySelector('header');
    const watchlist=document.querySelector('.watchlist-toolbar');
    const mode=watchlist.nextElementSibling;
    const timeframe=$('candle-toolbar');
    const controls=document.createElement('div');controls.className='primary-controls';
    mode.classList.add('mode-toolbar');header.after(controls);
    header.insertBefore(watchlist,header.querySelector('.header-right'));
    controls.append(mode,timeframe);
    const viewButtons=document.createElement('span');viewButtons.className='view-switch';
    viewButtons.innerHTML='<button id="view-watchlist" type="button">All symbols</button><button id="view-detail" type="button" class="active">Single symbol</button>';
    mode.prepend(viewButtons);
    const replayViews=document.createElement('span');replayViews.id='replay-view-switch';
    replayViews.className='replay-view-switch';replayViews.hidden=true;
    replayViews.innerHTML='<button id="replay-view-trader" type="button" aria-pressed="true">Trader View</button><button id="replay-view-research" type="button" aria-pressed="false">Research View</button>';
    replayViews.querySelector('#replay-view-trader').onclick=()=>setReplayView('trader');
    replayViews.querySelector('#replay-view-research').onclick=()=>setReplayView('research');
    viewButtons.after(replayViews);
    const inspectorToggle=document.createElement('button');inspectorToggle.id='zone-inspect-toggle';
    inspectorToggle.type='button';inspectorToggle.textContent='Inspector';
    inspectorToggle.setAttribute('aria-pressed','false');
    inspectorToggle.title='Turn rectangle drawing on';
    inspectorToggle.onclick=()=>{
      state.zoneInspectEnabled=!state.zoneInspectEnabled;
      inspectorToggle.classList.toggle('active',state.zoneInspectEnabled);
      inspectorToggle.setAttribute('aria-pressed',String(state.zoneInspectEnabled));
      inspectorToggle.title=state.zoneInspectEnabled?'Turn rectangle drawing off':'Turn rectangle drawing on';
      $('zone-feedback').hidden=true;
      renderReplayChart();
    };
    const clearZone=document.createElement('button');clearZone.id='zone-clear';clearZone.type='button';
    clearZone.textContent='Clear selection';clearZone.hidden=true;
    clearZone.onclick=()=>{cancelZoneRequest();state.zone=null;state.zoneResult=null;clearZone.hidden=true;
      $('zone-feedback').hidden=true;renderZoneInspector();renderReplayChart()};
    const zoneFeedback=document.createElement('span');zoneFeedback.id='zone-feedback';
    zoneFeedback.className='zone-feedback';zoneFeedback.setAttribute('role','status');zoneFeedback.hidden=true;
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&state.zone&&!document.documentElement.classList.contains('chart-focus-active')){
        clearZone.click();event.preventDefault()
      }
    });
    if(window.TRADER_UI_V2)timeframe.append(inspectorToggle);
    timeframe.append(clearZone,zoneFeedback);
    $('candle-1').classList.remove('active');$('candle-5').classList.add('active');
    if(window.TRADER_UI_V2){
      state.timeframe=1;
      $('candle-5').classList.remove('active');$('candle-1').classList.add('active');
    }
    // Keep legacy context nodes mounted for existing render bindings, but outside the trading view.
    const inactive=document.createElement('div');inactive.hidden=true;document.body.append(inactive);

    const center=$('tape-center'),metrics=center.querySelector('.metrics');
    const otherMetrics=document.createElement('section');otherMetrics.className='secondary-metrics';
    for(const id of ['queue','response','freshness','net']){
      const metric=$(id)?.closest('.metric');
      if(metric)otherMetrics.append(metric);
    }

    const compact=document.createElement('div');compact.className='card compact-session';
    compact.innerHTML='<strong>Session net</strong><span class="compact-pill">Premarket <b id="compact-premarket">—</b></span><span class="compact-pill"><span id="compact-market-label">From open</span> <b id="compact-market">—</b></span><div class="compact-levels" aria-label="Premarket price levels"><span class="compact-level-label" id="compact-pm-status">PM levels · 03:00–08:25 CT</span><span class="compact-level">High <b id="compact-pm-high">—</b></span><span class="compact-level midpoint">.50 <b id="compact-pm-mid">—</b></span><span class="compact-level">Low <b id="compact-pm-low">—</b></span></div><div class="compact-options" aria-label="Nearby options open interest"><span class="compact-level-label" id="compact-options-status">Nearby OI · daily reference</span><span class="compact-level">Call ↑ <b id="compact-call-wall">—</b></span><span class="compact-level">Put ↓ <b id="compact-put-wall">—</b></span></div>';
    const hero=document.createElement('section');hero.className='chart-first-hero';
    const formation=document.createElement('aside');formation.className='chart-formation card';formation.setAttribute('aria-label','Selected or forming candle measurements');
    formation.innerHTML='<div class="formation-heading"><div><h2 id="formation-title">Candle pressure</h2><span id="formation-interval">Waiting for tape</span></div><b id="formation-badge">WAITING</b></div><div class="formation-progress" aria-label="Time elapsed in current candle"><span id="formation-progress-bar"></span></div><p id="formation-source">Completed candles only</p><p id="replay-quality-status" class="replay-quality-status" hidden></p>';
    formation.append(metrics);
    const sessionFootprint=document.createElement('section');sessionFootprint.className='session-footprint';
    sessionFootprint.setAttribute('aria-label','Session estimated buyer and seller volume');
    sessionFootprint.innerHTML='<div class="session-footprint-heading"><strong>Session footprint</strong><small>lit · initiating side estimated</small></div><div id="session-footprint-premarket" class="session-footprint-row"><div class="session-footprint-top"><b>Premarket · 06:00–08:30</b><small class="session-footprint-quality">Waiting for tape</small></div><div class="session-footprint-track"><span class="footprint-buy"></span><span class="footprint-sell"></span><span class="footprint-unknown"></span></div><div class="session-footprint-values">Buyer — · Seller — · Unknown —</div></div><div id="session-footprint-market" class="session-footprint-row"><div class="session-footprint-top"><b>Market · 08:30–15:00</b><small class="session-footprint-quality">Not open yet</small></div><div class="session-footprint-track"><span class="footprint-buy"></span><span class="footprint-sell"></span><span class="footprint-unknown"></span></div><div class="session-footprint-values">Buyer — · Seller — · Unknown —</div></div>';
    formation.append(sessionFootprint);
    const sessionPanel=()=>{const section=document.createElement('section');section.className='workspace-volume-panel';
      section.innerHTML=`<div class="workspace-live-price"><strong data-volume-symbol>—</strong><b data-volume-price>—</b><small data-volume-price-time>Waiting for a completed candle</small></div>
        <h3>Volume profile</h3><div class="workspace-volume-grid">
          <section class="workspace-volume-period" data-volume-period="pm"><strong>Pre-market</strong>
            <small data-volume-pm-window>From 03:00 CT</small><div class="workspace-volume-total"><b class="pending" data-volume-pm>Waiting for tape</b><small>recorded shares</small></div>
            <div class="workspace-volume-side"><span>Buyer est. <b data-volume-pm-buy>—</b></span><span>Seller est. <b data-volume-pm-sell>—</b></span></div>
            <small data-volume-pm-average hidden></small></section>
          <section class="workspace-volume-period" data-volume-period="market"><strong>Market open · 08:30 CT</strong>
            <div class="workspace-volume-total"><b class="pending" data-volume-market>Waiting for 08:30</b><small>recorded shares</small></div>
            <div class="workspace-volume-side"><span>Buyer est. <b data-volume-market-buy>—</b></span><span>Seller est. <b data-volume-market-sell>—</b></span></div>
            <small data-volume-market-average hidden></small></section></div>
        <p class="workspace-volume-note" data-volume-status>Recorded lit + off-exchange shares; buyer/seller are estimated lit classifications.</p>
        <h3>Nearby options OI</h3><div class="workspace-oi-grid"><div><small>Call wall above price</small><b data-volume-call>N/A</b></div><div><small>Put wall below price</small><b data-volume-put>N/A</b></div></div><div class="workspace-major-oi" data-volume-major>Major nearby OI N/A</div><p class="workspace-volume-note" data-volume-oi-status>Daily open-interest reference; not live orders.</p>`;
      for(const side of ['call','put']){
        const distance=document.createElement('span');distance.dataset[`volume${side[0].toUpperCase()+side.slice(1)}Distance`]='';
        distance.className='workspace-oi-distance';distance.textContent='Distance N/A';
        section.querySelector(`[data-volume-${side}]`).after(distance);
      }
      const pin=document.createElement('div');pin.className='workspace-pin';
      pin.innerHTML='<small>Gross-gamma peak · pin proxy</small><b data-volume-pin>N/A</b><span data-volume-pin-distance>Distance N/A</span>';
      section.querySelector('.workspace-major-oi').after(pin);
      return section};
    formation.append(sessionPanel());
    center.prepend(hero);
    hero.append(formation);
    const flow=center.querySelector('.flow');
    const session=document.createElement('section');session.className='detail-session card';session.style.padding='10px';
    const sessionTitle=document.createElement('strong');sessionTitle.textContent='Session flow detail';session.append(sessionTitle);
    session.append(flow.querySelector('.bucket-grid'),flow.querySelector('.flow-strip'));
    const recentHead=[...flow.querySelectorAll('.flow-head')][1];if(recentHead)recentHead.remove();
    const note=$('research-note');
    inactive.append(compact,session,otherMetrics,$('levels-title').closest('.levels-card'),
      document.querySelector('.macro-card'),$('amd-analytics'),note);
    $('footprint-panel').hidden=true;
    const definitions=document.createElement('details');definitions.className='flow-definitions';
    definitions.innerHTML=`<summary>Metric definitions · Quote OFI and Depth OFI</summary>
      <div class="flow-definitions-grid">
        <div><strong>Quote OFI</strong><p>At each valid best-bid/ask update, count bid-size additions and bid-price rises as positive; count ask-size additions and ask-price falls as negative. Sum those signed changes and divide by the sum of their absolute magnitudes. This is top-of-book pressure, not executed buying.</p></div>
        <div><strong>Depth OFI</strong><p>The same signed best-quote changes, using quote pairs no more than 2 seconds apart, divided by the sum of their average displayed best-bid/ask sizes. “Depth” here means displayed size at the best quotes, not the full order book. It shares its numerator with Quote OFI.</p></div>
      </div><p class="flow-definitions-note">Both OFI variants use best-quote changes, not executed buying or full book depth.</p>`;
    const chart=document.createElement('section');chart.id='replay-chart';chart.className='replay-chart';
    chart.hidden=true;chart.setAttribute('aria-label','Session candlestick chart');
      chart.innerHTML='<div class="replay-chart-head"><strong id="replay-chart-title">Session candles</strong><span id="replay-chart-hover" aria-live="off">Hover a candle for details</span><button id="chart-panel-toggle" type="button" hidden aria-expanded="true">Hide panel</button><span id="replay-chart-oi-status" class="chart-oi-status" hidden></span><span id="replay-chart-asof">—</span></div><svg id="replay-chart-svg" role="img" aria-label="Session candlesticks through available tape" viewBox="0 0 1100 420" preserveAspectRatio="none"></svg><div id="chart-candle-readout" class="chart-candle-readout" role="tooltip" aria-label="Hovered candle price, buyer, seller, delta, classified coverage, sweep candidates, and quote OFI" hidden><strong id="chart-readout-time">Candle</strong><span class="readout-group" title="Lit initiating side is estimated by quote matching; delta is buyer minus seller classified shares."><span class="readout-label">Candle lit volume</span><span class="readout-values"><b id="chart-volume-buy" class="positive">Buyer —</b><b id="chart-volume-sell" class="negative">Seller —</b><b id="chart-volume-lit">Lit shares —</b><b id="chart-volume-coverage">Classified —</b><b id="chart-volume-delta">Delta —</b></span></span><span id="chart-ofi-readout" class="readout-label">Quote OFI —</span></div>';
    const sweepLine=document.createElement('span');sweepLine.id='chart-sweep-evidence';
    sweepLine.className='readout-label';
    chart.querySelector('.readout-group').after(sweepLine);
    const chartFocus=document.createElement('button');chartFocus.id='chart-focus-toggle';
    chartFocus.type='button';chartFocus.textContent='⤢ Expand chart';
    chartFocus.setAttribute('aria-label','Expand chart to fill the screen');
    chartFocus.setAttribute('aria-pressed','false');
    const timeframeControls=$('candle-toolbar'),replayControls=$('replay-controls');
    const timeframeHome=document.createComment('chart timeframe controls home');
    const replayHome=document.createComment('replay controls home');
    timeframeControls.before(timeframeHome);replayControls.before(replayHome);
    const focusBar=document.createElement('div');focusBar.id='chart-focus-bar';focusBar.hidden=true;
    focusBar.innerHTML='<strong id="chart-focus-symbol"></strong><div id="chart-focus-timeframe"></div><div id="chart-price-tools" role="group" aria-label="Price scale controls"><span>Price scale</span><button type="button" data-price-zoom="out" aria-label="Zoom price scale out">−</button><button type="button" data-price-zoom="in" aria-label="Zoom price scale in">+</button><button type="button" data-price-zoom="reset">Reset</button></div><div id="chart-focus-playback"></div>';
    focusBar.querySelector('#chart-price-tools').onclick=event=>{
      const action=event.target.closest('button[data-price-zoom]')?.dataset.priceZoom;
      if(action==='reset')window.TY_PRO_CHART?.resetPriceZoom();
      else if(action)window.TY_PRO_CHART?.zoomPrice(action);
    };
    chart.prepend(focusBar);
    const setChartFocus=enabled=>{
      if(enabled){
        focusBar.querySelector('#chart-focus-symbol').textContent=`${state.symbol} · ${state.mode==='replay'?'Replay':'Live'}`;
        focusBar.querySelector('#chart-focus-timeframe').append(timeframeControls);
        focusBar.querySelector('#chart-focus-playback').append(replayControls);
        focusBar.hidden=false;
      }else{
        timeframeHome.after(timeframeControls);replayHome.after(replayControls);
        focusBar.hidden=true;
      }
      document.documentElement.classList.toggle('chart-focus-active',enabled);
      chartFocus.textContent=enabled?'✕ Exit chart view':'⤢ Expand chart';
      chartFocus.setAttribute('aria-label',enabled?'Exit chart-only view':'Expand chart to fill the screen');
      chartFocus.setAttribute('aria-pressed',String(enabled));
      requestAnimationFrame(()=>window.dispatchEvent(new Event('resize')));
    };
    $('go-live').addEventListener('click',()=>{
      if(document.documentElement.classList.contains('chart-focus-active'))setChartFocus(false);
    });
    chartFocus.onclick=()=>setChartFocus(!document.documentElement.classList.contains('chart-focus-active'));
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&document.documentElement.classList.contains('chart-focus-active'))setChartFocus(false);
    });
    chart.append(chartFocus);
    if(window.TRADER_UI_V2&&window.TY_PRO_CHART){
      const surface=document.createElement('div');surface.id='professional-chart';
      surface.setAttribute('aria-label','Professional session candlestick chart with estimated trade-side body colors');
      chart.querySelector('#replay-chart-svg').after(surface);
      chart.querySelector('#replay-chart-svg').hidden=true;
      const empty=document.createElement('div');empty.id='professional-chart-empty';
      empty.className='professional-chart-empty';empty.hidden=true;empty.setAttribute('role','status');
      surface.after(empty);
      const detail=document.createElement('details');detail.id='professional-level-details';
      detail.innerHTML='<summary>Chart level sources and unavailable references</summary><div id="professional-level-list">Loading as-of levels…</div>';
      surface.after(detail);
      const volumeKey=document.createElement('div');volumeKey.id='candle-color-key';volumeKey.className='volume-color-key';
      volumeKey.setAttribute('aria-label','Candle body color definitions');
      volumeKey.innerHTML='<strong>Candle body color</strong><span class="volume-key-side">Price up · buy ÷ sell <i class="buyer-neutral"></i>&lt;1.5× <i class="buyer-1_5"></i>1.5× <i class="buyer-2"></i>2× <i class="buyer-2_5"></i>2.5× <i class="buyer-3"></i>3×+</span><span class="volume-key-side">Price down · sell ÷ buy <i class="seller-1_5"></i>&lt;2× <i class="seller-2"></i>2× <i class="seller-2_5"></i>2.5×+</span><span class="volume-key-side"><i class="flow-unavailable"></i>Striped = trade-side unavailable</span><small>Muted blue and dark yellow show price direction without strong qualified flow. Striped bodies fail the trade-side quality gate. Wick and outline show price direction. Color is descriptive, not a reversal signal.</small>';
      surface.after(volumeKey);
      const jumps=document.createElement('nav');jumps.id='chart-time-jumps';jumps.className='chart-time-jumps';
      jumps.setAttribute('aria-label','Jump to a completed candle on the chart timeline');
      jumps.onclick=event=>{
        const button=event.target.closest('button[data-stamp-ms]');if(!button)return;
        const stampMs=Number(button.dataset.stampMs);
        if(!window.TY_PRO_CHART?.jumpTo(stampMs))return;
        state.selectedStamp=stampMs;render();
      };
      surface.after(jumps);
    }
    const evidenceLegend=document.createElement('div');evidenceLegend.id='replay-evidence-legend';evidenceLegend.className='replay-evidence-legend';evidenceLegend.hidden=true;
    evidenceLegend.innerHTML='<span><i class="legend-body up"></i>Blue/yellow body: price up/down</span><span><i class="legend-border valid"></i>Green/red border: qualified buyer/seller delta</span><span><i class="legend-border uncertain"></i>Gray border: incomplete, missing, or unreliable</span>';
    chart.querySelector('.replay-chart-head').after(evidenceLegend);
    const gapBadge=document.createElement('span');gapBadge.id='replay-chart-gap';
    gapBadge.className='chart-gap';gapBadge.hidden=true;
    chart.querySelector('#replay-chart-title').after(gapBadge);
    hero.insertBefore(chart,formation);
    const rightRail=document.createElement('aside');rightRail.id='chart-right-rail';
    rightRail.className='chart-right-rail';rightRail.dataset.view='overview';
    rightRail.setAttribute('aria-label','Symbol overview and selected zone tape');
    const railTabs=document.createElement('div');railTabs.className='chart-rail-tabs';
    const overviewTab=document.createElement('button');overviewTab.id='chart-overview-tab';
    overviewTab.type='button';overviewTab.textContent='Market overview';overviewTab.setAttribute('aria-pressed','true');
    const zoneTab=document.createElement('button');zoneTab.id='chart-zone-tab';
    zoneTab.type='button';zoneTab.textContent='Zone tape';zoneTab.setAttribute('aria-pressed','false');zoneTab.hidden=true;
    const setRailView=view=>{rightRail.dataset.view=view;
      overviewTab.setAttribute('aria-pressed',String(view==='overview'));
      zoneTab.setAttribute('aria-pressed',String(view==='zone'))};
    overviewTab.onclick=()=>setRailView('overview');
    zoneTab.onclick=()=>{if(state.zone)setRailView('zone')};
    railTabs.append(overviewTab,zoneTab);
    const overviewPanel=sessionPanel();overviewPanel.classList.add('chart-overview-panel');
    overviewPanel.setAttribute('aria-label','Market overview');
    const zoneInspector=document.createElement('section');zoneInspector.id='zone-inspector';
    zoneInspector.className='zone-inspector';zoneInspector.hidden=true;
    zoneInspector.setAttribute('aria-label','Selected rectangle tape inspector');
    rightRail.append(railTabs,overviewPanel,zoneInspector);hero.append(rightRail);
    const trader=document.createElement('aside');trader.id='trader-snapshot';
    trader.className='trader-snapshot card';trader.hidden=true;
    trader.innerHTML='<div class="trader-snapshot-head"><strong id="trader-symbol">AMD</strong><span id="trader-asof">Replay —</span><span id="trader-timeframe">5 min</span></div><div class="trader-price-line"><strong id="trader-price">—</strong><span id="trader-level">Level unavailable</span><span id="trader-live-status" class="live-price-status" hidden></span><span id="trader-current-tick" class="live-price-status" hidden></span></div><div class="trader-candle-heading"><strong id="trader-candle-time">Last completed candle</strong><span id="trader-quality">Quality pending</span></div><div class="trader-measures"><div><small>Open / high / low / close</small><b id="trader-ohlc">—</b></div><div><small>Buyer / seller / unknown · lit</small><b id="trader-sides">—</b></div><div><small>Trade Δ · imbalance</small><b id="trader-delta">—</b></div><div><small>Eligible lit · shares/s</small><b id="trader-intensity">—</b></div><div><small>Classified coverage</small><b id="trader-coverage">—</b></div><div><small id="trader-ofi-label">Quote OFI · age</small><b id="trader-ofi">—</b></div><div><small>Price change</small><b id="trader-change">—</b></div><div><small>Median spread</small><b id="trader-spread">—</b></div></div><div id="trader-observation" class="trader-observation">Waiting for a completed candle</div><button id="trader-research-link" type="button">Open Research View →</button>';
    trader.querySelector('#trader-research-link').onclick=()=>setReplayView('research');
    const volumeDetails=document.createElement('details');volumeDetails.className='trader-volume-details';
    volumeDetails.innerHTML='<summary>Volume profile and options context</summary>';
    volumeDetails.append(sessionPanel());trader.append(volumeDetails);
    hero.append(trader);
    const panelToggle=$('chart-panel-toggle');
    panelToggle.hidden=!window.TRADER_UI_V2;
    if(window.TRADER_UI_V2)$('candle-toolbar').append(panelToggle);
    panelToggle.onclick=()=>{
      state.detailsHidden=!state.detailsHidden;
      $('dashboard').classList.toggle('chart-panel-hidden',state.detailsHidden);
      panelToggle.textContent=state.detailsHidden?'Show panel':'Hide panel';
      panelToggle.setAttribute('aria-expanded',String(!state.detailsHidden));
    };
    const behind=document.createElement('section');behind.id='ui4-rail';
    behind.className='ui4-rail';behind.setAttribute('aria-label','Behind the candle · completed observational evidence');
    behind.innerHTML='<div class="ui4-head"><strong>Behind the candle</strong><span id="ui4-asof">Waiting for a completed minute</span></div><div id="ui4-status" class="ui4-status">Source quality pending</div><div class="ui4-measures"><div><small>SIP-report trade B−S · 1m</small><b id="ui4-trade">N/A</b><em id="ui4-trade-change">Comparison N/A</em></div><div><small>Best-quote OFI · 1m</small><b id="ui4-quote">N/A</b><em id="ui4-quote-change">Comparison N/A</em></div><div><small>Completed price Δ · 1m</small><b id="ui4-price">N/A</b><em id="ui4-persistence">Persistence N/A</em></div><div><small>Spread / vendor quote age</small><b id="ui4-spread">N/A</b><em id="ui4-quote-age">Quote age N/A</em></div></div><p id="ui4-conflict" class="ui4-context">Independent measurements pending</p><p id="ui4-level" class="ui4-context">PM / ORB context pending</p><p class="ui4-caution">Completed 1m observations only · trade side estimated · best quote, not depth · no entry signal</p>';
    behind.querySelectorAll('.ui4-context,.ui4-caution').forEach(description=>{description.hidden=true});
    formation.append(behind);
    const context=document.createElement('section');context.id='ui5-context';
    context.className='ui5-context';context.hidden=true;
    context.setAttribute('aria-label','Decision and market context · descriptive');
    context.innerHTML='<div class="ui5-head"><strong>Level & market context</strong><span id="ui5-asof">Waiting for completed minute</span></div><div class="ui5-grid"><div><small>Nearest available PM / ORB level</small><b id="ui5-nearest">N/A</b></div><div><small>Next above / below</small><b id="ui5-bracket">N/A</b></div><div><small>Qualified pressure signs</small><b id="ui5-alignment">N/A</b></div><div><small>Same-minute price vs indices</small><b id="ui5-indices">N/A</b></div></div><p id="ui5-interaction" class="ui5-interaction">Completed price interaction · N/A</p><p id="ui5-note">As-of references and synchronized completed price bars only. Relative returns are descriptive.</p>';
    formation.append(context);
    const observational=document.createElement('section');
    observational.id='observational-preview';observational.className='observational-preview card';
    observational.hidden=true;
    observational.innerHTML='<div class="observational-head"><strong>Observational research · live preview</strong><span id="observational-asof">Awaiting completed second</span></div><div class="observational-grid"><div><small>Market context</small><b id="observational-context">—</b><span id="observational-level">PM / ORB source pending</span></div><div><small>Market pressure · 30 sec</small><b id="observational-pressure">N/A</b><span id="observational-coverage">Quality pending</span></div><div><small>Price response</small><b id="observational-response">N/A</b><span id="observational-spread">Quote pending</span></div><div><small>Source quality</small><b id="observational-quality">Unavailable</b><span id="observational-receipt">No feed</span></div></div><details><summary>Research details · three trade-side estimates and quote OFI</summary><div id="observational-policies">No completed research observation</div><p>Top-of-book OFI and estimated lit trade side only. No probability or entry signal.</p></details>';
    hero.append(observational);
    const strip=document.createElement('section');strip.id='trader-strip';strip.className='trader-strip card';strip.hidden=true;
    strip.innerHTML='<div class="trader-strip-head"><strong>Recent eight completed candles</strong><span id="trader-strip-note">Same source and cursor · select a candle</span></div><div id="trader-strip-grid" class="trader-strip-grid" role="group" aria-label="Recent eight completed candle pressure"></div>';
    hero.prepend(strip);
    flow.querySelector('.pressure-legend').after(definitions);

    const quick=document.createElement('section');quick.className='card quick-card';
    quick.innerHTML='<h2 id="quick-level-title">Levels to watch · AMD</h2><div class="side-label">Premarket · 03:00–08:25 CT</div><div class="quick-levels"><div class="quick-level"><span>High</span><b id="quick-pm-high">—</b></div><div class="quick-level"><span>Midpoint · 50%</span><b id="quick-pm-mid">—</b></div><div class="quick-level"><span>Low</span><b id="quick-pm-low">—</b></div></div><div class="side-label">Opening range</div><div id="quick-orb" class="quick-foot">Waiting for complete 08:30–08:34 tape</div><div class="side-label">Market context</div><div id="quick-macro" class="quick-foot">Waiting for market context</div><div id="quick-research" class="quick-foot">Raw order-flow rows appear only when available.</div>';
    inactive.append(quick);
    const reaction=document.createElement('div');reaction.className='level-reaction-card';
    reaction.innerHTML='<div class="level-reaction-heading"><strong>Level reaction</strong><span id="level-reaction-time">—</span></div><b id="level-reaction-state">Waiting for completed candle</b><div id="level-reaction-detail" class="level-reaction-detail">Premarket and completed ORB levels only.</div>';
    quick.querySelector('.side-label').before(reaction);
    const researchContext=document.createElement('details');researchContext.id='research-context';
    researchContext.className='research-context';
    researchContext.innerHTML='<summary>Session context, level reactions, and historical research</summary>';
    researchContext.append(compact,session,quick,otherMetrics,$('amd-analytics'));
    flow.append(researchContext);
    document.querySelector('.right-stack').hidden=true;
    const board=document.createElement('section');board.id='watchlist-board';board.className='card watchlist-board';
    board.hidden=true;
    board.innerHTML='<div class="board-heading"><strong>Watchlist candle pressure</strong><span id="board-asof">Waiting for completed candles</span><span id="board-source">Same completed candle across symbols</span></div><div id="board-rows" class="board-rows"></div><div class="board-foot">Every row uses the same completed interval. A dash means that symbol’s interval or source is unavailable. Buyer/seller shares are estimated from classified lit trades. Live WebSocket timestamps have millisecond precision; verified replay has nanosecond precision, so trade-side estimates can revise after the close. Nearby OI uses daily open interest; its source and availability time are shown. OI is not confirmed support or resistance.</div>';
    $('main-panel').after(board);
  }
  setupPressureFirstLayout();
  state.ui3Show15=false;
  function setupMultiPressure(){
    if(!window.TRADER_UI_V2)return;
    const grid=$('pressure-grid'),flow=grid.closest('.flow');
    const panel=document.createElement('section');panel.id='ui3-pressure';
    panel.setAttribute('aria-label','Simultaneous completed candle pressure');
    panel.innerHTML='<div class="ui3-head"><strong>Multi-timeframe Candle Pressure</strong><small>SIP-report trade estimate · top-of-book OFI</small><small id="ui3-asof">As of —</small><button id="ui3-15-toggle" type="button" aria-pressed="false">Show 15m</button></div><div id="ui3-cards" class="ui3-grid"></div>';
    flow.querySelector('.pressure-title').before(panel);
    const history=document.createElement('details');history.id='ui3-history';
    history.innerHTML='<summary>Selected timeframe · eight-candle history</summary>';
    const wrap=grid.closest('.tape-wrap'),legend=flow.querySelector('.pressure-legend');
    wrap.before(history);history.append(wrap,legend);
    $('ui3-15-toggle').onclick=()=>{
      state.ui3Show15=!state.ui3Show15;
      $('ui3-15-toggle').textContent=state.ui3Show15?'Hide 15m':'Show 15m';
      $('ui3-15-toggle').setAttribute('aria-pressed',String(state.ui3Show15));
      renderMultiPressure();
    };
  }
  setupMultiPressure();
  const WATCH_SYMBOL_KEY='tradeyodha.selectedSymbol.v1';
  const MODE_KEY='tradeyodha.activeMode.v1';
  const REPLAY_DATE_KEY='tradeyodha.replayDate.v1';
  const REPLAY_VIEW_KEY='tradeyodha.replayView.v1';
  const tabValue=key=>{try{return sessionStorage.getItem(key)}catch(_error){return null}};
  const saveTabValue=(key,value)=>{try{sessionStorage.setItem(key,value)}catch(_error){}};
  // Research View remains implemented for later redesign; replay opens in Trader View.
  const isWeekend=date=>{
    const day=new Date(`${date}T12:00:00Z`).getUTCDay();
    return day===0||day===6;
  };
  const indexSymbols=['SMH','SOXL','SPY','QQQ'];
  const orderWatchlist=symbols=>[
    ...indexSymbols.filter(symbol=>symbols.includes(symbol)),
    ...symbols.filter(symbol=>!indexSymbols.includes(symbol))
  ];
  const defaultWatchlist=orderWatchlist(['AMD','TSLA','SPY','QQQ','META','NVDA','MU','MSFT','SOXL','SPCX','SNDK']);
  state.symbolHistory={};
  state.boardReplayErrors={};
  let replayLoadVersion=0;
  const replayBenchmarkCache=new Map();
  const replayBenchmarkSessionCache=new Map();
  const validSymbol=symbol=>typeof symbol==='string'&&/^[A-Z]{1,6}$/.test(symbol);
  state.watchlist=[...defaultWatchlist];
  state.supported=[...defaultWatchlist];
  state.boardMode=false;
  state.boardLive={};state.boardHalf={};state.boardReplay={};state.boardPremarket={};state.boardOptions={};
  state.boardVersions={};state.boardFetchedVersions={};state.boardFetchedContext='';
  try{state.symbol=localStorage.getItem(WATCH_SYMBOL_KEY)||'AMD'}catch(_error){state.symbol='AMD'}
  if(!state.watchlist.includes(state.symbol))state.symbol='AMD';
  function saveWatchlist(){try{localStorage.setItem(WATCH_SYMBOL_KEY,state.symbol)}catch(_error){}}
  function watchError(message){$('watch-status').textContent=message;status(message,'bad')}
  async function loadServerWatchlist(){
    const base=apiBase();
    const response=await fetch(`${base}/api/watchlist`,{cache:'no-store',signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error(`Watchlist HTTP ${response.status}`);
    const data=await response.json();
    if(!Array.isArray(data.symbols)||!data.symbols.length||!data.symbols.every(validSymbol))
      throw new Error('Invalid server watchlist');
    state.supported=data.supported;state.watchlist=orderWatchlist(data.symbols.filter(symbol=>symbol!=='SMH'));
    if(!state.watchlist.includes(state.symbol)){
      state.symbol=state.watchlist[0];state.live=null;state.half=null;state.selectedStamp=null;
      closeLiveUpdates();saveWatchlist();
    }
    renderWatchlist();render();
    if(state.boardMode&&state.mode==='live')refreshBoardLive(true);
  }
  async function loadSymbolHistory(symbol,force=false){
    if(state.symbolHistory[symbol]&&!force)return;
    const response=await fetch(`watchlist-history/${symbol}.json`,
      {cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`${symbol} history HTTP ${response.status}`);
    const data=await response.json();
    if(data.symbol!==symbol||!Array.isArray(data.dates)||data.dates.length!==30||
       !Array.isArray(data.sessions)||data.sessions.length!==30||
       !Array.isArray(data.windows)||!Array.isArray(data.halfWindows)||
       data.dates.some((date,index)=>index&&date<=data.dates[index-1])||
       data.sessions.some((item,index)=>item.date!==data.dates[index]||!item.sourceSha256?.trades||
         !item.sourceSha256?.quotes||item.parityChecks<135)||
       data.windows.some(row=>!Array.isArray(row)||row.length<8||!data.dates.includes(row[0]))||
       data.halfWindows.some(row=>!Array.isArray(row)||row.length<6||!data.dates.includes(row[0])))
      throw new Error(`${symbol} flow history failed validation`);
    state.symbolHistory[symbol]={...data,half:{dates:data.dates,windows:data.halfWindows}};
    if(state.symbol===symbol){
      const dates=symbol==='AMD'?[...new Set([...(state.amdReplayDates||[]),...data.dates])].sort():data.dates;
      setReplayDates(state.mode==='replay'&&state.demo?.todayReplay?
        [...new Set([...dates,state.demo.date])].sort():dates);
      renderWatchlist();render()}
  }
  async function hydrateReplayBenchmarks(day,selectedSymbol,requestVersion){
    if(!window.TRADER_UI_V2||state.mode!=='replay'||!state.demo?.bars)return;
    const needed=['SPY','QQQ','SMH'].filter(symbol=>symbol!==selectedSymbol&&
      !Array.isArray(state.demo.bars[symbol]));
    if(!needed.length)return;
    const results=await Promise.all(needed.map(async symbol=>{
      const key=`${day}:${symbol}`;
      if(replayBenchmarkCache.has(key))return [symbol,replayBenchmarkCache.get(key)];
      try{
        let sessions=state.symbolHistory[symbol]?.sessions||replayBenchmarkSessionCache.get(symbol);
        if(!sessions){
          const receipt=await fetch(`watchlist-history/${symbol}.json`,
            {cache:'no-store',signal:AbortSignal.timeout(15000)});
          if(!receipt.ok)return [symbol,null];
          const history=await receipt.json();
          if(history.symbol!==symbol||!Array.isArray(history.dates)||history.dates.length!==30||
             !Array.isArray(history.sessions)||history.sessions.length!==30||
             history.sessions.some((item,index)=>item.date!==history.dates[index]||
               !item.sourceSha256?.trades||!item.sourceSha256?.quotes||item.parityChecks<135))
            return [symbol,null];
          sessions=history.sessions.map(item=>({date:item.date,
            sourceSha256:{trades:item.sourceSha256.trades,quotes:item.sourceSha256.quotes},
            parityChecks:item.parityChecks}));
          replayBenchmarkSessionCache.set(symbol,sessions);
          while(replayBenchmarkSessionCache.size>3)
            replayBenchmarkSessionCache.delete(replayBenchmarkSessionCache.keys().next().value);
        }
        const entry=sessions.find(item=>item.date===day);
        if(!entry)return [symbol,null];
        const response=await fetch(`watchlist-replay/${symbol}/${day}.json`,
          {cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(!response.ok)return [symbol,null];
        const payload=await response.json(),rows=payload.bars?.['1m'];
        if(payload.date!==day||payload.symbol!==symbol||
          payload.sourceSha256?.trades!==entry.sourceSha256?.trades||
          payload.sourceSha256?.quotes!==entry.sourceSha256?.quotes||
          payload.halfMinuteParityChecks!==entry.parityChecks||!Array.isArray(rows)||
          rows.some((row,index)=>!Number.isInteger(row.stampMs)||
            index>0&&row.stampMs<=rows[index-1].stampMs))return [symbol,null];
        if(replayLoadVersion===requestVersion){
          replayBenchmarkCache.set(key,rows);
          while(replayBenchmarkCache.size>6)replayBenchmarkCache.delete(replayBenchmarkCache.keys().next().value);
        }
        return [symbol,rows];
      }catch(_error){return [symbol,null]}
    }));
    if(replayLoadVersion!==requestVersion||state.mode!=='replay'||
       state.symbol!==selectedSymbol||state.demo?.date!==day)return;
    for(const [symbol,rows] of results)if(rows)state.demo.bars[symbol]=rows;
    renderDecisionContext();
  }
  function setReplayDates(dates){
    dates=[...new Set(dates.filter(date=>!isWeekend(date)))].sort();
    state.replayDates=dates;
    const select=$('replay-date'),previous=select.value;
    select.replaceChildren();
    for(const date of [...dates].reverse()){
      const option=document.createElement('option');option.value=date;
      option.textContent=date===chicagoDate(Date.now())?`${date} · today`:date;
      option.dataset.liveSession=String(date===chicagoDate(Date.now()));
      select.append(option);
    }
    if(state.mode==='live'&&!isWeekend(chicagoDate(Date.now())))selectLiveSession();
    else select.value=dates.includes(previous)?previous:dates.at(-1);
  }
  function renderWatchlist(){
    const list=$('watchlist-symbols');list.replaceChildren();
    for(const symbol of state.watchlist){
      const item=document.createElement('span');item.className='watch-item';
      const choose=document.createElement('button');choose.className='watch-select'+(symbol===state.symbol?' active':'');
      choose.textContent=symbol;choose.type='button';choose.setAttribute('aria-label',`Select ${symbol}`);
      choose.setAttribute('aria-pressed',String(symbol===state.symbol));choose.onclick=()=>selectWatchSymbol(symbol);
      item.append(choose);list.append(item);
    }
    const amd=state.symbol==='AMD',liveSymbol=state.watchlist.includes(state.symbol);
    document.title=state.boardMode?'Watchlist Pressure · TradeYodha':liveSymbol?`${state.symbol} Live Tape · TradeYodha`:`${state.symbol} Levels · TradeYodha`;
    $('page-title').textContent=state.boardMode?'Watchlist pressure':liveSymbol?`${state.symbol} minute flow`:`${state.symbol} levels`;
    document.querySelector('.flow').setAttribute('aria-label',`${state.symbol} minute flow`);
    $('price-label').textContent=`${state.symbol} close`;
    $('page-subtitle').textContent=liveSymbol?`Completed 1-, 2-, 5-, or 15-minute candles · ${state.symbol} price, executions, and NBBO pressure`:
      'Selected-symbol premarket, options, and higher-timeframe references';
    $('watch-status').textContent=`Live ingestion: ${state.watchlist.join(', ')}`;
    $('compact-market-label').textContent=amd?'From open':'Since capture';
    $('levels-title').textContent=`Levels to watch · ${state.symbol}`;
    $('quick-level-title').textContent=`Levels to watch · ${state.symbol}`;
    $('main-panel').hidden=state.boardMode;$('watchlist-board').hidden=!state.boardMode;
    $('tape-center').hidden=!liveSymbol;$('symbol-overview').hidden=liveSymbol;$('amd-analytics').hidden=!amd;
    $('view-watchlist').classList.toggle('active',state.boardMode);
    $('view-detail').classList.toggle('active',!state.boardMode);
    $('candle-toolbar').hidden=!liveSymbol;
    for(const id of ['replay-date','session-label'])$(id).hidden=!amd&&!state.symbolHistory[state.symbol];
    $('mode-note').textContent=liveSymbol?'Local Massive WebSocket collector · last completed minute':
      'Selected-symbol levels · completed aggregate reference';
    $('overview-title').textContent=`${state.symbol} · selected symbol`;
    $('overview-price').textContent='—';$('overview-asof').textContent='Loading completed aggregate reference…';
    for(const id of ['overview-mid','overview-support','overview-resistance','overview-pin'])$(id).textContent='—';
    for(const id of ['pm-levels','pin-levels','walls-levels','long-levels'])$(id).textContent='—';
    for(const id of ['quick-pm-high','quick-pm-mid','quick-pm-low'])$(id).textContent='—';
    $('levels-note').textContent='Loading sources for the selected symbol…';
  }
  function selectWatchSymbol(symbol){
    if(!state.watchlist.includes(symbol))return;
    if(state.boardMode){state.boardMode=false;if(symbol===state.symbol){renderWatchlist();render();return}}
    if(symbol===state.symbol)return;
    const wasReplay=state.mode==='replay';
    const replayDate=wasReplay?$('replay-date').value:null;
    const replayStamp=wasReplay?(state.timeframe===.5?
      state.half?.bars?.[state.symbol]?.[state.halfIndex]?.stampMs:
      state.replayTimeline?.[state.index]?.stampMs):null;
    replayLoadVersion++;
    cancelZoneRequest();state.zone=null;state.zoneResult=null;renderZoneInspector();
    state.symbol=symbol;saveWatchlist();
    closeLiveUpdates();
    state.live=null;state.half=null;state.demo=null;state.micro=null;state.sweeps=null;
    state.earlyReplay=null;state.replayTimeline=null;
    state.liveTick=null;state.liveTickVersion=null;state.liveTickRunId=null;
    state.symbolReplayPayload=null;state.selectedStamp=null;state.premarketLevels=null;
    state.premarketGap=null;
    state.optionsWallStatus='pending';
    for(const id of ['compact-call-wall','compact-put-wall']){
      $(id).textContent='—';$(id).parentElement.title='Options reference is loading';
    }
    $('compact-options-status').textContent='Nearby OI · loading daily reference';
    if(wasReplay){
      stop();renderWatchlist();render();status(`Loading ${symbol} replay…`,'warn');
      loadSymbolHistory(symbol).then(async()=>{
        if(state.symbol!==symbol||state.mode!=='replay')return;
        const dates=symbol==='AMD'?[...new Set([
          ...(state.amdReplayDates||[]),...(state.symbolHistory.AMD?.dates||[])])].sort():
          state.symbolHistory[symbol]?.dates;
        if(!dates?.length)throw new Error(`${symbol} replay history unavailable`);
        setReplayDates(dates);
        const date=replayDate===chicagoDate(Date.now())?replayDate:
          dates.includes(replayDate)?replayDate:dates.at(-1);
        if(!dates.includes(date))setReplayDates([...dates,date].sort());
        await loadReplay(date);
        if(state.symbol!==symbol||state.mode!=='replay'||date!==replayDate||replayStamp==null)return;
        const rows=state.timeframe===.5?state.half?.bars?.[symbol]:state.replayTimeline;
        const index=rows?.findLastIndex(row=>row.stampMs<=replayStamp)??-1;
        if(index>=0){if(state.timeframe===.5)state.halfIndex=index;else state.index=index;
          state.chartFocusMs=rows[index].stampMs+(state.timeframe===.5?30_000:60_000);render()}
      }).catch(error=>status(`Could not load ${symbol} replay: ${error.message}`,'bad'));
    }else{
      if(symbol==='AMD'&&state.amdReplayDates)setReplayDates([...new Set([
        ...state.amdReplayDates,...(state.symbolHistory.AMD?.dates||[])])].sort());
      else if(state.symbolHistory[symbol])setReplayDates(state.symbolHistory[symbol].dates);
      renderWatchlist();render();refreshLive().finally(connectLiveUpdates);
      loadSymbolHistory(symbol).catch(error=>status(`${symbol} history unavailable: ${error.message}`,'warn'));
    }
    refreshLevelsCard(true);
  }
  const number = n => n == null ? '—' : Math.round(n).toLocaleString();
  const signed = (n, digits=0) => n == null ? '—' : `${n>0?'+':''}${Number(n).toFixed(digits)}`;
  const money = n => n == null ? '—' : `$${Number(n).toFixed(2)}`;
  const compact = n => n == null ? '—' : `${n>0?'+':n<0?'−':''}$${(Math.abs(n)/1e6).toFixed(1)}M`;
  const signedShares = n => n == null ? '—' : `${n>0?'+':n<0?'−':''}${number(Math.abs(n))}`;
  const flowShares = n => n == null ? '—' : Math.abs(n)<1000?signedShares(n):`${signed(n/1000,1)}K`;
  const tone = (el, n) => {el.classList.remove('positive','negative');if(n>0)el.classList.add('positive');if(n<0)el.classList.add('negative')};
  const activityTheme = (el, bias, mixed=false) => {
    el.classList.remove('activity-buy','activity-sell','activity-mixed');
    if(mixed)el.classList.add('activity-mixed');
    else if(bias>0)el.classList.add('activity-buy');
    else if(bias<0)el.classList.add('activity-sell');
  };
  const tape = () => state.timeframe===.5 ? state.half?.bars : state.mode === 'replay' ? state.demo?.bars : state.live?.bars;
  const minuteTape = () => state.mode === 'replay' ? state.demo?.bars?.[state.symbol] : state.live?.bars?.[state.symbol];
  const minuteClock=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const secondClock=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const clockTime = stampMs => (state.timeframe===.5?secondClock:minuteClock).format(stampMs);
  const clockTimeSeconds = stampMs => secondClock.format(stampMs);
  const intervalLabel=()=>state.timeframe===.5?'30-second':`${state.timeframe}-minute`;
  const replayCursor=()=>state.timeframe===.5?state.half?.bars?.[state.symbol]?.[state.halfIndex]:state.replayTimeline?.[state.index];
  function premarketKnownStampMs(day,asOfCt,complete){
    const queryStampMs=Date.parse(asOfCt);
    if(!complete)return queryStampMs;
    const offset=asOfCt?.match(/([+-]\d{2}:\d{2}|Z)$/)?.[1];
    const completedStampMs=offset?Date.parse(`${day}T08:26:00${offset}`):NaN;
    return Number.isFinite(completedStampMs)?completedStampMs:queryStampMs;
  }
  function visiblePremarketLevels(){
    const selected=state.mode==='replay'?replayCursor():minuteTape()?.at(-1);
    const day=state.mode==='replay'?state.demo?.date:state.live?.date;
    const end=selected?.stampMs+(state.timeframe===.5&&state.mode==='replay'?30_000:60_000);
    const pre=state.premarketLevels;
    const available=pre!=null&&day!=null&&pre.date===day&&Number.isFinite(pre.high)&&Number.isFinite(pre.low)&&
      Number.isFinite(pre.knownStampMs)&&end>=pre.knownStampMs&&
      (pre.complete?selected?.t>='08:25':selected?.t<'08:25');
    return available?pre:null;
  }
  function renderCompactPremarketLevels(){
    const pre=visiblePremarketLevels();
    const available=!!pre;
    $('compact-pm-status').textContent=available?
      (pre.complete?'PM reference · provisional receipt · 03:00–08:25 CT':
        'PM developing · provisional through '+pre.lastCt+' CT'):
      'PM levels · awaiting verified premarket bars';
    $('compact-pm-high').textContent=available?money(pre.high):'—';
    $('compact-pm-mid').textContent=available?money(pre.midpoint):'—';
    $('compact-pm-low').textContent=available?money(pre.low):'—';
  }
  function orbContext(endStampMs,price){
    const opening=(minuteTape()||[]).filter(row=>row.t>='08:30'&&row.t<='08:34'&&
      row.stampMs+60_000<=endStampMs).sort((a,b)=>a.stampMs-b.stampMs);
    if(opening.length!==5||opening.some((row,index)=>!Number.isFinite(row.h)||!Number.isFinite(row.l)||
       (index>0&&row.stampMs!==opening[0].stampMs+index*60_000)))return '5m ORB · waiting for complete 08:30–08:34 tape';
    const high=Math.max(...opening.map(row=>row.h)),low=Math.min(...opening.map(row=>row.l)),mid=(high+low)/2;
    return `5m ORB low ${money(low)} · .50 ${money(mid)} · high ${money(high)}`+
      (Number.isFinite(price)?` · price ${signed(price-mid,2)} from .50`:'');
  }
  const wallClock = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const updateClock = () => {
    $('live-clock').textContent=wallClock.format(Date.now());
    if(state.mode==='live'&&state.liveTick&&!state.boardMode)paintLiveTick(false);
  };
  function aggregate(source, minutes, cutoff){
    if(minutes===.5)return source.filter(r=>r.stampMs+30_000<=cutoff);
    if(minutes===1)return source.filter(r=>r.stampMs+60000<=cutoff);
    const duration=minutes*60000, buckets=new Map();
    for(const row of source){
      const start=Math.floor(row.stampMs/duration)*duration;
      if(start+duration>cutoff)continue;
      if(!buckets.has(start))buckets.set(start,[]);
      buckets.get(start).push(row);
    }
    const sum=(rows,key)=>rows.every(r=>Number.isFinite(r[key]))?
      rows.reduce((n,r)=>n+r[key],0):null;
    const mean=(rows,key)=>{const values=rows.map(r=>r[key]).filter(Number.isFinite);return values.length?values.reduce((a,b)=>a+b,0)/values.length:null};
    return [...buckets].sort((a,b)=>a[0]-b[0]).filter(([stampMs,rows])=>
      rows.length===minutes&&rows.every((row,index)=>row.stampMs===stampMs+index*60000)).map(([stampMs,rows])=>{
      const last=rows.at(-1),litShares=sum(rows,'litShares'),buy=sum(rows,'buy'),sell=sum(rows,'sell');
      const priced=rows.filter(r=>Number.isFinite(r.c));
      return {t:clockTime(stampMs),stampMs,o:priced[0]?.o??null,h:priced.length?Math.max(...priced.map(r=>r.h)):null,l:priced.length?Math.min(...priced.map(r=>r.l)):null,c:priced.at(-1)?.c??null,
        litShares,buy,sell,delta:buy!=null&&sell!=null?buy-sell:null,imbalancePct:buy!=null&&sell!=null&&buy+sell?(buy-sell)/(buy+sell)*100:null,
        coveragePct:litShares!=null&&buy!=null&&sell!=null&&litShares?(buy+sell)/litShares*100:null,netOutflowUsd:rows.every(r=>Number.isFinite(r.netOutflowUsd))?sum(rows,'netOutflowUsd'):null,
        ofi:mean(rows,'ofi'),quoteUpdates:sum(rows,'quoteUpdates'),
        quoteUsableMinutes:rows.filter(window.TRADEYODHA_TAPE_INTEL.quoteUsable).length,
        quoteTotalMinutes:rows.length,queue:last.queue,medianSpreadCents:mean(rows,'medianSpreadCents'),
        midMoveCents:rows.every(r=>Number.isFinite(r.midMoveCents))?sum(rows,'midMoveCents'):null,quoteAgeMs:last.quoteAgeMs};
    });
  }
  const current = () => {
    const bars = tape();if(!bars)return [];
    if(state.mode==='replay'&&replayCursor()?.priceOnly)return [];
    const source=state.mode==='replay'?(bars[state.symbol]||[]).filter(row=>row.stampMs<=replayCursor()?.stampMs):bars[state.symbol];
    const cutoff=source.at(-1)?.stampMs+state.timeframe*60000;
    if(!cutoff)return [];
    return aggregate(source,state.timeframe,cutoff);
  };
  function setReplayView(view){
    if(!REPLAY_TRADER_V1||!['replay','live'].includes(state.mode))return;
    state.replayView=view==='research'?'research':'trader';
    saveTabValue(REPLAY_VIEW_KEY,state.replayView);
    applyReplayView();render();
  }
  function applyReplayView(){
    $('dashboard').classList.toggle('replay-workspace',state.mode==='replay');
    const workspace=REPLAY_TRADER_V1&&['replay','live'].includes(state.mode);
    const trader=false;
    $('dashboard').classList.toggle('replay-trader-v1',trader);
    $('dashboard').classList.toggle('tape-research-view',workspace&&!trader&&!state.boardMode);
    $('chart-panel-toggle').setAttribute('aria-controls',trader?'trader-snapshot':'chart-formation');
    $('replay-view-switch').hidden=true;
    $('trader-snapshot').hidden=!trader;
    $('trader-strip').hidden=!trader;
    $('footprint-panel').hidden=!workspace||trader||state.boardMode;
    $('research-context').hidden=!workspace||trader||state.boardMode;
    $('replay-view-trader').classList.toggle('active',trader);
    $('replay-view-research').classList.toggle('active',workspace&&!trader);
    $('replay-view-trader').setAttribute('aria-pressed',String(trader));
    $('replay-view-research').setAttribute('aria-pressed',String(workspace&&!trader));
  }
  function traderLevels(endMs){
    const levels=[];
    const pre=visiblePremarketLevels();
    if(pre&&pre.knownStampMs<=endMs){
      for(const [name,value] of [['PM high',pre.high],['PM .50',pre.midpoint],['PM low',pre.low]])
        if(Number.isFinite(value))levels.push({name,value,availableMs:pre.knownStampMs,
          provisional:true,source:'PM aggregate; original receipt and full early-session price-forming tape unverified'});
    }
    const opening=(minuteTape()||[]).filter(row=>row.t>='08:30'&&row.t<='08:34'&&
      row.stampMs+60_000<=endMs).sort((a,b)=>a.stampMs-b.stampMs);
    if(opening.length===5&&opening.every((row,index)=>Number.isFinite(row.h)&&Number.isFinite(row.l)&&
      (!index||row.stampMs===opening[0].stampMs+index*60_000))){
      const hi=Math.max(...opening.map(row=>row.h)),lo=Math.min(...opening.map(row=>row.l));
      for(const [name,value] of [['ORB high',hi],['ORB .50',(hi+lo)/2],['ORB low',lo]])
        levels.push({name,value,availableMs:opening.at(-1).stampMs+60_000,
          provisional:false,source:'Five completed 08:30–08:34 candles'});
    }
    return levels;
  }
  let traderStripRenderKey='';
  function renderTraderView(rows,activeRow){
    if(!window.TRADER_UI_V2||state.boardMode||state.replayView!=='trader')return;
    const intel=window.TRADEYODHA_TAPE_INTEL;
    const duration=state.timeframe*60_000,last=rows.at(-1);
    const selected=rows.find(item=>item.stampMs===state.selectedStamp);
    const cursor=state.mode==='replay'?replayCursor():null;
    const shown=selected||activeRow||last||(cursor?.priceOnly?cursor:null);
    const isLive=state.mode==='live',currentDay=state.live?.date===chicagoDate(Date.now());
    const feedFresh=!isLive||currentDay&&state.live?.status==='connected'&&
      Number.isFinite(state.live?.eventLagSeconds)&&state.live.eventLagSeconds<=15&&
      Number.isFinite(state.live?.receivedAgeSeconds)&&state.live.receivedAgeSeconds<=15;
    const tick=isLive?chartTick():null;
    const freshTick=feedFresh&&tick&&Date.now()-tick.eventMs<=5_000?tick:null;
    const asof=selected?selected.stampMs+duration:isLive?
      (shown?.partial?shown.throughMs:last?last.stampMs+duration:null):
      cursor?cursor.stampMs+(state.timeframe===.5?30_000:60_000):null;
    const quality=shown&&!shown.partial&&!cursor?.priceOnly&&state.mode==='replay'?
      replayQualityItem(shown.stampMs):null;
    const evidence=quality?window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence(
      {...shown,complete:true},quality,state.timeframe):null;
    const summary=cursor?.priceOnly?intel.summarize(null,duration):
      intel.summarize(shown,duration,{provisional:!!shown?.partial,
        feedFresh,replayQuality:state.mode==='replay'?evidence?.kind||'missing':null});
    $('trader-symbol').textContent=state.symbol;
    $('trader-asof').textContent=asof?`${selected?'Selected':isLive?'Live':'As of'} ${clockTimeSeconds(asof)} CT`:
      isLive?'Live · waiting for candle':'Replay —';
    $('trader-timeframe').textContent=cursor?.priceOnly?`${intervalLabel()} chart · price only`:intervalLabel();
    // The primary price, OHLC and pressure always refer to the same candle.
    $('trader-price').textContent=money(isLive&&!currentDay?null:shown?.c);
    $('trader-live-status').hidden=!isLive;
    if(isLive){
      $('trader-live-status').textContent=!currentDay?'No current session · price masked':
        !feedFresh?'Feed stale or disconnected · last recorded close':
          selected?'Selected candle close':'Last completed or provisional candle close';
      $('trader-live-status').className=feedFresh?'live-price-status qualified':'live-price-status stale';
    }
    $('trader-current-tick').hidden=!isLive||!freshTick;
    if(isLive&&freshTick)$('trader-current-tick').textContent=
      `Current trade ${money(freshTick.c)} · ${clockTimeSeconds(freshTick.eventMs)} CT`;
    const candleEnd=shown?.partial?shown.throughMs:shown?.stampMs+duration;
    const level=intel.nearestLevel(traderLevels(candleEnd),shown?.c,candleEnd);
    const reaction=level?intel.levelResponse(rows,level,candleEnd):null;
    $('trader-level').textContent=level?`${level.name} ${money(level.value)} · ${signed(shown.c-level.value,2)} USD · ${reaction||'reaction unavailable'} · ${level.provisional?'provisional / receipt unverified':'completed and available'}`:
      'No as-of verified PM / ORB reference';
    $('trader-candle-time').textContent=cursor?.priceOnly?
      `${clockTime(cursor.stampMs)} CT · historical price-only aggregate`:
      shown?`${shown.partial?'PROVISIONAL through '+clockTimeSeconds(shown.throughMs):selected?'Selected complete':'Completed'} ${clockTime(shown.stampMs)}–${clockTime(shown.stampMs+duration)} CT`:
      'No completed candle';
    $('trader-quality').textContent=cursor?.priceOnly?'Trade/quote N/A · price-only aggregate':
      `${summary.state.replaceAll('-',' ')}${summary.provisional?' · provisional':''} · ${summary.coverage==null?'coverage unavailable':summary.coverage.toFixed(1)+'% classified'} · ${summary.quoteAgeMs==null?'quote age unavailable':Math.round(summary.quoteAgeMs)+' ms quote age'}`;
    $('trader-quality').className=summary.state;
    const shownNumber=value=>Number.isFinite(value)?number(value):'N/A';
    $('trader-ohlc').textContent=shown&&[shown.o,shown.h,shown.l,shown.c].every(Number.isFinite)?
      [shown.o,shown.h,shown.l,shown.c].map(money).join(' / '):'N/A';
    $('trader-sides').textContent=`${shownNumber(summary.buy)} / ${shownNumber(summary.sell)} / ${shownNumber(summary.unknown)}`;
    $('trader-delta').textContent=summary.delta==null?'N/A':`${flowShares(summary.delta)} · ${signed(summary.imbalance,1)}%`;
    $('trader-intensity').textContent=summary.intensity==null?'N/A':
      `${shownNumber(summary.lit)} · ${number(Math.round(summary.intensity))}/s`;
    $('trader-coverage').textContent=summary.coverage==null?'N/A':`${summary.coverage.toFixed(1)}%`;
    $('trader-ofi').textContent=summary.ofi==null?'N/A':`${signed(summary.ofi,3)} · ${summary.quoteAgeMs==null?'age N/A':Math.round(summary.quoteAgeMs)+' ms'}`;
    $('trader-ofi-label').textContent=state.timeframe>1?'Mean available 1m quote OFI · age':'Quote OFI · age';
    $('trader-change').textContent=summary.priceMove==null?'N/A':`${signed(summary.priceMove,2)} USD`;
    $('trader-spread').textContent=summary.spreadCents==null?'N/A':`${summary.spreadCents.toFixed(1)}¢`;
    $('trader-observation').textContent=summary.observation;
    $('trader-observation').dataset.state=summary.state;
    $('trader-strip-note').textContent=`${isLive?'Live':'Replay'} · ${intervalLabel()} · completed candles only`;
    const stamps=last?Array.from({length:8},(_,i)=>last.stampMs-(7-i)*duration):[];
    const byStamp=new Map(rows.map(item=>[item.stampMs,item]));
    const stripInputs=stamps.map(stamp=>({stampMs:stamp,bar:byStamp.get(stamp)||null,
      quality:state.mode==='replay'?replayQualityItem(stamp):null,
      levels:byStamp.has(stamp)?traderLevels(stamp+duration):[]}));
    const stripKey=intel.stripEvidenceKey({mode:state.mode,symbol:state.symbol,
      timeframe:state.timeframe,selectedStamp:state.selectedStamp,
      replayQualityStatus:state.replayQualityStatus,feedFresh},stripInputs);
    if(traderStripRenderKey===stripKey)return;
    traderStripRenderKey=stripKey;
    const grid=$('trader-strip-grid');grid.replaceChildren();
    if(!last){grid.textContent='No completed candles for the current session';return}
    for(const {stampMs:stamp,bar,quality:item,levels} of stripInputs){
      const button=document.createElement('button');
      button.type='button';button.className='trader-window';
      if(stamp===state.selectedStamp)button.classList.add('selected');
      const ev=item?window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence(
        {...bar,complete:true},item,state.timeframe):null;
      const reading=intel.summarize(bar,duration,{feedFresh,
        replayQuality:state.mode==='replay'?ev?.kind||'missing':null});
      const label=document.createElement('strong');label.textContent=clockTime(stamp);button.append(label);
      const direction=document.createElement('span');direction.textContent=reading.priceMove==null?'Price N/A':
        `Price ${signed(reading.priceMove,2)}`;button.append(direction);
      const sides=document.createElement('span');sides.className='trader-window-sides';
      for(const [label,value] of [['B',reading.buy],['S',reading.sell],['U',reading.unknown]]){
        const part=document.createElement('span');part.textContent=`${label} ${value==null?'N/A':flowShares(value)}`;
        sides.append(part);
      }
      button.append(sides);
      const delta=document.createElement('span');delta.textContent=reading.delta==null?'Δ N/A':`Δ ${flowShares(reading.delta)}`;
      delta.className=reading.state==='qualified'?(reading.delta>0?'positive':reading.delta<0?'negative':''):'unreliable';button.append(delta);
      const activity=document.createElement('small');activity.textContent=reading.intensity==null?'Activity N/A':
        `${number(Math.round(reading.intensity))} lit shares/s`;button.append(activity);
      const nearest=intel.nearestLevel(levels,bar?.c,stamp+duration);
      const badge=document.createElement('small');badge.textContent=!bar?'Missing':
        `${reading.state} · ${reading.coverage==null?'coverage N/A':reading.coverage.toFixed(0)+'%'}${nearest?' · '+nearest.name+' '+signed(bar.c-nearest.value,2):''}`;button.append(badge);
      button.disabled=!bar;
      button.setAttribute('aria-label',bar?`Select ${clockTime(stamp)} CT completed candle; ${direction.textContent}; ${sides.textContent}; ${delta.textContent}; ${badge.textContent}`:
        `Missing ${clockTime(stamp)} CT candle`);
      if(bar)button.onclick=()=>{state.selectedStamp=stamp;render()};
      grid.append(button);
    }
  }
  const volumeBaselineCache=new Map(),volumeBaselinePending=new Set();
  async function loadVolumeBaselines(symbol,day){
    const key=`${symbol}:${day}`;
    if(volumeBaselineCache.has(key)||volumeBaselinePending.has(key))return;
    const sessions=(state.symbolHistory[symbol]?.sessions||[]).filter(item=>item.date<day).slice(-14);
    if(sessions.length!==14)return;
    volumeBaselinePending.add(key);
    try{
      const rows=[];
      for(const entry of sessions){
        const response=await fetch(`watchlist-replay/${symbol}/${entry.date}.json`,
          {cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error(`History HTTP ${response.status}`);
        const payload=await response.json(),bars=payload.bars?.['1m'];
        if(payload.symbol!==symbol||payload.date!==entry.date||
          payload.sourceSha256?.trades!==entry.sourceSha256?.trades||
          payload.sourceSha256?.quotes!==entry.sourceSha256?.quotes||
          payload.halfMinuteParityChecks!==entry.parityChecks||!Array.isArray(bars)||!bars.length||
          bars.some((bar,index)=>!Number.isFinite(bar.stampMs)||index&&bar.stampMs<=bars[index-1].stampMs))
          throw new Error('History provenance or chronology mismatch');
        rows.push(bars.map(bar=>({t:bar.t,litShares:bar.litShares,
          offExchangeShares:bar.offExchangeShares,buy:bar.buy,sell:bar.sell})));
      }
      volumeBaselineCache.set(key,rows);
    }catch(_error){volumeBaselineCache.set(key,null)}
    finally{volumeBaselinePending.delete(key);if(state.symbol===symbol&&
      (state.mode==='replay'?state.demo?.date:state.live?.date)===day)renderVolumePanel()}
  }
  function renderVolumePanel(){
    if(!window.TRADER_UI_V2)return;
    const symbol=state.symbol,replay=state.mode==='replay',day=replay?state.demo?.date:state.live?.date;
    const source=replay?state.demo?.bars?.[symbol]:state.live?.bars?.[symbol];
    const selected=replay&&state.selectedStamp!=null?
      current().find(row=>row.stampMs===state.selectedStamp):null;
    const cutoff=replay?(selected?.stampMs+state.timeframe*60_000||
      (replayCursor()?.stampMs+(state.timeframe===.5?30_000:60_000))):
      source?.at(-1)?.stampMs+60_000;
    const endCt=Number.isFinite(cutoff)?minuteClock.format(cutoff):null;
    const volumeThrough=Number.isFinite(cutoff)?clockTime(cutoff-60_000).slice(0,5):null;
    const last=selected||current().at(-1);
    const tick=!replay?chartTick():null;
    const freshTick=tick&&Date.now()-tick.eventMs<=5_000&&state.live?.status==='connected'?tick:null;
    const price=freshTick?.c??last?.c??(replay?replayCursor()?.c:null),oiAsOf=replay?cutoff:freshTick?.eventMs??cutoff;
    const staleLive=!replay&&(state.live?.date!==chicagoDate(Date.now())||
      state.live?.status!=='connected'||state.live?.eventLagSeconds>15||
      state.live?.receivedAgeSeconds>15);
    const loadingReplay=replay&&!state.demo;
    const priceOnlyCursor=replay&&replayCursor()?.priceOnly;
    const summary=!staleLive&&!priceOnlyCursor&&endCt?
      window.TRADEYODHA_VOLUME_PROFILE?.summarize(source,endCt,replay?'06:00':'03:00'):null;
    const baseline=volumeBaselineCache.get(`${symbol}:${day}`),profile=window.TRADEYODHA_VOLUME_PROFILE;
    const avgPm=replay&&baseline&&profile.meanOf14(baseline,'08:30','premarket');
    const avgMarket=baseline&&endCt&&profile.meanOf14(baseline,endCt,'market');
    const shares=value=>Number.isFinite(value)?number(value):'N/A';
    const options=state.chartOptions?.symbol===symbol&&state.chartOptions.date===day?
      state.chartOptions.report:null;
    const validOptions=!staleLive&&options?.available&&options.sessionDate===day&&
      Number.isFinite(options.capturedStampMs)&&options.capturedStampMs<=oiAsOf&&Number.isFinite(price);
    const calls=validOptions?nearbyOi(options,'call',price):null;
    const puts=validOptions?nearbyOi(options,'put',price):null;
    const byStrike=new Map();
    if(validOptions)for(const side of ['call','put'])for(const item of options.oiByStrike?.[side]||[]){
      if(!Number.isFinite(item.strike)||!Number.isFinite(item.openInterest)||item.openInterest<=0||
        Math.abs(item.strike-price)>price*.03)continue;
      const entry=byStrike.get(item.strike)||{strike:item.strike,call:0,put:0};
      entry[side]+=item.openInterest;byStrike.set(item.strike,entry);
    }
    const major=[...byStrike.values()].sort((a,b)=>b.call+b.put-a.call-a.put||
      Math.abs(a.strike-price)-Math.abs(b.strike-price)).slice(0,3);
    const pin=validOptions&&Number.isFinite(options.grossGammaPinProxy?.strike)&&
      Number.isFinite(options.grossGammaPinProxy?.grossGammaDollarPer1Pct)?options.grossGammaPinProxy:null;
    const relative=(strike)=>`${money(Math.abs(strike-price))} · ${(100*Math.abs(strike-price)/price).toFixed(2)}% ${strike>price?'above':strike<price?'below':'at'} price`;
    const compare=(actual,average)=>Number.isFinite(actual)&&Number.isFinite(average)&&average>0?
      ` · ${(100*actual/average).toFixed(0)}% of avg`:'';
    for(const panel of document.querySelectorAll('.workspace-volume-panel')){
      const put=(field,value)=>{panel.querySelector(`[data-volume-${field}]`).textContent=value};
      put('symbol',symbol);put('price',money(price));
      const priceEnd=freshTick?freshTick.eventMs:last?
        last.stampMs+state.timeframe*60_000:replay&&replayCursor()?
        replayCursor().stampMs+(state.timeframe===.5?30_000:60_000):null;
      put('price-time',loadingReplay?(state.replayLoadError?'Replay unavailable':'Loading replay…'):Number.isFinite(priceEnd)?
        `${staleLive?'Last recorded':freshTick?'Latest trade':'Completed candle'} · ${clockTimeSeconds(priceEnd)} CT${staleLive?' · feed unavailable':''}`:
        'Waiting for a completed candle');
      const volumeStart=replay?'06:00':sessionWindow().startCt;
      put('pm-window',loadingReplay?(state.replayLoadError?'Premarket · replay unavailable':'Premarket · loading session…'):
        priceOnlyCursor?'Premarket · 03:00–05:59 price-only aggregate':
        endCt&&endCt<=volumeStart?`Premarket · awaiting first completed ${volumeStart} minute`:
        endCt&&endCt<'08:30'?`Premarket · classified ${volumeStart}–${volumeThrough} CT`:
        `Premarket · classified ${volumeStart}–08:29 CT`);
      const noTape=loadingReplay?(state.replayLoadError?'Replay unavailable':'Loading replay…'):staleLive?'Feed stale':
        priceOnlyCursor?'Price-only history':'No recorded trades yet';
      put('pm',summary?.premarket?shares(summary.premarket.recorded):noTape);
      put('market',summary?.market?shares(summary.market.recorded):
        loadingReplay?noTape:!endCt||endCt<='08:30'?'Waiting for 08:30':noTape);
      for(const [period,values] of [['pm',summary?.premarket],['market',summary?.market]])
        panel.querySelector(`[data-volume-${period}]`).classList.toggle('pending',!values);
      for(const [period,values] of [['pm',summary?.premarket],['market',summary?.market]])
        for(const side of ['buy','sell'])
          put(`${period}-${side}`,values?shares(values[side]):'—');
      const average=(field,value)=>{const node=panel.querySelector(`[data-volume-${field}-average]`);
        node.hidden=!value;node.textContent=value||''};
      average('pm',replay&&summary?.premarket&&Number.isFinite(avgPm)?
        `14-session 06:00+ average ${shares(avgPm)}${endCt>='08:30'?compare(summary.premarket.recorded,avgPm):''}`:'');
      average('market',summary?.market&&Number.isFinite(avgMarket)?
        `14-session same-time average ${shares(avgMarket)}${compare(summary.market.recorded,avgMarket)}`:'');
      for(const [part,actual,average] of [['pm',summary?.premarket?.recorded,avgPm],
        ['market',summary?.market?.recorded,avgMarket]]){
        const tile=panel.querySelector(`[data-volume-period="${part}"]`);
        const comparable=part==='market'||endCt>='08:30';
        tile.classList.toggle('above-average',comparable&&Number.isFinite(actual)&&Number.isFinite(average)&&actual>=average);
        tile.classList.toggle('below-average',comparable&&Number.isFinite(actual)&&Number.isFinite(average)&&actual<average);
      }
      put('status',loadingReplay?(state.replayLoadError?`Replay unavailable: ${state.replayLoadError}`:'Loading verified replay sources…'):
        staleLive?'Live source stale or disconnected · volumes masked':
        priceOnlyCursor?'03:00–05:59 historical aggregates are price-only; original receipt, buyer/seller, quote OFI, and classified volume N/A.':
        `Recorded lit + off-exchange shares through ${volumeThrough||'the latest completed minute'} CT. Buyer/seller are estimated classified lit shares, so they may not sum to recorded volume.`);
      put('call',calls?`${money(calls.strike)} · ${shares(calls.openInterest)} contracts`:loadingReplay?'—':'N/A');
      put('put',puts?`${money(puts.strike)} · ${shares(puts.openInterest)} contracts`:loadingReplay?'—':'N/A');
      put('call-distance',calls?relative(calls.strike):validOptions?
        'No call strike above price within 3%':loadingReplay?
          (state.replayLoadError?'Replay unavailable':'Loading options reference…'):'No eligible options snapshot for this session');
      put('put-distance',puts?relative(puts.strike):validOptions?
        'No put strike below price within 3%':loadingReplay?
          (state.replayLoadError?'Replay unavailable':'Loading options reference…'):'No eligible options snapshot for this session');
      const majorBox=panel.querySelector('[data-volume-major]');majorBox.replaceChildren();
      if(major.length){const label=document.createElement('small');label.textContent='Major nearby OI · ±3% of displayed price';majorBox.append(label);
        for(const item of major){const row=document.createElement('div');row.className='workspace-major-row';
          for(const [kind,value] of [['strike',money(item.strike)],['call',`C ${shares(item.call)}`],['put',`P ${shares(item.put)}`]]){
            const span=document.createElement('span');span.className=kind;span.textContent=value;row.append(span)}majorBox.append(row)}
      }else majorBox.textContent=loadingReplay?
        (state.replayLoadError?'Replay unavailable':'Loading nearby OI…'):'Major nearby OI N/A';
      put('pin',pin?money(pin.strike):loadingReplay?'—':'N/A');
      put('pin-distance',pin?`${relative(pin.strike)} · unsigned gross gamma peak`:
        loadingReplay?(state.replayLoadError?'Replay unavailable':'Loading options reference…'):
          'Insufficient as-of gamma data; expiration max pain unavailable');
      put('oi-status',loadingReplay?(state.replayLoadError?'Replay unavailable':'Loading point-in-time options reference…'):validOptions?`Daily open interest · captured ${clockTimeSeconds(options.capturedStampMs)} CT · walls recalculate around displayed price; OI itself does not update intraday. Expiration max pain N/A from combined-expiration OI.`:
        `OI N/A · ${options?.reason||'no point-in-time eligible daily snapshot'}`);
    }
    if(day&&!volumeBaselineCache.has(`${symbol}:${day}`))loadVolumeBaselines(symbol,day);
  }
  function sizeWorkspaceHero(){
    if(!window.TRADER_UI_V2)return;
    const hero=document.querySelector('#dashboard .chart-first-hero');
    if(!hero||hero.closest('[hidden]'))return;
    if(window.innerWidth<=760){hero.style.height='';return}
    const height=Math.max(360,Math.floor(window.innerHeight-hero.getBoundingClientRect().top-8));
    if(hero.style.height!==`${height}px`)hero.style.height=`${height}px`;
  }
  window.addEventListener('resize',()=>requestAnimationFrame(sizeWorkspaceHero));
  let chartLiveGeometry=null;
  let professionalRenderQueued=false;
  let lastProfessionalLivePaint=0;
  let lastLiveOiPanelPaint=0;
  const chartPriceScale={key:null,zoom:1};
  let chartPriceDrag=null;
  function chartTick(){
    const tick=state.liveTick;
    if(state.mode!=='live'||!tick||state.live?.date!==chicagoDate(tick.eventMs)||
       ![tick.o,tick.h,tick.l,tick.c,tick.stampMs,tick.eventMs].every(Number.isFinite))return null;
    if(tick.eventMs>Date.now()+3_000)return null;
    return tick;
  }
  function renderChartReadout(row,context='Latest complete'){
    $('chart-readout-time').textContent=row?
      `${context} ${clockTime(row.stampMs)}–${clockTime(row.stampMs+state.timeframe*60_000)} CT · close ${money(row.c)}`:
      'Waiting for candle';
    const hasVolume=row&&[row.buy,row.sell,row.litShares].every(value=>
      Number.isFinite(value)&&value>=0)&&row.buy+row.sell<=row.litShares;
    $('chart-volume-buy').textContent=hasVolume?`Buyer ${number(row.buy)}`:'Buyer N/A';
    $('chart-volume-sell').textContent=hasVolume?`Seller ${number(row.sell)}`:'Seller N/A';
    $('chart-volume-lit').textContent=hasVolume?`Lit shares ${number(row.litShares)}`:'Lit shares N/A';
    $('chart-volume-coverage').textContent=hasVolume&&row.litShares>0?
      `${Math.round((row.buy+row.sell)/row.litShares*100)}% processed candle classified`:'Coverage unavailable';
    const delta=hasVolume?row.buy-row.sell:null;
    $('chart-volume-delta').textContent=hasVolume?`Delta ${delta>=0?'+':'−'}${number(Math.abs(delta))}`:'Delta N/A';
    $('chart-volume-delta').className=hasVolume?(delta>0?'positive':delta<0?'negative':''):'';
    const sweepLine=$('chart-sweep-evidence');
    const cursor=replayCursor();
    const sweepAsOf=cursor?.stampMs+(state.timeframe===.5?30_000:60_000);
    const sweepRows=state.sweeps&&state.demo&&state.sweeps.symbol===state.symbol&&
      state.sweeps.date===state.demo.date?
      state.sweeps.bars:state.symbol==='AMD'&&state.micro&&state.demo&&
      state.micro.date===state.demo.date?
        state.micro.bars:null;
    const sweepQualified=row?.complete&&!row.priceOnly&&row.deltaConstituentsValid!==false&&
      Number.isFinite(row.litShares)&&row.litShares>0&&
      Number.isFinite(row.buy)&&Number.isFinite(row.sell)&&
      (row.buy+row.sell)/row.litShares>=.65;
    const sweep=sweepQualified&&state.mode==='replay'&&sweepRows?
      window.TRADEYODHA_REPLAY_CHART.sweepCandidatesForCandle(
        sweepRows,row.stampMs,state.timeframe*60_000,sweepAsOf):null;
    sweepLine.textContent=sweep?
      `Sweep candidates · Sell ${sweep.sell} / Buy ${sweep.buy}`:
      !row?.complete?'Sweep candidates · awaiting close':
      state.mode==='live'?'Sweep candidates · replay only':
      'Sweep candidates · no verified tape for this candle';
    sweepLine.setAttribute('aria-label',sweep?
      `Estimated sweep candidates of at least 1,000 shares: ${sweep.sell} sell groups totaling ${number(sweep.sellShares)} shares; ${sweep.buy} buy groups totaling ${number(sweep.buyShares)} shares. These are not confirmed parent orders.`:
      sweepLine.textContent);
    const ofiValid=row?.complete&&!row.priceOnly&&Number.isFinite(row.ofi)&&Math.abs(row.ofi)<=1&&
      Number.isFinite(row.quoteUpdates)&&row.quoteUpdates>=3&&
      Number.isFinite(row.quoteAgeMs)&&row.quoteAgeMs>=0&&row.quoteAgeMs<=2000&&
      (state.timeframe<=1||row.quoteUsableMinutes===state.timeframe)&&
      row.ofiEvidence?.valid!==false;
    $('chart-ofi-readout').textContent=ofiValid?
      `Quote OFI ${row.ofi>=0?'+':''}${row.ofi.toFixed(2)} · ${row.ofi>0?'bid-side':row.ofi<0?'ask-side':'balanced'} pressure`:
      'Quote OFI N/A · missing, stale, or incomplete quotes';
  }
  function renderTimeJumps(rows,cutoff){
    const nav=$('chart-time-jumps');if(!nav)return;
    const slots=window.TRADEYODHA_REPLAY_CHART?.timelineJumpRows(
      rows,cutoff,state.timeframe,clockTime)||[];
    const latest=window.TRADEYODHA_REPLAY_CHART?.decisionSnapshot(
      rows,cutoff,state.timeframe)?.row;
    if(latest&&!slots.some(item=>item.stampMs===latest.stampMs))
      slots.push({label:`Latest ${clockTime(latest.stampMs).slice(0,5)}`,stampMs:latest.stampMs});
    const key=slots.map(item=>`${item.label}:${item.stampMs}`).join('|');
    if(nav.dataset.slots!==key){
      nav.dataset.slots=key;nav.replaceChildren();
      if(slots.length){
        const label=document.createElement('span');label.textContent='Jump';nav.append(label);
        for(const item of slots){
          const button=document.createElement('button');button.type='button';
          button.textContent=item.label;button.dataset.stampMs=String(item.stampMs);
          button.title=`Center chart on completed ${clockTime(item.stampMs)} CT candle`;
          nav.append(button);
        }
      }
    }
    nav.hidden=!slots.length;
    for(const button of nav.querySelectorAll('button'))
      button.setAttribute('aria-current',String(Number(button.dataset.stampMs)===state.selectedStamp));
  }
  const zoneNode=(tag,className,text)=>{const node=document.createElement(tag);
    if(className)node.className=className;if(text!=null)node.textContent=text;return node};
  const zoneCompact=value=>Math.abs(value)>=1000?`${(Math.abs(value)/1000).toFixed(1)}K`:
    number(Math.round(Math.abs(value)));
  const zoneSigned=value=>`${value<0?'−':value>0?'+':''}${zoneCompact(value)}`;
  const zonePriceMove=value=>`${value<0?'−':value>0?'+':''}$${Math.abs(value).toFixed(2)}`;
  const zoneIntervalLabel=ms=>ms===30_000?'30s':`${ms/60_000}m`;
  function zoneCombinedChart(result){
    const wrap=zoneNode('div','zone-combined');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','zone-combined-svg');svg.setAttribute('viewBox','0 0 360 190');
    svg.setAttribute('role','img');svg.setAttribute('aria-label',
      `Completed ${zoneIntervalLabel(result.intervalMs)} candles: green positive and red negative in-zone trade delta bars; cyan full-market closing price; amber unavailable intervals`);
    const add=(tag,attrs,parent=svg)=>{const item=document.createElementNS(svg.namespaceURI,tag);
      for(const [key,value] of Object.entries(attrs))item.setAttribute(key,String(value));
      parent.append(item);return item};
    const left=44,right=311,top=14,bottom=157,width=right-left,height=bottom-top;
    const series=result.series,slot=width/series.length,zeroY=top+height/2;
    const recorded=series.filter(item=>!item.gap);
    if(!recorded.length)return zoneNode('div','zone-unavailable',
      'No verified completed candles in this selection.');
    const maxDelta=Math.max(1,...recorded.map(item=>Math.abs(item.delta)));
    const deltaY=value=>zeroY-value/maxDelta*(height/2-8);
    const prices=recorded.flatMap(item=>[item.priceOpen,item.priceClose]);
    const minPrice=Math.min(...prices),maxPrice=Math.max(...prices);
    const pricePad=Math.max(.01,(maxPrice-minPrice)*.12);
    const priceLow=minPrice-pricePad,priceHigh=maxPrice+pricePad;
    const priceY=value=>bottom-(value-priceLow)/(priceHigh-priceLow)*height;
    const axis=(x,y,value,anchor,kind)=>{const label=add('text',
      {x,y,'text-anchor':anchor,class:`zone-axis ${kind}`});label.textContent=value;return label};
    add('line',{x1:left,y1:top,x2:left,y2:bottom,class:'zone-axis-line'});
    add('line',{x1:right,y1:top,x2:right,y2:bottom,class:'zone-axis-line'});
    add('line',{x1:left,y1:zeroY,x2:right,y2:zeroY,class:'zone-zero-line'});
    axis(left-5,top+4,`+${zoneCompact(maxDelta)}`,'end','delta');
    axis(left-5,zeroY+3,'0','end','delta');
    axis(left-5,bottom,`−${zoneCompact(maxDelta)}`,'end','delta');
    axis(right+5,top+4,money(priceHigh),'start','price');
    axis(right+5,zeroY+3,money((priceHigh+priceLow)/2),'start','price');
    axis(right+5,bottom,money(priceLow),'start','price');
    series.forEach((item,index)=>{
      if(item.gap){add('rect',{x:left+index*slot,y:top,width:slot,height,
        class:'zone-bucket-gap','data-stamp-ms':item.stampMs});return}
      const x=left+(index+.5)*slot, y=deltaY(item.delta);
      add('rect',{x:x-Math.max(.35,slot*.35),y:Math.min(y,zeroY),
        width:Math.max(.7,slot*.7),height:Math.max(.8,Math.abs(y-zeroY)),
        class:`zone-delta-bar ${item.delta>0?'positive':item.delta<0?'negative':'zero'}`,
        'data-stamp-ms':item.stampMs,'data-delta':item.delta});
    });
    let points=[];
    const flushPrice=()=>{if(points.length){add('polyline',
      {points:points.map(([x,y])=>`${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
        class:'zone-price-line','data-start-price':result.startPrice??''});points=[]}};
    series.forEach((item,index)=>{
      if(item.gap){flushPrice();return}
      if(!points.length)points.push([left+index*slot,priceY(item.priceOpen)]);
      points.push([left+(index+1)*slot,priceY(item.priceClose)]);
    });
    flushPrice();
    const timeTickEvery=Math.max(1,Math.ceil((result.intervalMs===30_000?52:34)/slot));
    const timeTickIndices=new Set([0,series.length-1]);
    for(let index=timeTickEvery;index<series.length-1;index+=timeTickEvery)
      if(series.length-1-index>=timeTickEvery)timeTickIndices.add(index);
    for(const index of [...timeTickIndices].sort((a,b)=>a-b)){
      const x=left+(index+.5)*slot,stamp=series[index].stampMs;
      add('line',{x1:x,y1:bottom,x2:x,y2:bottom+3,class:'zone-time-tick'});
      axis(x,bottom+15,result.intervalMs===30_000?clockTimeSeconds(stamp):
        clockTimeSeconds(stamp).slice(0,5),'middle','time')
        .setAttribute('data-stamp-ms',stamp);
    }
    const hoverText=`Hover a ${zoneIntervalLabel(result.intervalMs)} candle for B/S estimates, delta, price and quality.`;
    const hover=zoneNode('div','zone-combined-hover',hoverText);
    svg.addEventListener('pointerleave',()=>{hover.textContent=
      hoverText});
    series.forEach((item,index)=>{
      const hit=add('rect',{x:left+index*slot,y:top,width:slot,height,
        class:'zone-bucket-hit',tabindex:'0','data-stamp-ms':item.stampMs,
        'data-end-ms':item.endMs,'data-price-close':item.priceClose??''});
      if(item.gap){const show=()=>{hover.textContent=
        `${clockTimeSeconds(item.stampMs)}–${clockTimeSeconds(item.endMs)} CT · candle trade/price sources do not reconcile; B/S, delta and price unavailable`};
        hit.addEventListener('pointerenter',show);hit.addEventListener('focus',show);
        const title=document.createElementNS(svg.namespaceURI,'title');title.textContent=
          `${clockTimeSeconds(item.stampMs)} CT · data gap`;hit.append(title);return}
      const show=()=>{const coverage=item.classifiedPct==null?'no in-zone trades':
        `${item.classifiedPct.toFixed(0)}% classified`;
        hover.textContent=`${clockTimeSeconds(item.stampMs)}–${clockTimeSeconds(item.endMs)} CT · `+
          `B ${number(item.buy)} / S ${number(item.sell)} est. · `+
          `net Δ ${zoneSigned(item.delta)} · full-market close ${money(item.priceClose)} · `+
          `${coverage}; ${item.quoteUsable?'usable quote':'quote context limited'}; completed candle`};
      hit.addEventListener('pointerenter',show);hit.addEventListener('focus',show);
      const title=document.createElementNS(svg.namespaceURI,'title');title.textContent=
        `${clockTimeSeconds(item.stampMs)} CT · Δ ${zoneSigned(item.delta)} · price ${money(item.priceClose)}`;
      hit.append(title);
    });
    wrap.append(svg,hover);return wrap;
  }
  let zoneRenderedResult=null,zoneRenderedIdentity='',zoneLastSelection=null;
  function renderZoneInspector(){
    const panel=$('zone-inspector'),zone=state.zone,result=state.zoneResult;
    panel.hidden=!zone;$('zone-clear').hidden=!zone;$('chart-zone-tab').hidden=!zone;
    if(zone!==zoneLastSelection){
      zoneLastSelection=zone;
      $('chart-right-rail').dataset.view=zone?'zone':'overview';
      $('chart-overview-tab').setAttribute('aria-pressed',String(!zone));
      $('chart-zone-tab').setAttribute('aria-pressed',String(!!zone));
    }
    if(!zone){zoneRenderedResult=null;zoneRenderedIdentity='';return}
    const identity=[state.mode,state.symbol,state.timeframe,state.mode==='replay'?state.demo?.date:state.live?.date,
      zone.startMs,zone.endMs,zone.lowCents,zone.highCents].join(':');
    const quality=()=>{
      const badge=panel.querySelector('.zone-pill');if(!badge)return;
      const liveStale=state.mode==='live'&&(state.live?.status!=='connected'||
        state.live?.receivedAgeSeconds>15||state.live?.eventLagSeconds>15);
      const partial=result?.status==='partial';
      const poor=result?.status==='available'&&(result.coveragePct==null||
        result.quoteContext.warning);
      badge.classList.toggle('caution',!!liveStale||!!poor||partial||result?.status==='insufficient');
      badge.textContent=liveStale?'FEED STALE':!result?'UPDATING':
        partial?`PARTIAL · ${result.observedBucketCount}/${result.bucketCount}`:
        result.status!=='available'?'INSUFFICIENT':poor?'LIMITED DATA':
        `${state.mode==='replay'?'REPLAY':'LIVE'} · ${result.coveragePct.toFixed(0)}% CLASSIFIED`;
      badge.title=(result?.status==='available'||partial?
        `${result.coveragePct==null?'N/A':result.coveragePct.toFixed(1)+'%'} classified · `+
        `${result.quoteContext.usableBuckets}/${result.quoteContext.totalBuckets} quote buckets`+
        (partial?` · ${result.missingBuckets} missing price-level buckets`:''):
        'Awaiting verified completed buckets')+' · '+(state.mode==='replay'?
        'Historical receipt times unrecorded; completed-bar availability is estimated.':
        'Completed local feed buckets; trade side is estimated from quote matching.');
    };
    if(zoneRenderedResult===result&&zoneRenderedIdentity===identity){quality();return}
    zoneRenderedResult=result;zoneRenderedIdentity=identity;panel.replaceChildren();
    const head=zoneNode('div','zone-head');
    const title=zoneNode('div','zone-titlebar');title.append(zoneNode('h2','', 'Zone Tape Inspector'),
      zoneNode('span','zone-pill'));
    const context=zoneNode('div','zone-context');context.append(zoneNode('strong','',state.symbol),
      zoneNode('span','',`${clockTimeSeconds(zone.startMs)}–${clockTimeSeconds(zone.endMs)} CT · ${Math.round((zone.endMs-zone.startMs)/60000*10)/10}m`));
    const earlyPriceOnly=state.mode==='replay'&&state.earlyReplay?.date===state.demo?.date&&
      clockTime(zone.startMs)<'06:00';
    head.append(title,context,zoneNode('div','zone-band',
      `Price band ${money(zone.lowCents/100)}–${money(zone.highCents/100)} · `+
      (earlyPriceOnly?'price-only premarket candles':`completed ${zoneIntervalLabel(state.timeframe*60_000)} candles`)));
    panel.append(head);
    if(!result||!['available','partial'].includes(result.status))panel.append(zoneNode('div','zone-unavailable',
      result?.reason?`Insufficient data · ${result.reason}`:'Updating completed candles…'));
    else{
      const body=zoneNode('div','zone-body');
      const partial=result.status==='partial';
      if(partial)body.append(zoneNode('div','zone-unavailable',
        `Incomplete tape · ${result.observedBucketCount}/${result.bucketCount} selected-timeframe candles reconciled. `+
        'Trade totals, imbalance, and price rankings cover recorded buckets only; gaps have no invented zeros. Full-window price response is unavailable.'));
      const primary=zoneNode('section','zone-primary');
      const sufficient=!partial&&result.lit>=1000&&result.coveragePct>=70&&
        result.quoteContext.usableBuckets*2>result.quoteContext.totalBuckets;
      const imbalance=result.imbalancePct;
      const tone=partial?'Incomplete tape':!sufficient||imbalance==null?'Side estimate limited':
        imbalance<=-20?'Selling pressure elevated':imbalance<=-5?'Seller-leaning flow':
        imbalance>=20?'Buying pressure elevated':imbalance>=5?'Buyer-leaning flow':'Balanced flow';
      const main=zoneNode('div','zone-main');main.append(zoneNode('strong','',tone),
        zoneNode('span','',imbalance==null?'N/A imbalance':`${imbalance>0?'+':imbalance<0?'−':''}${Math.abs(imbalance).toFixed(1)}% imbalance`));
      const response=zoneNode('div','zone-response');
      const priceResponse=zoneNode('div','zone-price-response');
      priceResponse.append(zoneNode('span','','Full-window price Δ'),
        zoneNode('strong',partial?'':result.fullWindowPriceMove<0?'negative':'positive',
          partial?'N/A':zonePriceMove(result.fullWindowPriceMove)));
      response.append(zoneNode('strong',result.delta<0?'negative':'positive',zoneSigned(result.delta)),priceResponse);
      const recentLabel=result.intervalMs<=60_000?'Last 60s':`Latest ${zoneIntervalLabel(result.intervalMs)}`;
      const recent=zoneNode('div','zone-recent');recent.append(zoneNode('span','',
        `${recentLabel} flow ${result.last60?zoneSigned(result.last60.delta):'N/A'}`),
        zoneNode('span','',`${recentLabel} price ${result.last60?zonePriceMove(result.last60.priceMove):'N/A'}`));
      const stack=zoneNode('div','zone-stack');stack.title='Estimated buy, sell, and unknown shares within the selected time and price band';
      for(const [kind,value] of [['buy',result.buy],['sell',result.sell],['unknown',result.unknown]]){
        const segment=zoneNode('span',kind);segment.style.width=`${result.lit?100*value/result.lit:0}%`;stack.append(segment)}
      const totals=zoneNode('div','zone-totals');
      for(const [name,value] of [['Buy',result.buy],['Sell',result.sell],['Unknown',result.unknown]])
        totals.append(zoneNode('span',name.toLowerCase(),`${name} ${zoneCompact(value)}`));
      primary.append(main,response,recent,stack,totals);body.append(primary);
      const graphs=zoneNode('section','zone-section');
      graphs.append(zoneNode('div','zone-section-head',`${zoneIntervalLabel(result.intervalMs)} Net Delta + Price Response`),
        zoneCombinedChart(result));body.append(graphs);
      const prices=zoneNode('section','zone-section zone-prices');
      prices.append(zoneNode('div','zone-section-head','Most active prices · ranked by B + S ↓'),
        zoneNode('div','zone-price-head','Price                  Classified Buy / Sell          Total'));
      const max=Math.max(1,...result.topPrices.map(item=>item.classified));
      if(!result.topPrices.length)prices.append(zoneNode('p','zone-empty','No classified executions at selected prices.'));
      for(const level of result.topPrices){
        const row=zoneNode('div','zone-price-row');
        const bar=zoneNode('div','zone-price-bar');
        for(const [side,shares] of [['buy',level.buy],['sell',level.sell]]){
          const segment=zoneNode('i',side);segment.style.width=`${100*shares/max}%`;bar.append(segment)}
        row.append(zoneNode('span','',money(level.cents/100)),bar,
          zoneNode('b','',zoneCompact(level.classified)));
        row.title=`${money(level.cents/100)} · classified buy ${number(level.buy)}, sell ${number(level.sell)}`;
        prices.append(row)}
      prices.append(zoneNode('div','zone-price-key','● Classified buy   ● Classified sell   · No unknown in rankings'));
      body.append(prices);
      panel.append(body);
    }
    quality();
  }
  async function inspectZone(zone,day,cutoff,retry=0){
    cancelZoneRequest();
    const generation=zoneRequestGeneration,mode=state.mode,symbol=state.symbol,
      timeframe=state.timeframe;
    const selectionKey=`${mode}:${symbol}:${day}`;
    const liveRun=state.live?.runId,liveVersion=state.live?.version;
    const replaySource=JSON.stringify(state.symbolReplayPayload?.sourceSha256||
      state.half?.sourceSha256||state.half?.source||'legacy verified replay');
    state.zone=zone;state.zoneResult=null;renderZoneInspector();
    const active=()=>generation===zoneRequestGeneration&&state.zone===zone&&
      state.zoneKey===selectionKey&&state.mode===mode&&state.symbol===symbol&&
      state.timeframe===timeframe&&
      (mode==='replay'?state.zoneCutoffMs===cutoff:state.zoneCutoffMs>=cutoff)&&
      (mode==='replay'?state.demo?.date:state.live?.date)===day&&
      cutoff>=zone.endMs&&
      (mode==='replay'?JSON.stringify(state.symbolReplayPayload?.sourceSha256||
        state.half?.sourceSha256||state.half?.source||'legacy verified replay')===replaySource:
        state.live?.runId===liveRun);
    let rows=mode==='replay'?state.half?.bars?.[symbol]:null;
    try{
      if(mode==='live'){
        const params=new URLSearchParams({symbol,date:day,
          startMs:String(zone.startMs),endMs:String(zone.endMs)});
        zoneAbort=new AbortController();
        const response=await fetch(`${apiBase()}/api/zone-buckets?${params}`,
          {cache:'no-store',signal:AbortSignal.any([zoneAbort.signal,AbortSignal.timeout(8000)])});
        if(!response.ok)throw new Error('Completed live price-level buckets unavailable');
        const payload=await response.json();
        if(!active())return;
        if(payload.symbol!==symbol||payload.date!==day||payload.startMs!==zone.startMs||
           payload.endMs!==zone.endMs||payload.runId!==liveRun||
           !Number.isInteger(payload.sourceVersion)||!Array.isArray(payload.bars))
          throw new Error('Live zone source mismatch');
        if(payload.sourceVersion!==liveVersion||state.live?.version!==liveVersion){
          if(retry<1){void inspectZone(zone,day,cutoff,retry+1);return}
          throw new Error('Live source changed during inspection; redraw to refresh');
        }
        rows=payload.bars;
      }
      const result=mode==='replay'&&state.earlyReplay?.date===day&&
        clockTime(zone.startMs)<'06:00'?
        {status:'insufficient',reason:'03:00–05:59 CT price-only premarket: classified trades and signed delta are unavailable for this selection'}:
        window.TRADEYODHA_ZONE_TAPE.inspect(rows,zone,zone.endMs,
          {intervalMs:timeframe*60_000,referenceBars:timeframe===.5?null:
            window.TRADEYODHA_REPLAY_CHART.candles(
              (mode==='replay'?state.demo:state.live)?.bars?.[symbol],
              timeframe,zone.endMs,60_000)});
      if(active()){result.sourceVersion=mode==='live'?liveVersion:replaySource;
        state.zoneResult=result;renderZoneInspector()}
    }catch(error){if(active()&&error.name!=='AbortError'){
      state.zoneResult={status:'insufficient',reason:error.message};renderZoneInspector()}}
    finally{if(generation===zoneRequestGeneration)zoneAbort=null}
  }
  function renderReplayChart(){
    const renderStarted=performance.now();
    const clearProfessional=()=>{
      if(!window.TRADER_UI_V2)return;
      window.TY_PRO_CHART?.dispose();
      const nav=$('chart-time-jumps');
      if(nav){nav.replaceChildren();nav.dataset.slots='';nav.hidden=true}
    };
    const empty=$('professional-chart-empty');
    if(empty)empty.hidden=true;
    chartLiveGeometry=null;
    const panel=$('replay-chart');
    $('chart-candle-readout').hidden=true;
    $('replay-chart-gap').hidden=true;
    $('replay-chart-oi-status').hidden=true;
    panel.hidden=state.boardMode;
    if(panel.hidden){clearProfessional();return}
    renderChartReadout(null);
    const svg=$('replay-chart-svg');svg.replaceChildren();
    const replay=state.mode==='replay',cursor=replay?replayCursor():null;
    $('replay-evidence-legend').hidden=!(replay&&REPLAY_EVIDENCE_V1);
    const day=replay?state.demo?.date:state.live?.date;
    const zoneKey=`${state.mode}:${state.symbol}:${day}`;
    if(state.zoneKey!==zoneKey){cancelZoneRequest();state.zone=null;state.zoneResult=null;state.zoneKey=zoneKey}
    renderZoneInspector();
    const today=chicagoDate(Date.now());
    if((replay&&!cursor)||(!replay&&day!==today)){
      clearProfessional();
      if(empty){empty.textContent=replay&&!state.demo?
        (state.replayLoadError?`Replay unavailable: ${state.replayLoadError}`:'Loading verified replay candles…'):
        replay?'No recorded candle at this replay time':
        'Live chart waiting for today’s collector session';empty.hidden=false}
      $('replay-chart-title').textContent=`${state.symbol} · ${intervalLabel()} candles`;
      $('replay-chart-asof').textContent=replay?'No recorded candle':'No current session';
      return;
    }
    const half=state.half?.date===day?state.half?.bars?.[state.symbol]:null;
    const minute=(replay?state.demo:state.live)?.bars?.[state.symbol];
    const candidateTick=chartTick();
    const tick=window.TRADER_UI_V2&&
      (state.live?.status!=='connected'||Date.now()-(candidateTick?.eventMs||0)>5_000)?null:candidateTick;
    const cutoff=replay?cursor.stampMs+(state.timeframe===.5?30_000:60_000):
      state.timeframe===.5?half?.at(-1)?.stampMs+30_000:
      Math.max(half?.at(-1)?.stampMs+30_000||0,minute?.at(-1)?.stampMs+60_000||0,
        tick?.eventMs||0);
    const tapeCutoff=half?.filter(row=>row.stampMs+30_000<=cutoff).at(-1)?.stampMs+30_000||0;
    if(!Number.isFinite(cutoff)||cutoff<=0){
      clearProfessional();
      if(empty){empty.textContent='Waiting for the first current-session candle';empty.hidden=false}
      $('replay-chart-title').textContent=`${state.symbol} · ${intervalLabel()} candles`;
      $('replay-chart-asof').textContent='Awaiting first recorded candle';
      return;
    }
    const all=window.TRADEYODHA_REPLAY_CHART?.candlesWithFallback(half,minute,state.timeframe,cutoff)||[];
    if(replay&&state.earlyReplay?.date===day&&state.timeframe>=1){
      const early=window.TRADEYODHA_REPLAY_CHART?.candlesWithFallback(
        null,state.earlyReplay.bars,state.timeframe,cutoff)||[];
      all.unshift(...early.map(row=>({...row,priceOnly:true,source:'Massive historical minute aggregate · price only'})));
    }
    if(tick){
      const duration=state.timeframe*60_000,start=Math.floor(tick.stampMs/duration)*duration;
      const last=all.at(-1);
      if(last?.stampMs===start){
        all[all.length-1]={...last,h:Math.max(last.h??tick.h,tick.h),
          l:Math.min(last.l??tick.l,tick.l),c:tick.c,
          forming:true,complete:false,liveTick:true};
      }else if(!last||start>last.stampMs){
        all.push({stampMs:start,t:clockTime(start),o:tick.o,h:tick.h,l:tick.l,c:tick.c,
          forming:true,complete:false,liveTick:true,sourceMs:30_000,
          observed:0,expected:duration/30_000,litShares:null,buy:null,sell:null,
          unclassified:null});
      }
    }
    const chartCutoff=all.filter(row=>row.complete).at(-1)?.stampMs+
      state.timeframe*60_000||0;
    // Historical 03:00–05:59 candles are price-only. They are still valid,
    // completed candles for drawing; the inspector separately gates tape metrics.
    const zoneCutoff=replay?chartCutoff:Math.min(tapeCutoff,chartCutoff);
    state.zoneCutoffMs=zoneCutoff;
    if(state.zone&&state.zone.endMs>zoneCutoff){
      cancelZoneRequest();state.zone=null;state.zoneResult=null;renderZoneInspector();
    }
    const shown=all.slice(-(REPLAY_TRADER_V1&&replay&&state.replayView==='trader'?24:
      Math.max(20,Math.min(75,Math.floor((svg.clientWidth||900)/12)))));
    $('replay-chart-title').textContent=`${state.symbol} · ${intervalLabel()} ${replay?'replay':'session'} candles`;
    $('replay-chart-asof').textContent=tick?
      `Last eligible trade ${clockTimeSeconds(tick.eventMs)} CT · ${day}`:
      replay?`Event data through ${clockTimeSeconds(cutoff)} CT · arrival time unknown · ${day}`:
        `Recorded through ${clockTimeSeconds(cutoff)} CT · ${day}`;
    const gap=state.premarketGap;
    if(gap?.available&&gap.date===day&&gap.priceStampMs<=cutoff){
      const badge=$('replay-chart-gap');
      const openingSign=gap.openingChange>0?'+':gap.openingChange<0?'−':'';
      badge.textContent=`PM gap ${gap.openingDirection} · ${openingSign}$${Math.abs(gap.openingChange).toFixed(2)} (${openingSign}${Math.abs(gap.openingChangePct).toFixed(2)}%)`;
      badge.className=`chart-gap ${gap.openingDirection}`;
      badge.title=`${state.symbol} first premarket open ${money(gap.premarketOpen)} at ${gap.premarketOpenCt} CT vs ${gap.priorCloseDate} regular close ${money(gap.priorClose)} · ${gap.source}`;
      badge.hidden=false;
    }
    if(!shown.length){clearProfessional();
      if(empty){empty.textContent='No completed or forming candle is available yet';empty.hidden=false}
      return}
    const selectedRow=shown.find(row=>row.stampMs===state.selectedStamp);
    const defaultHover=selectedRow?
      `Selected ${clockTime(selectedRow.stampMs)} CT`:
      window.TRADER_UI_V2?'Histogram: eligible lit shares · hover a candle':'Hover a candle for details';
    $('replay-chart-hover').textContent=defaultHover;
    const compactChart=(svg.clientWidth||900)<700;
    const traderCompact=REPLAY_TRADER_V1&&replay&&state.replayView==='trader';
    const W=compactChart?760:1100,H=490,left=compactChart?142:136,
      right=traderCompact?105:compactChart?206:218,top=18,bottom=32,plotRight=W-right;
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const scaleKey=`${state.mode}:${state.symbol}:${day}:${state.timeframe}`;
    if(chartPriceScale.key!==scaleKey){chartPriceScale.key=scaleKey;chartPriceScale.zoom=1}
    const labelFont=Math.round(12*H/(svg.clientHeight||300));
    const badgeHeight=Math.max(25,Math.round(labelFont*1.7));
    const pre=visiblePremarketLevels();
    const archived=state.chartOptions;
    const optionReport=archived?.symbol===state.symbol&&archived.date===day?
      archived.report:null;
    const snapshotValid=optionReport?.available&&optionReport.sessionDate===day&&
      Number.isFinite(optionReport.capturedStampMs)&&optionReport.capturedStampMs<=cutoff;
    const lastPrice=shown.at(-1).c;
    const visibleLow=Math.min(...shown.map(row=>row.l));
    const oiItems=snapshotValid&&(!traderCompact||window.TRADER_UI_V2)?[...new Map([
      ...(window.TRADEYODHA_REPLAY_CHART?.notableOiStrikes(optionReport,3)||[]),
      ...(window.TRADEYODHA_REPLAY_CHART?.nearbyOiStrikes(optionReport,lastPrice,2)||[]),
      ...(window.TRADEYODHA_REPLAY_CHART?.nearbyOiStrikes(optionReport,visibleLow,2)||[])
    ].map(item=>[item.strike,item])).values()]:[];
    if(window.TRADER_UI_V2&&window.TY_PRO_CHART){
      const levels=[];
      if(pre)for(const [name,value] of [['PM high',pre.high],['PM .50',pre.midpoint],['PM low',pre.low]])
        if(Number.isFinite(value))levels.push({name,value,kind:'pm',source:'03:00–08:25 CT completed minute aggregates; reconstructed availability, original local receipt unrecorded',asOfStampMs:pre.knownStampMs});
      const opening=(minuteTape()||[]).filter(row=>row.t>='08:30'&&row.t<='08:34'&&row.stampMs+60_000<=cutoff)
        .sort((a,b)=>a.stampMs-b.stampMs);
      if(opening.length===5&&opening.every((row,index)=>Number.isFinite(row.h)&&Number.isFinite(row.l)&&
        (!index||row.stampMs===opening[0].stampMs+index*60_000))){
        const high=Math.max(...opening.map(row=>row.h)),low=Math.min(...opening.map(row=>row.l));
        levels.push({name:'ORB high',value:high,kind:'orb',source:'completed 08:30–08:34 CT replay minute bars',asOfStampMs:opening.at(-1).stampMs+60_000},
          {name:'ORB low',value:low,kind:'orb',source:'completed 08:30–08:34 CT replay minute bars',asOfStampMs:opening.at(-1).stampMs+60_000});
      }
      if(snapshotValid)for(const item of oiItems.slice(0,3))levels.push({name:`OI ${money(item.strike)}`,
        value:item.strike,kind:'oi',source:`${optionReport.sourceProvider||'archived daily reference'} · calls ${number(item.callOi)} / puts ${number(item.putOi)}`,
        asOfStampMs:optionReport.capturedStampMs});
      const box=$('professional-level-list');box.replaceChildren();
      for(const item of levels){const row=document.createElement('p');
        const timing=item.kind==='pm'?'as-of API retrieval':item.kind==='oi'?'recorded snapshot':'causally complete';
        row.textContent=`${item.name} ${money(item.value)} · ${item.source} · ${timing} ${clockTimeSeconds(item.asOfStampMs)} CT`;box.append(row)}
      for(const name of ['Fibonacci','Previous-day reference','Camarilla']){
        const row=document.createElement('p');row.textContent=`${name}: N/A · no versioned as-of measurement in the current chart API`;box.append(row)}
      if(replay&&(!Number.isFinite(state.chartFocusMs)||cutoff>state.chartFocusMs+29*60_000))
        state.chartFocusMs=cutoff;
      const ct=clockTime(cutoff).slice(0,5),minutes=Number(ct.slice(0,2))*60+Number(ct.slice(3,5));
      const openStampMs=Math.floor(cutoff/60_000)*60_000+(8*60+30-minutes)*60_000;
      const liveMinute=Math.floor(cutoff/60_000)*60_000;
      const liveFocusMs=liveMinute<openStampMs?liveMinute:
        liveMinute<openStampMs+29*60_000?openStampMs:liveMinute;
      const chartRows=all.slice(-1600).map(row=>{
        if(!replay||!REPLAY_EVIDENCE_V1||state.replayQualityStatus!=='ready')return row;
        const quality=replayQualityItem(row.stampMs);
        const badQuote=quality&&(Number.isFinite(quality.quoteAgeMs)&&quality.quoteAgeMs>2000||
          Number.isFinite(quality.validQuotePairs)&&quality.validQuotePairs<3||
          /quote too old|insufficient valid quote events|incomplete constituent data/i.test(quality.reason||''));
        return {...row,deltaEvidence:window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence(
          row,quality,state.timeframe),ofiEvidence:quality?{valid:!badQuote}:null};
      });
      const decisionAsOf=replay?cutoff+2000:cutoff;
      window.TY_PRO_CHART.render({container:$('professional-chart'),
        key:`${state.mode}:${state.symbol}:${day}:${state.timeframe}`,rows:chartRows,levels,replay,
        windowed:!replay,intervalMinutes:state.timeframe,
        zone:state.zone,zoneEnabled:state.zoneInspectEnabled,zoneCutoffMs:zoneCutoff,
        onZone:zone=>{if(zone.endMs>zoneCutoff)return;void inspectZone(zone,day,zoneCutoff)},
        onZoneDelete:()=>$('zone-clear').click(),
        onZoneFeedback:type=>{
          const feedback=$('zone-feedback');feedback.hidden=!type;
          if(type)feedback.textContent=type==='future'?`Start on a completed candle (through ${clockTime(zoneCutoff).slice(0,5)} CT).`:
            type==='inside'?'Drag a side handle to resize, or drag outside the box to draw a new one.':
            type==='fullCandle'?'Price edge stops at the selected candles’ full high–low.':
            type==='noCandles'?'No complete candles in that selection.':
            `Selection ended at ${clockTime(zoneCutoff).slice(0,5)} CT, the last completed tape.`;
        },
        focusMs:replay?state.chartFocusMs:liveFocusMs,openStampMs,
        onSelect:row=>{if(row.priceOnly)return;state.selectedStamp=row.stampMs;render();
          if(!window.TRADER_UI_V2)document.querySelector('.pressure-title')?.scrollIntoView({block:'center'})},
        onHover:(row,point)=>{
          const card=$('chart-candle-readout');
          if(!row||!point){
            card.hidden=true;$('replay-chart-hover').textContent=defaultHover;
            return}
          $('replay-chart-hover').textContent=`${clockTime(row.stampMs)} CT · O ${money(row.o)} H ${money(row.h)} L ${money(row.l)} C ${money(row.c)} · lit ${row.litShares==null?'N/A':number(row.litShares)}${row.complete?'':' · incomplete'}`;
          renderChartReadout(row,row.complete?'Candle':'Forming');
          card.hidden=false;
          const rect=panel.getBoundingClientRect(),surface=$('professional-chart');
          const x=surface.offsetLeft+point.x,y=surface.offsetTop+point.y;
          card.style.left=`${Math.max(8,Math.min(rect.width-card.offsetWidth-8,x+12))}px`;
          const top=window.TRADER_UI_V2?Math.max(surface.offsetTop+8,
            Math.min(surface.offsetTop+surface.clientHeight-card.offsetHeight-8,
              y-card.offsetHeight-12)):Math.max(8,Math.min(rect.height-card.offsetHeight-8,y+60));
          card.style.top=`${top}px`}});
      renderTimeJumps(chartRows,decisionAsOf);
      $('professional-chart').dataset.cutoffMs=String(cutoff);
      panel.dataset.lastRenderMs=(performance.now()-renderStarted).toFixed(1);
      return;
    }
    const baseDomain=window.TRADEYODHA_REPLAY_CHART.chartPriceDomain(shown,!!tick);
    const floor=lastPrice+(baseDomain.floor-lastPrice)/chartPriceScale.zoom;
    const ceiling=lastPrice+(baseDomain.ceiling-lastPrice)/chartPriceScale.zoom;
    const y=value=>top+(ceiling-value)/(ceiling-floor)*(H-top-bottom);
    const width=(plotRight-left)/shown.length;
    const oiStatus=$('replay-chart-oi-status');
    oiStatus.hidden=!optionReport||snapshotValid&&oiItems.length>0;
    if(!oiStatus.hidden)oiStatus.textContent=!optionReport.available?
      'OI unavailable · no snapshot by this candle':
      snapshotValid?'No nearby OI in archived snapshot':
      'OI not yet available at this replay time';
    const liveRow=tick&&shown.at(-1)?.liveTick?shown.at(-1):null;
    if(liveRow)chartLiveGeometry={stampMs:liveRow.stampMs,
      o:liveRow.o,h:liveRow.h,l:liveRow.l,floor,ceiling,
      x:left+(shown.length-.5)*width,width,top,bottom,H,plotRight,right,
      labelFont,badgeHeight};
    const ns='http://www.w3.org/2000/svg';
    const shape=(tag,attributes={},label)=>{
      const el=document.createElementNS(ns,tag);
      for(const [key,value] of Object.entries(attributes))if(value!==undefined)el.setAttribute(key,String(value));
      if(label){const title=document.createElementNS(ns,'title');title.textContent=label;el.append(title)}
      svg.append(el);return el;
    };
    const fitBadgeLabel=(element,maxWidth)=>{
      const measured=element.getComputedTextLength?.();
      if(Number.isFinite(measured)&&measured>maxWidth)
        element.style.fontSize=`${Math.max(8,Math.floor(labelFont*maxWidth/measured))}px`;
    };
    shape('rect',{x:0,y:top,width:left,height:H-top-bottom,class:'premarket-rail'});
    shape('line',{x1:left,y1:top,x2:left,y2:H-bottom,class:'premarket-rail-edge'});
    const priceRail=shape('rect',{x:plotRight,y:top,width:right,height:H-top-bottom,
      class:'price-rail'},'Drag up to zoom in; drag down to zoom out; double-click to reset the price scale');
    const adjustPriceZoom=zoom=>{
      const next=Math.max(.35,Math.min(8,zoom));
      if(Math.abs(next-chartPriceScale.zoom)<.005)return;
      chartPriceScale.zoom=next;
      renderReplayChart();
    };
    priceRail.addEventListener('wheel',event=>{
      event.preventDefault();
      adjustPriceZoom(chartPriceScale.zoom*Math.exp(-event.deltaY/500));
    },{passive:false});
    priceRail.addEventListener('dblclick',()=>adjustPriceZoom(1));
    priceRail.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      chartPriceDrag={pointerId:event.pointerId,startY:event.clientY,
        startZoom:chartPriceScale.zoom};
      svg.setPointerCapture(event.pointerId);
    });
    svg.onpointermove=event=>{
      if(chartPriceDrag?.pointerId!==event.pointerId)return;
      adjustPriceZoom(chartPriceDrag.startZoom*
        Math.exp((chartPriceDrag.startY-event.clientY)/180));
    };
    svg.onpointerup=svg.onpointercancel=event=>{
      if(chartPriceDrag?.pointerId===event.pointerId)chartPriceDrag=null;
    };
    shape('line',{x1:plotRight,y1:top,x2:plotRight,y2:H-bottom,class:'price-rail-edge'});
    const taggedPrices=[lastPrice,...oiItems.map(item=>item.strike)];
    for(const price of window.TRADEYODHA_REPLAY_CHART?.nicePriceTicks(floor,ceiling,8)||[]){
      const yp=y(price);
      shape('line',{x1:left,y1:yp,x2:plotRight,y2:yp,class:'gridline'});
      if(taggedPrices.some(value=>Math.abs(y(value)-yp)<badgeHeight*1.25))continue;
      const label=shape('text',{x:W-9,y:yp+labelFont*.35,'text-anchor':'end',
        class:'axis-label price-tick',style:`font-size:${labelFont}px`});
      label.textContent=money(price);
    }
    const openingIndex=window.TRADEYODHA_REPLAY_CHART?.marketOpenBoundaryIndex(shown,clockTime);
    if(openingIndex!=null){
      const openX=left+openingIndex*width;
      if(openX>left)shape('rect',{x:left,y:top,width:openX-left,height:H-top-bottom,class:'premarket-region'});
      shape('line',{x1:openX,y1:top,x2:openX,y2:H-bottom,class:'market-open-line'},
        '08:30 CT · regular-session open, at the left edge of the 08:30 candle');
      const openLabel=shape('text',{x:openingIndex===0?openX+6:openX-6,
        y:H-bottom-labelFont-12,'text-anchor':openingIndex===0?'start':'end',
        class:'market-open-label',style:`font-size:${labelFont}px`});
      openLabel.textContent='08:30 OPEN';
    }
    const pmLabels=[];
    if(pre){
      for(const [kind,caption,value] of [
        ['high','PM HIGH',pre.high],['midpoint','PM .50',pre.midpoint],['low','PM LOW',pre.low]]){
        if(!Number.isFinite(value))continue;
        const inRange=value>=floor&&value<=ceiling;
        const trueY=y(value);
        const detail=`${caption} ${money(value)} · ${pre.complete?'fixed':'developing'} 03:00–08:25 CT premarket range · ${pre.barCount??'—'} observed bars`;
        if(inRange)shape('line',{x1:left,y1:trueY,x2:plotRight,y2:trueY,
          class:`premarket-line ${kind}`},detail);
        pmLabels.push({kind,caption,value,trueY,inRange,detail});
      }
    }
    const rightLabels=[];
    if(snapshotValid){
      const oiTiming=optionReport.sourceProvider==='Databento OPRA.PILLAR'?
        `OPRA start-of-day OI received ${clockTime(optionReport.capturedStampMs)} CT`:
        `delayed snapshot ${clockTime(optionReport.capturedStampMs)} CT`;
      const compactOi=value=>value>=1000?`${(value/1000).toFixed(1)}K`:number(value);
      for(const item of oiItems){
        const inRange=item.strike>=floor&&item.strike<=ceiling;
        const callText=`C ${compactOi(item.callOi)}`,putText=`P ${compactOi(item.putOi)}`;
        const dominant=item.callOi>=item.putOi*1.25?'call':
          item.putOi>=item.callOi*1.25?'put':'balanced';
        const detail=`${money(item.strike)} · calls ${number(item.callOi)} / puts ${number(item.putOi)} contracts · summed across ${optionReport.scope?.firstExpiration}–${optionReport.scope?.lastExpiration} expirations · ${oiTiming} · daily OI reference, not confirmed support or resistance`;
        if(inRange)shape('line',{x1:left,y1:y(item.strike),x2:plotRight,y2:y(item.strike),
          class:`wall-line oi ${dominant}`},detail);
        rightLabels.push({kind:'oi',value:item.strike,inRange,detail,dominant,
          strikeText:money(item.strike)+(inRange?'':item.strike>ceiling?' ↑':' ↓'),
          callText,putText});
      }
    }
    const lastInRange=lastPrice>=floor&&lastPrice<=ceiling;
    if(lastInRange)shape('line',{id:liveRow?'live-tick-price-line':undefined,
      x1:left,y1:y(lastPrice),x2:plotRight,y2:y(lastPrice),
      class:'last-price-line'},`Latest recorded price ${money(lastPrice)} through ${clockTimeSeconds(cutoff)} CT`);
    rightLabels.push({kind:'last',value:lastPrice,inRange:lastInRange,
      detail:`Latest recorded price ${money(lastPrice)} through ${clockTimeSeconds(cutoff)} CT`,
      caption:`LAST ${money(lastPrice)}`});
    const step=Math.max(1,Math.ceil(shown.length/
      (replay&&REPLAY_EVIDENCE_V1?Math.max(2,Math.floor((plotRight-left)/110)):6)));
    let previousTickX=-1000;
    const inspectableStamps=new Set(current().map(item=>item.stampMs));
    shown.forEach((row,index)=>{
      const x=left+(index+.5)*width;
      const bias=row.c>row.o?'bull':row.c<row.o?'bear':'flat';
      const phase=row.forming?'forming':row.complete?'':'missing';
      const evidence=replay&&REPLAY_EVIDENCE_V1?
        window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence(row,
          replayQualityItem(row.stampMs),state.timeframe):null;
      const deltaClass=evidence?.css||window.TRADEYODHA_REPLAY_CHART.candleDeltaClass(row);
      const volumeText=row.litShares==null?'buyer/seller volume unavailable':
        `estimated buyer ${number(row.buy)} / seller ${number(row.sell)} / unclassified ${number(row.unclassified)} lit shares`;
      const interval=`${clockTimeSeconds(row.stampMs)}–${clockTimeSeconds(row.stampMs+state.timeframe*60_000)} CT`;
      const label=`${interval} (candle start–end) · O ${money(row.o)} H ${money(row.h)} L ${money(row.l)} C ${money(row.c)} · ${volumeText} · ${row.observed}/${row.expected} recorded ${row.sourceMs===30_000?'30-second':'1-minute'} bars${row.forming?' · forming':row.complete?'':' · incomplete source'}${evidence?' · Delta border: '+evidence.label:''}`;
      if(row.stampMs===state.selectedStamp)shape('rect',{x:x-width*.5,y:top,width,height:H-top-bottom,
        class:'selected-candle-band'},`Selected candle ${clockTime(row.stampMs)} CT`);
      shape('line',{id:row.liveTick?'live-tick-wick':undefined,
        x1:x,y1:y(row.h),x2:x,y2:y(row.l),class:`wick ${bias} ${phase}`},label);
      shape('rect',{id:row.liveTick?'live-tick-body':undefined,
        x:x-Math.max(2,width*.27),y:Math.min(y(row.o),y(row.c)),
        width:Math.max(4,width*.54),height:Math.max(2,Math.abs(y(row.o)-y(row.c))),
        rx:1,class:`candle-body ${bias} ${phase} ${deltaClass}${row.complete?' inspectable':''}`},label);
      const inspectable=row.complete&&inspectableStamps.has(row.stampMs);
      const positionReadout=()=>{
        const card=$('chart-candle-readout');
        const panelRect=panel.getBoundingClientRect(),svgRect=svg.getBoundingClientRect();
        const center=svgRect.left-panelRect.left+x/W*svgRect.width;
        const candleTop=svgRect.top-panelRect.top+y(row.h)/H*svgRect.height;
        const gap=12,pad=8;
        const leftOfCandle=center+gap+card.offsetWidth>panelRect.width-pad;
        card.style.left=`${Math.max(pad,Math.min(panelRect.width-card.offsetWidth-pad,
          leftOfCandle?center-card.offsetWidth-gap:center+gap))}px`;
        card.style.top=`${Math.max(pad,Math.min(panelRect.height-card.offsetHeight-pad,
          candleTop+gap))}px`;
      };
      const showDetails=()=>{
        $('replay-chart-hover').textContent=`${interval}${row.forming?' · forming':''}`;
        renderChartReadout(row,row.forming?'Forming':'Candle');
        $('chart-candle-readout').hidden=false;
        positionReadout();
      };
      const clearDetails=()=>{
        $('replay-chart-hover').textContent=defaultHover;
        $('chart-candle-readout').hidden=true;
      };
      const inspect=()=>{
        state.selectedStamp=row.stampMs;render();
        const grid=$('pressure-grid');
        if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
          grid.animate([{transform:'translateX(14px)',opacity:.65},{transform:'translateX(0)',opacity:1}],
            {duration:160,easing:'ease-out'});
        document.querySelector('.pressure-title').scrollIntoView({block:'center'});
      };
      {
        const attributes={x:x-width*.49,y:top,width:width*.98,height:H-top-bottom,
          class:inspectable?'candle-hit':'candle-hover'};
        if(inspectable)Object.assign(attributes,{tabindex:0,role:'button','aria-label':`Inspect ${label}`,'aria-describedby':'chart-candle-readout'});
        const hit=shape('rect',attributes);
        hit.addEventListener('mouseenter',showDetails);
        hit.addEventListener('mouseleave',clearDetails);
        hit.addEventListener('focus',showDetails);
        hit.addEventListener('blur',clearDetails);
        if(inspectable){
        hit.addEventListener('click',inspect);
        hit.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();inspect()}});
        }
      }
      if((index%step===0||index===shown.length-1)&&x-previousTickX>=55){
        const tick=shape('text',{x:x,y:H-7,'text-anchor':'middle',class:'axis-label',
          style:`font-size:${labelFont}px`});
        tick.textContent=clockTime(row.stampMs);
        previousTickX=x;
      }
    });
    if(pmLabels.length){
      const minY=top+2,maxY=H-bottom-badgeHeight-2;
      const positions=window.TRADEYODHA_REPLAY_CHART.packLevelLabels(
        pmLabels.map(item=>({desired:item.inRange?item.trueY-badgeHeight/2:
          item.value>ceiling?minY:maxY})),minY,maxY,badgeHeight);
      pmLabels.forEach((item,index)=>{
        const badgeY=positions[index];
        if(item.inRange)shape('line',{x1:left-7,y1:badgeY+badgeHeight/2,
          x2:left,y2:item.trueY,class:'premarket-connector'});
        shape('rect',{x:5,y:badgeY,width:left-12,height:badgeHeight,rx:3,
          class:`premarket-badge ${item.kind}`},item.detail);
        const label=shape('text',{x:10,y:badgeY+badgeHeight*.72,
          class:`premarket-label ${item.kind}`,style:`font-size:${labelFont}px`},item.detail);
        label.textContent=`${item.caption} ${money(item.value)}${item.inRange?'':item.value>ceiling?' ↑':' ↓'}`;
        fitBadgeLabel(label,left-22);
      });
    }
    rightLabels.sort((a,b)=>b.value-a.value);
    const minY=top+2,maxY=H-bottom-badgeHeight-2;
    const rightPositions=window.TRADEYODHA_REPLAY_CHART.packLevelLabels(
      rightLabels.map(item=>({desired:item.inRange?y(item.value)-badgeHeight/2:
        item.value>ceiling?minY:maxY})),minY,maxY,badgeHeight);
    rightLabels.forEach((item,index)=>{
      const badgeY=rightPositions[index],centerY=badgeY+badgeHeight/2;
      if(item.inRange)shape('line',{x1:plotRight,y1:y(item.value),x2:plotRight+5,
        y2:centerY,class:`level-connector ${item.kind}`},item.detail);
      if(item.kind==='oi'){
        const badgeX=plotRight+6,badgeW=right-13,strikeW=badgeW*.36,
          sideW=(badgeW-strikeW)/2;
        for(const [part,x,columnWidth] of [
          ['strike',badgeX,strikeW],['call',badgeX+strikeW,sideW],
          ['put',badgeX+strikeW+sideW,sideW]]){
          shape('rect',{x,y:badgeY,width:columnWidth,height:badgeHeight,
            rx:part==='strike'?3:0,
            class:`oi-column ${part}${item.dominant===part?' dominant':''}`},item.detail);
        }
        shape('rect',{x:badgeX,y:badgeY,width:badgeW,height:badgeHeight,rx:3,
          class:`oi-badge-outline ${item.dominant}`},item.detail);
        for(const [value,klass,x,columnWidth] of [
          [item.strikeText,'oi-strike-count',badgeX,strikeW],
          [item.callText,'oi-call-count',badgeX+strikeW,sideW],
          [item.putText,'oi-put-count',badgeX+strikeW+sideW,sideW]]){
          const text=shape('text',{x:x+columnWidth/2,y:badgeY+badgeHeight*.69,
            'text-anchor':'middle',class:`oi-cell-label ${klass}`,
            style:`font-size:${labelFont}px`},item.detail);
          text.textContent=value;
          fitBadgeLabel(text,columnWidth-7);
        }
        return;
      }
      shape('rect',{id:item.kind==='last'&&liveRow?'live-tick-price-badge':undefined,
        x:plotRight+6,y:badgeY,width:right-13,height:badgeHeight,rx:3,
        class:`${item.kind==='last'?'last-price-badge':'wall-badge'} ${item.kind}`},item.detail);
      const label=shape('text',{id:item.kind==='last'&&liveRow?'live-tick-price-label':undefined,
        x:plotRight+12,y:badgeY+badgeHeight*.72,
        class:`${item.kind==='last'?'last-price-label':'wall-label'} ${item.kind}`,
        style:`font-size:${labelFont}px`},item.detail);
      label.textContent=item.caption+(item.inRange?'':item.value>ceiling?' ↑':' ↓');
      fitBadgeLabel(label,right-25);
    });
    panel.dataset.lastRenderMs=(performance.now()-renderStarted).toFixed(1);
    if(liveRow)paintLiveTick(false);
  }
  function paintLiveTick(allowRebuild=true){
    if(state.mode!=='live'||document.hidden)return;
    if(window.TRADER_UI_V2&&window.TY_PRO_CHART){
      if(professionalRenderQueued)return;
      professionalRenderQueued=true;
      requestAnimationFrame(()=>{professionalRenderQueued=false;if(state.mode==='live'){
        if(performance.now()-lastProfessionalLivePaint<250)return;
        lastProfessionalLivePaint=performance.now();
        renderReplayChart();
        if(performance.now()-lastLiveOiPanelPaint>=250){lastLiveOiPanelPaint=performance.now();renderVolumePanel()}
      }});
      return;
    }
    const tick=chartTick();
    if(!tick)return;
    const duration=state.timeframe*60_000,start=Math.floor(tick.stampMs/duration)*duration;
    const geo=chartLiveGeometry;
    const high=Math.max(geo?.h??tick.h,tick.h),low=Math.min(geo?.l??tick.l,tick.l);
    if(!geo||geo.stampMs!==start||high>geo.ceiling||low<geo.floor){
      if(high>geo?.ceiling||low<geo?.floor)chartPriceScale.zoom=1;
      if(allowRebuild&&!$('replay-chart').hidden)renderReplayChart();
      return;
    }
    geo.h=high;geo.l=low;
    const y=value=>geo.top+(geo.ceiling-value)/(geo.ceiling-geo.floor)*
      (geo.H-geo.top-geo.bottom);
    const age=Math.max(0,Math.round((Date.now()-tick.eventMs)/1000));
    const fresh=age<=5&&state.live?.status==='connected';
    const wick=$('live-tick-wick'),body=$('live-tick-body');
    if(wick&&body){
      wick.setAttribute('y1',y(high));wick.setAttribute('y2',y(low));
      body.setAttribute('y',Math.min(y(geo.o),y(tick.c)));
      body.setAttribute('height',Math.max(2,Math.abs(y(geo.o)-y(tick.c))));
      const direction=tick.c>geo.o?'bull':tick.c<geo.o?'bear':'flat';
      wick.setAttribute('class',`wick ${direction} forming`);
      body.setAttribute('class',`candle-body ${direction} forming delta-unavailable`);
    }
    const line=$('live-tick-price-line'),badge=$('live-tick-price-badge'),label=$('live-tick-price-label');
    const priceY=y(tick.c),badgeY=Math.max(geo.top+2,
      Math.min(geo.H-geo.bottom-geo.badgeHeight-2,priceY-geo.badgeHeight/2));
    if(line){line.setAttribute('y1',priceY);line.setAttribute('y2',priceY)}
    if(badge){badge.setAttribute('y',badgeY);badge.classList.toggle('stale',!fresh)}
    if(label){label.setAttribute('y',badgeY+geo.badgeHeight*.72);
      label.textContent=`${fresh?'TRADE':'STALE'} ${money(tick.c)}`}
    $('replay-chart-asof').textContent=
      `${fresh?'Last eligible trade':'STALE last trade'} ${clockTimeSeconds(tick.eventMs)} CT · ${age}s old`;
    if(state.selectedStamp==null){
      $('price-label').textContent=`${state.symbol} ${fresh?'provisional trade':'stale last trade'}`;
      $('price').textContent=money(tick.c);
      $('price-time').textContent=`${clockTimeSeconds(tick.eventMs)} CT · ${age}s old`;
      $('range').textContent=`H ${money(high)} · L ${money(low)}`;
      $('formation-title').textContent=fresh?'Forming candle':'Last trade is stale';
      $('formation-badge').textContent=fresh?'PROVISIONAL':'STALE';
      $('formation-badge').className=fresh?'provisional':'';
      $('formation-interval').textContent=
        `${clockTimeSeconds(start)}–${clockTimeSeconds(start+duration)} CT`;
      $('formation-source').textContent=`Price: last eligible WebSocket trade, ${age}s old. Flow measurements update from completed 30-second buckets.`;
    }
  }
  function livePartial(){
    if(state.mode!=='live'||state.timeframe===.5||state.selectedStamp!=null||
       state.half?.date!==state.live?.date||state.live?.status!=='connected')return null;
    const duration=state.timeframe*60_000,start=Math.floor(Date.now()/duration)*duration;
    const halves=(state.half?.bars?.[state.symbol]||[]).filter(row=>row.stampMs>=start&&row.stampMs<start+duration);
    if(!halves.length)return {t:clockTime(start),stampMs:start,partial:true,awaiting:true,throughMs:start};
    if(halves[0].stampMs!==start||
       halves.some((row,i)=>row.stampMs!==start+i*30_000))return null;
    const latest=halves.at(-1),priced=halves.filter(row=>Number.isFinite(row.c));
    if(!priced.length)return null;
    const sum=key=>halves.every(row=>Number.isFinite(row[key]))?
      halves.reduce((n,row)=>n+row[key],0):null;
    const buy=sum('buy'),sell=sum('sell'),litShares=sum('litShares');
    const quoted=halves.filter(row=>Number.isFinite(row.ofi)&&row.quoteUpdates>0);
    const quoteCount=quoted.reduce((n,row)=>n+row.quoteUpdates,0);
    return {t:clockTime(start),stampMs:start,partial:true,throughMs:latest.stampMs+30_000,
      o:priced[0].o,h:Math.max(...priced.map(row=>row.h)),l:Math.min(...priced.map(row=>row.l)),c:priced.at(-1).c,
      litShares,buy,sell,delta:buy!=null&&sell!=null?buy-sell:null,imbalancePct:buy!=null&&sell!=null&&buy+sell?100*(buy-sell)/(buy+sell):null,
      coveragePct:litShares!=null&&buy!=null&&sell!=null&&litShares?100*(buy+sell)/litShares:null,
      // Half-bucket ratios lack their raw OFI denominators; quote-update weighting is approximate.
      ofi:quoteCount?quoted.reduce((n,row)=>n+row.ofi*row.quoteUpdates,0)/quoteCount:null,
      queue:latest.queue,netOutflowUsd:sum('netOutflowUsd'),quoteUpdates:quoteCount,
      quoteAgeMs:latest.quoteAgeMs,medianSpreadCents:latest.medianSpreadCents};
  }
  function replayPartial(){
    if(state.mode!=='replay'||state.timeframe===.5||state.selectedStamp!=null||
       state.half?.date!==state.demo?.date)return null;
    const cursor=replayCursor();if(!cursor)return null;
    const sourceMs=state.timeframe===.5?30_000:60_000;
    const through=cursor.stampMs+sourceMs,duration=state.timeframe*60_000;
    const start=Math.floor(cursor.stampMs/duration)*duration;
    if(through>=start+duration)return null;
    const halves=(state.half?.bars?.[state.symbol]||[]).filter(row=>row.stampMs>=start&&row.stampMs+30_000<=through);
    if(!halves.length)return {t:clockTime(start),stampMs:start,partial:true,awaiting:true,throughMs:start};
    if(halves[0].stampMs!==start||halves.some((row,i)=>row.stampMs!==start+i*30_000))return null;
    const priced=halves.filter(row=>[row.o,row.h,row.l,row.c].every(Number.isFinite));
    if(!priced.length)return null;
    const latest=halves.at(-1),sum=key=>halves.every(row=>Number.isFinite(row[key]))?
      halves.reduce((n,row)=>n+row[key],0):null;
    const buy=sum('buy'),sell=sum('sell'),litShares=sum('litShares');
    const quoted=halves.filter(row=>Number.isFinite(row.ofi)&&row.quoteUpdates>0);
    const quoteCount=quoted.reduce((n,row)=>n+row.quoteUpdates,0);
    return {t:clockTime(start),stampMs:start,partial:true,throughMs:latest.stampMs+30_000,
      o:priced[0].o,h:Math.max(...priced.map(row=>row.h)),l:Math.min(...priced.map(row=>row.l)),c:priced.at(-1).c,
      litShares,buy,sell,delta:buy!=null&&sell!=null?buy-sell:null,imbalancePct:buy!=null&&sell!=null&&buy+sell?100*(buy-sell)/(buy+sell):null,
      coveragePct:litShares!=null&&buy!=null&&sell!=null&&litShares?100*(buy+sell)/litShares:null,
      ofi:quoteCount?quoted.reduce((n,row)=>n+row.ofi*row.quoteUpdates,0)/quoteCount:null,
      queue:latest.queue,netOutflowUsd:sum('netOutflowUsd'),quoteUpdates:quoteCount,
      quoteAgeMs:latest.quoteAgeMs,medianSpreadCents:latest.medianSpreadCents};
  }
  const candlePartial=()=>state.mode==='replay'?replayPartial():livePartial();
  const status = (value,style,details='') => {const el=$('status');el.textContent=value;
    el.className=`status ${style}`;el.title=details};
  function liveFeedStatus(feed){
    if(isWeekend(chicagoDate(Date.now()))){
      status('LIVE FEED · market closed · no current session','warn');return;
    }
    const age=feed.receivedAgeSeconds,lag=feed.eventLagSeconds;
    const gaps=feed.feedGapsOrOutOfOrderDrops||0;
    const fresh=feed.status==='connected'&&age!=null&&age<=15&&lag!=null&&lag<=15;
    const stale=feed.status==='stale'||feed.status==='connected'&&!fresh;
    const label=stale?'Stale':feed.status==='connected'?'Connected':
      feed.status==='offline'||feed.status==='error'?'Disconnected':'Connecting';
    const delay=stale?` · last event ${lag==null?'unknown':Math.max(0,Math.round(lag))+'s'} ago`:'';
    const gapsText=gaps?` · ${gaps} gap/drop${gaps===1?'':'s'}`:'';
    const refill=feed.refillStatus==='running'?' · REFILLING missed candles':
      feed.refillStatus==='error'?' · REFILL FAILED':
      feed.refillStatus==='complete'&&feed.refillThroughMs?
        ` · REST restored through ${clockTime(feed.refillThroughMs-60_000)} CT`:'';
    status(`Network Status · ● ${label}`,
      label==='Connected'?'good':label==='Disconnected'?'bad':'warn',
      `${feed.message||'Waiting for collector'}${delay}${gapsText}${refill}`);
  }
  function renderAnalytics(){
    if(state.symbol!=='AMD')return;
    const raw=minuteTape();
    const viewEnd=(state.selectedStamp??current().at(-1)?.stampMs??0)+state.timeframe*60000;
    const source=raw?.filter(row=>row.stampMs+60000<=viewEnd);
    const date=state.mode==='replay'?state.demo?.date:state.live?.date;
    const width=state.timeframe===.5?1:state.timeframe;
    $('analytic-asof').textContent=source?.at(-1)?`${source.at(-1).t} CT · ${width}m analyst window${state.timeframe===.5?' (last complete minute)':''}`:'—';
    const signal=$('analytic-signal'),evidence=$('analytic-evidence'),analogs=$('analytic-analogs');
    signal.className='analytics-signal';evidence.textContent='';analogs.textContent='';
    if(state.mode==='live'){
      const feed=state.live||{},age=feed.receivedAgeSeconds,lag=feed.eventLagSeconds;
      if(feed.status!=='connected'||age==null||age>15||lag==null||lag>15){signal.textContent='Live feed is not fresh; analysis paused';return}
      if(!source?.at(-1)||(state.selectedStamp==null&&Date.now()-(source.at(-1).stampMs+60000)>width*60000+90000)){signal.textContent='No recent complete AMD interval; analysis paused';return}
    }
    if(!source?.length||!date||!window.AMD_TAPE_ANALYTICS){signal.textContent='Waiting for completed AMD tape';return}
    const history=width<5?window.AMD_SHORT_ANALYTICS_HISTORY:window.AMD_ANALYTICS_HISTORY;
    const result=window.AMD_TAPE_ANALYTICS.thesis(source,date,width,history);
    if(result.reason){signal.textContent=result.reason;return}
    signal.textContent=result.thesis.headline;signal.classList.add(result.thesis.kind);
    const c=result.current;
    evidence.textContent=`${result.thesis.evidence} · price ${signed(c.priceBps,0)} bp in ${c.width}m`;
    if(!result.closeMatch){analogs.textContent=`${result.mode} (${result.matchDays} prior days) · No close prior pattern; thesis withheld`;return}
    const sample=result.matches||[];
    if(sample.length<3){analogs.textContent='Too few prior matches with a complete next 5 minutes.';return}
    const returns=sample.map(item=>item.next5).sort((a,b)=>a-b);
    const middle=Math.floor(returns.length/2);
    const median=returns.length%2?returns[middle]:(returns[middle-1]+returns[middle])/2;
    const up=returns.filter(value=>value>0).length,down=returns.filter(value=>value<0).length;
    const closest=sample[0];
    analogs.textContent=`${result.mode} (${result.matchDays} prior days) · Next 5m in ${sample.length} nearest: ${up} up / ${down} down · median ${signed(median,0)} bp · Closest ${closest.date} ${closest.time}: ${signed(closest.next5,0)} bp`;
  }
  function replayMode(){
    closeLiveUpdates();
    state.live=null;state.boardLive={};state.boardHalf={};
    levelsRequestId++;levelsLastKey='';levelsPendingKey='';
    $('compact-options-status').textContent='Nearby OI · loading archived reference';
    for(const id of ['compact-call-wall','compact-put-wall']){
      $(id).textContent='—';$(id).parentElement.title='Loading archived options reference';
    }
    state.mode='replay';setModePanels();saveTabValue(MODE_KEY,'replay');
    $('dashboard').classList.toggle('replay-evidence-v1',REPLAY_EVIDENCE_V1);
    applyReplayView();
    if(state.demo?.date)saveTabValue(REPLAY_DATE_KEY,state.demo.date);
    state.selectedStamp=null;
    $('replay-controls').hidden=false;$('mode-note').textContent=state.demo?.todayReplay?
      'Today’s recorded tape so far · frozen at the moment replay opened':
      `Archived ${sessionWindow().startCt}–${archiveEndCt(state.symbol,boardHistory(state.symbol))} CT tape · slider reveals only completed earlier minutes`;
    stop();render();if(state.boardMode)loadBoardReplay(state.demo?.date);
  }
  async function loadReplayDeltaQuality(symbol,date,requestVersion){
    if(!REPLAY_EVIDENCE_V1)return;
    const key=`${symbol}:${date}`;
    const cached=replayQualityCache.get(key);
    if(cached){state.replayQuality=cached;state.replayQualityStatus='ready';render();return}
    try{
      const base=apiBase();
      const response=await fetch(`${base}/api/shadow-cv2?symbol=${encodeURIComponent(symbol)}&date=${encodeURIComponent(date)}`,
        {cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error(response.status===404?'Raw research archive missing':`Raw quality HTTP ${response.status}`);
      const payload=await response.json();
      if(payload.symbol!==symbol||payload.date!==date||payload.source!=='historical_rest_raw'||
         payload.version!=='Shadow C_v2'||!payload.windows)
        throw Error('Raw quality provenance mismatch');
      replayQualityCache.set(key,payload);
      if(requestVersion!==replayLoadVersion||state.mode!=='replay'||state.symbol!==symbol||state.demo?.date!==date)return;
      state.replayQuality=payload;state.replayQualityStatus='ready';render();
    }catch(error){
      if(requestVersion!==replayLoadVersion||state.mode!=='replay'||state.symbol!==symbol||state.demo?.date!==date)return;
      state.replayQuality=null;state.replayQualityStatus=error.message;render();
    }
  }
  function liveMode(){
    replayLoadVersion++;
    cancelZoneRequest();state.zone=null;state.zoneResult=null;renderZoneInspector();
    state.demo=null;state.symbolReplayPayload=null;state.micro=null;state.sweeps=null;
    state.live=null;state.half=null;state.liveTick=null;state.liveTickVersion=null;
    state.liveTickRunId=null;
    state.replayQuality=null;state.replayQualityStatus='unavailable';
    state.boardReplay={};state.boardReplayErrors={};
    state.premarketLevels=null;state.premarketGap=null;
    levelsRequestId++;levelsLastKey='';levelsPendingKey='';
    $('compact-options-status').textContent='Nearby OI · waiting for today’s tape';
    for(const id of ['compact-call-wall','compact-put-wall']){
      $(id).textContent='—';$(id).parentElement.title='Waiting for today’s tape';
    }
    state.mode='live';setModePanels();saveTabValue(MODE_KEY,'live');
    $('dashboard').classList.remove('replay-evidence-v1');
    applyReplayView();
    state.selectedStamp=null;
    selectLiveSession();
    $('replay-controls').hidden=true;$('mode-note').textContent='Local Massive WebSocket collector · last completed minute';
    stop();render();
    if(isWeekend(chicagoDate(Date.now()))){
      status('LIVE FEED · market closed · no current session','warn');
      return;
    }
    refreshLive().finally(connectLiveUpdates);
    if(state.boardMode)refreshBoardLive(true);
  }
  function selectLiveSession(){
    const select=$('replay-date'),date=chicagoDate(Date.now());
    if(!date)return;
    if(isWeekend(date)){select.value=state.replayDates.at(-1)||'';return}
    for(const option of [...select.options])if(option.dataset.liveSession==='true'&&option.value!==date)option.remove();
    let option=[...select.options].find(item=>item.value===date);
    if(!option){option=document.createElement('option');option.value=date;select.prepend(option)}
    option.textContent=`${date} · today`;
    option.dataset.liveSession='true';
    select.value=date;
  }
  function setModePanels(){
    $('mode-switch').textContent=`Mode: ${state.mode==='live'?'Live Feed':'Historical Replay'} ▾`;
    $('mode-switch').title='Choose a different dashboard mode';
    $('mode-live').setAttribute('aria-checked',String(state.mode==='live'));
    $('mode-replay').setAttribute('aria-checked',String(state.mode==='replay'));
    $('candle-toolbar').hidden=false;
    $('replay-controls').hidden=state.mode!=='replay';
    $('session-label').hidden=state.mode!=='replay';
    $('replay-date').hidden=state.mode!=='replay';
  }
  function stop(){if(state.timer){clearInterval(state.timer);state.timer=null}$('play').textContent='▶ Play'}
  async function loadEarlyPrice(symbol,date){
    const response=await fetch(`watchlist-early/${symbol}/${date}.json`,
      {cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(response.status===404)return null; // Older sessions have no early-price layer.
    if(!response.ok)throw new Error(`Early-price HTTP ${response.status}`);
    const payload=await response.json();
    if(payload.schema!=='watchlist-early-price-v1'||payload.symbol!==symbol||
       payload.date!==date||payload.priceOnly!==true||!Array.isArray(payload.bars)||
       payload.bars.some((row,index)=>!Number.isInteger(row.stampMs)||
         row.t<'03:00'||row.t>='06:00'||
         ![row.o,row.h,row.l,row.c,row.v].every(Number.isFinite)||
         row.h<Math.max(row.o,row.c)||row.l>Math.min(row.o,row.c)||
         (index>0&&row.stampMs<=payload.bars[index-1].stampMs)))
      throw new Error(`${symbol} ${date}: early-price provenance or chronology invalid`);
    return {...payload,bars:payload.bars.map(row=>({...row,priceOnly:true,
      litShares:null,buy:null,sell:null,ofi:null,complete:true}))};
  }
  async function loadReplay(date,atEnd=false){
    const requestVersion=++replayLoadVersion;
    const symbol=state.symbol;
    state.replayLoadError=null;
    const today=date===chicagoDate(Date.now());
    const archived=state.replayDates.includes(date);
    const fullArchive=state.symbolHistory[symbol]?.sessions?.some(item=>item.date===date);
    const liveToday=false;
    if(isWeekend(date)||!today&&!archived)throw new Error('Session is not in the verified replay manifest');
    if(today&&!fullArchive)throw new Error('Today is not archived yet; replay is available after verified publication');
    cancelZoneRequest();state.zone=null;state.zoneResult=null;renderZoneInspector();
    stop();status(`Loading ${date} replay…`,'warn');
    levelsRequestId++;levelsLastKey='';levelsPendingKey='';
    $('levels-refresh').disabled=false;
    $('levels-asof').textContent=`Loading ${symbol} ${date} reference levels…`;
    for(const id of ['pm-levels','pin-levels','walls-levels','long-levels'])
      $(id).textContent='Loading verified sources…';
    // Never leave the previous symbol/date visible while a new replay is in flight.
    state.demo=null;state.half=null;state.micro=null;state.sweeps=null;state.earlyReplay=null;
    state.replayTimeline=null;state.symbolReplayPayload=null;state.selectedStamp=null;
    state.premarketLevels=null;state.premarketGap=null;state.chartOptions=null;
    state.replayQuality=null;state.replayQualityStatus='loading';
    render();
    try{
    const base=apiBase();
    const response=await fetch(fullArchive||symbol!=='AMD'?`watchlist-replay/${symbol}/${date}.json`:`replay/${date}.json`,
      {cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Replay HTTP ${response.status}`);
    const payload=await response.json();
    if(requestVersion!==replayLoadVersion||state.symbol!==symbol)return;
    const rows=liveToday?payload.bars?.[symbol]:fullArchive||symbol!=='AMD'?payload.bars?.['1m']:payload.bars?.AMD;
    if(payload.date!==date||!Array.isArray(rows)||!rows.length||(!liveToday&&(fullArchive||symbol!=='AMD')&&payload.symbol!==symbol))
      throw new Error(`Replay session does not match ${symbol} ${date}`);
    if(!liveToday&&(fullArchive||symbol!=='AMD')){
      const entry=state.symbolHistory[symbol]?.sessions?.find(item=>item.date===date);
      if(!entry||payload.sourceSha256?.trades!==entry.sourceSha256?.trades||
         payload.sourceSha256?.quotes!==entry.sourceSha256?.quotes||
         payload.halfMinuteParityChecks!==entry.parityChecks)
        throw new Error(`${symbol} replay provenance mismatch`);
      state.symbolReplayPayload=payload;
    }else state.symbolReplayPayload=null;
    const micro=symbol==='AMD'?await loadReplayMicro(date):null;
    const sweeps=await loadReplaySweeps(symbol,date).catch(()=>null);
    const early=await loadEarlyPrice(symbol,date);
    if(requestVersion!==replayLoadVersion||state.symbol!==symbol)return;
    state.demo=liveToday?{date,mode:'replay',todayReplay:true,bars:{[symbol]:rows},source:payload.source}:
      symbol==='AMD'&&!fullArchive?payload:
      {date,mode:'replay',bars:{[symbol]:rows},source:payload.source};
    state.micro=micro;
    state.sweeps=sweeps;
    state.earlyReplay=early;
    state.replayTimeline=[...(early?.bars||[]),...rows];
    state.half=Array.isArray(state.symbolReplayPayload?.bars?.['30s'])?
      {date,bars:{[symbol]:state.symbolReplayPayload.bars['30s']}}:null;
    const timeline=state.replayTimeline;
    const beforeOpen=timeline.findLastIndex(row=>row.t<'08:30');
    state.index=atEnd?timeline.length-1:window.TRADER_UI_V2&&beforeOpen>=0?beforeOpen:
      Math.max(0,timeline.findIndex(row=>row.t>=(today?'08:35':'08:45')));
    const preOpenClock=timeline[state.index]?.t?.slice(0,5)||'';
    const preOpenMinutes=Number(preOpenClock.slice(0,2))*60+Number(preOpenClock.slice(3,5));
    state.chartFocusMs=window.TRADER_UI_V2&&beforeOpen>=0&&!atEnd?
      timeline[state.index].stampMs+(8*60+30-preOpenMinutes)*60_000:null;
    // UI-3 consumes the existing 30-second replay file even while the global
    // chart remains on 1/2/5/15 minutes. A missing file stays unavailable.
    if(window.TRADER_UI_V2&&!state.half){
      try{await loadHalf(date)}catch(_error){state.half=null}
      if(requestVersion!==replayLoadVersion||state.symbol!==symbol)return;
    }
    if(state.timeframe===.5){
      await loadHalf(date);
      if(requestVersion!==replayLoadVersion||state.symbol!==symbol)return;
      const end=timeline[state.index]?.stampMs+60_000;
      state.halfIndex=Math.max(0,(state.half?.bars?.[symbol]||[]).findLastIndex(row=>row.stampMs+30_000<=end));
    }
    $('replay-date').value=date;
    replayMode();
    await loadReplayDeltaQuality(symbol,date,requestVersion);
    void hydrateReplayBenchmarks(date,symbol,requestVersion);
    }catch(error){
      if(requestVersion===replayLoadVersion&&state.symbol===symbol){
        state.replayLoadError=error.message;
        render();
      }
      throw error;
    }
  }
  async function loadHalf(date){
    const symbol=state.symbol;
    if(state.symbolReplayPayload?.date===date&&state.symbolReplayPayload?.symbol===symbol){
      const payload=state.symbolReplayPayload;
      if(payload?.date!==date||payload.symbol!==symbol||!Array.isArray(payload.bars?.['30s']))
        throw new Error(`${symbol} 30-second replay unavailable`);
      state.half={date,bars:{[symbol]:payload.bars['30s']}};
      return;
    }
    const base=apiBase();
    const liveToday=date===chicagoDate(Date.now())&&
      !state.symbolHistory[symbol]?.sessions?.some(item=>item.date===date);
    const response=await fetch(liveToday?`${base}/api/half?date=${encodeURIComponent(date)}&symbol=${symbol}`:
      `replay30/${date}.json`,
      {cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`30-second tape HTTP ${response.status}`);
    const payload=await response.json();
    if(state.symbol!==symbol)return;
    if(payload.date!==date||!Array.isArray(payload.bars?.[symbol]))throw new Error('30-second tape date or bars invalid');
    state.half=payload;
  }
  async function loadReplayMicro(date){
    const entry=state.microManifest?.sessions?.find(item=>item.date===date);
    if(!entry)return null;
    const response=await fetch(`microstructure/${date}.json`,
      {cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Validated order-flow HTTP ${response.status}`);
    // The same-origin local server verifies the manifest SHA-256 before
    // serving this file. LAN HTTP browsers (including iPad) have no SubtleCrypto.
    const payload=await response.json();
    if(payload.date!==date||!Array.isArray(payload.bars)||payload.bars.length!==entry.buckets||
      payload.sourceTrades!==entry.sourceTrades||payload.sourceQuotes!==entry.sourceQuotes||
      payload.classifiedTrades!==entry.classifiedTrades||entry.minuteParityChecks<200||
      payload.bars.some((row,i)=>row.stampMs%30000||i>0&&row.stampMs<=payload.bars[i-1].stampMs))
      throw new Error(`Order-flow row validation failed for ${date}`);
    return payload;
  }
  async function loadReplaySweeps(symbol,date){
    const entry=state.sweepManifest?.sessions?.find(item=>item.symbol===symbol&&item.date===date);
    if(!entry)return null;
    const response=await fetch(`replay-sweeps/${symbol}/${date}.json`,
      {cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Verified sweep cache HTTP ${response.status}`);
    const payload=await response.json();
    const source=state.symbolHistory[symbol]?.sessions?.find(item=>item.date===date)?.sourceSha256;
    if(payload.symbol!==symbol||payload.date!==date||
      !['trades','quotes'].every(kind=>payload.sourceSha256?.[kind]&&
        payload.sourceSha256[kind]===source?.[kind]&&entry.sourceSha256?.[kind]===source[kind])||
      payload.parityChecks!==entry.parityChecks||payload.bars?.length!==entry.buckets||
      !Array.isArray(payload.bars)||payload.bars.some((bar,index)=>
        !Number.isSafeInteger(bar.stampMs)||bar.stampMs%30_000||
        index>0&&bar.stampMs<=payload.bars[index-1].stampMs||
        !['sellSweepCandidates','buySweepCandidates','sellSweepShares','buySweepShares']
          .every(key=>Number.isSafeInteger(bar[key])&&bar[key]>=0)))
      throw new Error(`Sweep source provenance mismatch for ${symbol} ${date}`);
    return payload;
  }
  async function loadLibrary(){
    try{
      const response=await fetch('replay-manifest.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error(`Replay manifest HTTP ${response.status}`);
      const manifest=await response.json();
      if(!Array.isArray(manifest.dates)||!manifest.dates.length)throw new Error('No replay dates in manifest');
      state.amdReplayDates=manifest.dates;
      try{
        const microResponse=await fetch('microstructure-manifest.json',
          {cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(microResponse.ok)state.microManifest=await microResponse.json();
      }catch(_error){state.microManifest=null}
      try{
        const sweepResponse=await fetch('replay-sweeps-manifest.json',
          {cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(sweepResponse.ok)state.sweepManifest=await sweepResponse.json();
      }catch(_error){state.sweepManifest=null}
      if(state.symbol==='AMD')setReplayDates([...new Set([
        ...manifest.dates,...(state.symbolHistory.AMD?.dates||[])])].sort());
      if(state.mode==='replay'&&!state.demo)await loadReplay(manifest.dates.at(-1));
    }catch(error){status(`Replay library unavailable: ${error.message}`,'bad')}
  }
  let refreshingSymbol=null;
  function mergeLiveSnapshot(previous,fresh,symbol,limit){
    if(!fresh.incremental)return fresh;
    if(!previous||previous.runId!==fresh.runId||previous.date!==fresh.date)
      throw new Error('Incremental tape base changed');
    const bars=[...(previous.bars?.[symbol]||[]),...(fresh.bars?.[symbol]||[])].slice(-limit);
    const merged={...fresh,bars:{[symbol]:bars}};
    if(fresh.offExchange)merged.offExchange={
      [symbol]:[...(previous.offExchange?.[symbol]||[]),...(fresh.offExchange?.[symbol]||[])].slice(-600)};
    return merged;
  }
  async function refreshLive(){
    const symbol=state.symbol;
    if(!state.watchlist.includes(symbol))return;
    if(refreshingSymbol===symbol)return;
    refreshingSymbol=symbol;
    const priorLive=state.live?.bars?.[symbol]?state.live:null;
    const priorHalf=state.half?.bars?.[symbol]?state.half:null;
    const previousLastStamp=(state.timeframe===.5?state.half?.bars?.[symbol]:state.live?.bars?.[symbol])?.at(-1)?.stampMs;
    try{
      const base=apiBase();
      const date=chicagoDate(Date.now());
      const deltaQuery=prior=>{
        const stamp=prior?.bars?.[symbol]?.at(-1)?.stampMs;
        return stamp==null?'':`&afterMs=${stamp}&runId=${encodeURIComponent(prior.runId)}&clientDate=${prior.date}`;
      };
      const requests=[fetch(`${base}/api/state?symbol=${symbol}${deltaQuery(priorLive)}`,
        {cache:'no-store',signal:AbortSignal.timeout(3000)})];
      requests.push(fetch(`${base}/api/half?date=${date}&symbol=${symbol}${deltaQuery(priorHalf)}`,
        {cache:'no-store',signal:AbortSignal.timeout(3000)}));
      const responses=await Promise.all(requests);
      if(responses.some(response=>!response.ok))throw new Error('Tape HTTP '+responses.find(response=>!response.ok).status);
      const live=mergeLiveSnapshot(priorLive,await responses[0].json(),symbol,600);
      const half=mergeLiveSnapshot(priorHalf,await responses[1].json(),symbol,1200);
      if(state.symbol!==symbol)return;
      if(live.date!==date||!Array.isArray(live.bars?.[symbol])||half.date!==live.date||!Array.isArray(half.bars?.[symbol]))
        throw new Error('Selected-symbol feed mismatch');
      state.live=live;state.half=half;
      if(state.mode==='live'&&state.zone&&priorLive?.runId&&priorLive.runId!==live.runId){
        void inspectZone(state.zone,date,state.zoneCutoffMs)}
      if(state.mode==='live')selectLiveSession();
      const latestStamp=(state.timeframe===.5?state.half?.bars?.[symbol]:state.live?.bars?.[symbol])?.at(-1)?.stampMs;
      if(state.mode==='live'&&state.selectedStamp!=null&&latestStamp>previousLastStamp)state.selectedStamp=null;
    }catch(error){if(state.symbol!==symbol)return;
      state.live=state.live?{...state.live,status:'stale',message:`Live update failed: ${error.message}`}:
      {status:'offline',message:`${symbol} collector is not running`,bars:{[symbol]:[]},receivedAgeSeconds:null,eventLagSeconds:null}}
    finally{if(refreshingSymbol===symbol)refreshingSymbol=null}
    if(state.mode==='live'&&!document.hidden){
      render();
      maybeRefreshObservational();
      if(state.boardMode)refreshBoardLive();
    }
  }
  let liveUpdates=null;
  let observationalRequestAt=-Infinity,observationalPending=false;
  async function maybeRefreshObservational(){
    if(!OBSERVATIONAL_PREVIEW||state.mode!=='live'||document.hidden||observationalPending||
       performance.now()-observationalRequestAt<1000)return;
    const symbol=state.symbol;observationalPending=true;observationalRequestAt=performance.now();
    try{
      const base=apiBase();
      const response=await fetch(`${base}/api/observational-research?symbol=${encodeURIComponent(symbol)}`,
        {cache:'no-store',signal:AbortSignal.timeout(2000)});
      const responsePerf=performance.now();
      if(!response.ok)throw new Error(`Research HTTP ${response.status}`);
      const payload=await response.json();
      if(state.mode==='live'&&state.symbol===symbol){
        state.observational=payload;renderObservational();
        // Double rAF observes the first paint opportunity after the DOM update.
        // It cannot prove physical monitor scanout; the server labels that limit.
        if(payload.timing?.sample_id&&!document.hidden&&!$('observational-preview').hidden){
          requestAnimationFrame(()=>requestAnimationFrame(()=>{
            if(document.hidden||state.mode!=='live'||state.symbol!==symbol)return;
            const paintPerf=performance.now();
            const metric={sample_id:payload.timing.sample_id,symbol,
              browser_response_epoch_ms:performance.timeOrigin+responsePerf,
              browser_paint_epoch_ms:performance.timeOrigin+paintPerf,
              response_to_paint_ms:paintPerf-responsePerf};
            fetch(`${base}/api/observational-browser-metric`,{method:'POST',
              headers:{'Content-Type':'application/json'},body:JSON.stringify(metric),
              keepalive:true}).catch(()=>{});
          }));
        }
      }
    }catch(error){
      if(state.mode==='live'&&state.symbol===symbol){state.observational={available:false,reason:error.message};renderObservational()}
    }finally{observationalPending=false}
  }
  function renderObservational(){
    const panel=$('observational-preview');panel.hidden=!OBSERVATIONAL_PREVIEW||state.mode!=='live'||state.boardMode;
    if(panel.hidden)return;
    const data=state.observational;
    const active=data?.available&&data.symbol===state.symbol;
    const measure=active?data.windows?.['30']?.sip_report:null;
    const safe=active&&state.live?.status==='connected'&&!data.quality?.length&&measure?.quality_pass;
    const clean=value=>Number.isFinite(value)?value.toFixed(2):'N/A';
    $('observational-asof').textContent=active?`Completed second ${new Date(data.end_ns/1e6).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})} CT · ${data.clock_precision} vendor clock`:'Unavailable';
    const livePrice=state.liveTick?.c??state.live?.bars?.[state.symbol]?.at(-1)?.c;
    $('observational-context').textContent=`${state.symbol} · ${livePrice==null?'Price unavailable':money(livePrice)}`;
    const known=active?Object.entries(data.level_states||{}):[];
    const nearest=safe&&Number.isFinite(livePrice)?known.sort((a,b)=>Math.abs(a[1].price-livePrice)-Math.abs(b[1].price-livePrice))[0]:null;
    $('observational-level').textContent=nearest?
      `${nearest[0]} ${money(nearest[1].price)} · ${nearest[1].state} · distance ${money(Math.abs(livePrice-nearest[1].price))}`:
      'Level state unavailable · use sourced chart levels';
    $('observational-pressure').textContent=safe?
      `${clean(measure.ofi_normalized)} OFI · ${(data.trajectory_state||'insufficient_evidence').replaceAll('_',' ')}`:'N/A';
    $('observational-coverage').textContent=!safe||measure?.coverage==null?'Coverage unavailable':
      `${(100*measure.coverage).toFixed(1)}% classified · Δ ${number(measure.delta)} · ${(data.persistence_state||'insufficient_evidence').replaceAll('_',' ')}`;
    $('observational-response').textContent=safe&&measure.mid_move_cents!=null?
      `${clean(measure.mid_move_cents)}¢ midpoint`:'N/A';
    $('observational-spread').textContent=!safe||measure?.spread_cents==null?'Fresh spread unavailable':
      `Spread ${clean(measure.spread_cents)}¢ · quote age ${clean(measure.quote_age_ms)} ms`;
    const reasons=active?[...(state.live?.status==='connected'?[]:[`FEED_${(state.live?.status||'unknown').toUpperCase()}`]),
      ...(data.quality||[]),...(measure?.quality_reasons||[])]:[data?.reason||'No research data'];
    $('observational-quality').textContent=reasons.length?reasons.join(', '):'Eligible descriptive sample';
    $('observational-receipt').textContent=active?
      `Market event ${new Date(data.event_ns/1e6).toLocaleTimeString('en-US',{timeZone:'America/Chicago'})} CT · local feature ingest ${new Date(data.feature_ingest_ns/1e6).toLocaleTimeString('en-US',{timeZone:'America/Chicago'})} CT`:
      'No current research ingest';
    $('observational-policies').textContent=active?['sip_report','strict_latest','execution_asof_visible'].map(policy=>{
      const row=data.windows?.['30']?.[policy];
      return `${policy}: buyer ${number(row?.buyer)} · seller ${number(row?.seller)} · unknown ${number(row?.unknown)} · unmatched ${number(row?.unmatched)} · ${row?.quality_pass?'eligible':(row?.quality_reasons||[]).join(', ')}`;
    }).join('\n')+(known.length?'\n'+known.map(([name,row])=>
      `${name} ${money(row.price)}: ${row.state} · ${row.source} · ${row.quality}`).join('\n'):''):
      'No completed research observation';
  }
  function closeLiveUpdates(){if(liveUpdates){liveUpdates.close();liveUpdates=null}}
  function connectLiveUpdates(){
    closeLiveUpdates();
    if(state.mode!=='live'||!state.watchlist.includes(state.symbol))return;
    const symbol=state.symbol;
    const base=apiBase();
    liveUpdates=new EventSource(`${base}/api/updates?symbol=${symbol}`);
    liveUpdates.onerror=()=>{
      if(state.mode!=='live'||state.symbol!==symbol)return;
      if(state.live?.status==='offline')return;
      state.live={...(state.live||{}),status:'stale',message:'Dashboard update stream disconnected; reconnecting'};
      liveFeedStatus(state.live);
      renderZoneInspector();
      renderObservational();
      paintLiveTick(false);
    };
    liveUpdates.onmessage=event=>{
      if(state.mode!=='live'||state.symbol!==symbol)return;
      let signal;
      try{signal=JSON.parse(event.data)}catch(_error){return}
      if(document.hidden)return;
      maybeRefreshObservational();
      if(signal.versions&&typeof signal.versions==='object'){
        const changed=state.watchlist.some(symbol=>state.boardVersions[symbol]!==signal.versions[symbol]);
        state.boardVersions=signal.versions;
        if(changed&&state.boardMode)refreshBoardLive();
      }
      if(signal.runId!==state.liveTickRunId||signal.tickVersion!==state.liveTickVersion){
        state.liveTickRunId=signal.runId;
        state.liveTickVersion=signal.tickVersion;
        state.liveTick=signal.tick||null;
        if(!state.boardMode)paintLiveTick();
      }
      if(!signal.active){loadServerWatchlist().then(()=>refreshLive().finally(connectLiveUpdates));return}
      if(Array.isArray(signal.watchlist)&&orderWatchlist(signal.watchlist).join(',')!==state.watchlist.join(','))
        loadServerWatchlist().catch(error=>watchError(`Watchlist unavailable: ${error.message}`));
      if(signal.date!==state.live?.date||signal.runId!==state.live?.runId||
          signal.version!==state.live?.version){refreshLive();return}
      // The stream heartbeat only changes feed freshness, not the candle table.
      Object.assign(state.live,{status:signal.status,message:signal.message,
        receivedAgeSeconds:signal.receivedAgeSeconds,eventLagSeconds:signal.eventLagSeconds,
        feedGapsOrOutOfOrderDrops:signal.feedGapsOrOutOfOrderDrops,
        refillStatus:signal.refillStatus,refillThroughMs:signal.refillThroughMs});
      liveFeedStatus(state.live);
      renderZoneInspector();
      renderObservational();
      if(!state.boardMode)paintLiveTick(false);
    };
  }
  let replayTickKey='';
  function renderReplayTicks(series,currentIndex){
    const host=$('replay-ticks');
    if(!series?.length){host.replaceChildren();replayTickKey='';return}
    const key=`${state.demo?.date}|${state.timeframe}|${series.length}|${series[0].stampMs}|${series.at(-1).stampMs}`;
    if(key!==replayTickKey){
      replayTickKey=key;host.replaceChildren();
      const firstTime=series[0].t.slice(0,5),lastTime=series.at(-1).t.slice(0,5),
        max=series.length-1;
      for(let minutes=3*60;minutes<=15*60;minutes+=30){
        const target=`${String(Math.floor(minutes/60)).padStart(2,'0')}:${minutes%60?'30':'00'}`;
        const archiveEnd=target==='11:00'&&lastTime==='10:59';
        const sessionEnd=target==='15:00'&&lastTime>='14:59';
        if(target<firstTime||!archiveEnd&&!sessionEnd&&lastTime<target)continue;
        const index=archiveEnd||sessionEnd?max:series.findIndex(row=>row.t>=target);
        if(index<0)continue;
        const button=document.createElement('button');button.type='button';
        button.className='replay-tick';
        if(target==='08:30')button.classList.add('open-tick');
        else if(minutes%60)button.classList.add('half-hour-tick');
        else if(!['03:00','06:00','11:00','15:00'].includes(target))button.classList.add('optional-tick');
        const position=max?index/max*100:0;
        if(position<4)button.classList.add('edge-start');
        if(position>96)button.classList.add('edge-end');
        button.style.setProperty('--tick-position',`${position}%`);
        button.dataset.index=String(index);button.dataset.short=target.slice(0,2);
        button.textContent=target;
        button.title=`Jump to ${target} CT${series[index].t.slice(0,5)===target?'':` (next recorded ${series[index].t})`}`;
        button.setAttribute('aria-label',button.title);
        button.onclick=()=>{stop();state.selectedStamp=null;
          if(state.timeframe===.5)state.halfIndex=index;else state.index=index;
          state.chartFocusMs=series[index].stampMs+(state.timeframe===.5?30_000:60_000);
          render()};
        host.append(button);
      }
    }
    for(const button of host.children)button.classList.toggle('is-current',Number(button.dataset.index)===currentIndex);
  }
  function render(){
    if(state.mode==='choose')return;
    const amd=current(),latest=amd.at(-1),partial=candlePartial(),
      row=state.selectedStamp!=null?amd.find(r=>r.stampMs===state.selectedStamp)||latest:partial&&!partial.awaiting?partial:latest;
    $('aggregation-note').textContent=state.timeframe===.5?'Completed 30-second raw trade/quote buckets · updates after event-time reorder':state.timeframe===1?'1-minute tape':`${state.timeframe}-minute candles · trade shares and dollars summed · OFI is the mean of available 1-minute OFI readings · midprice response sums available 1-minute moves`;
    if(state.mode==='replay'){
      if(state.demo){const series=state.timeframe===.5?state.half?.bars?.[state.symbol]:state.replayTimeline;
        const index=state.timeframe===.5?state.halfIndex:state.index;
        status(replayCursor()?.priceOnly?
          `REPLAY · ${state.demo.date} · 03:00–05:59 historical price only · pressure N/A`:
          `REPLAY · ${state.demo.date} · ${current().length} completed ${intervalLabel()} candles`,'warn');
        const asofMs=series?.[index]?.stampMs+(state.timeframe===.5?30_000:60_000)+2000;
        $('asof').textContent=Number.isFinite(asofMs)?`As of ${clockTimeSeconds(asofMs)} CT`:'As of —';
        $('asof').title='Replay cursor at source-candle completion plus the estimated two-second display delay; independent of the wall clock';
        $('scrub').max=Math.max(0,(series?.length||1)-1);$('scrub').value=index;
        for(const id of ['scrub','previous','next','play'])$(id).disabled=false;
        renderReplayTicks(series,index)}
      else{
        $('asof').textContent=state.replayLoadError?'Replay unavailable':'Loading replay…';
        $('scrub').value=0;
        for(const id of ['scrub','previous','next','play'])$(id).disabled=true;
        renderReplayTicks([],0);
      }
    }else{
      liveFeedStatus(state.live||{});
    }
    $('clock').textContent=latest?`Last complete ${intervalLabel()} candle: ${latest.t}–${clockTime(latest.stampMs+state.timeframe*60000)} CT`:`Last complete ${intervalLabel()} candle: —`;
    applyReplayView();
    if(state.boardMode){$('replay-chart').hidden=true;renderWatchlistBoard();return}
    $('price-label').textContent=`${state.symbol} ${row?.partial?'provisional last':'close'}`;
    $('price').textContent=money(row?.c);$('price-time').textContent=row?`${row.t} CT${row.partial?' · '+(state.mode==='replay'?'REPLAY':'LIVE')+' through '+clockTimeSeconds(row.throughMs):state.selectedStamp!=null?' · selected':''}`:'—';$('range').textContent=row?`H ${money(row.h)} · L ${money(row.l)}`:'Waiting for a complete minute';
    $('buyer-shares').textContent=row?number(row.buy):'—';
    $('seller-shares').textContent=row?number(row.sell):'—';
    $('shares').closest('.metric').classList.toggle('has-shares',!!row);
    activityTheme($('shares').closest('.metric'),row&&Math.abs(row.imbalancePct??0)>=10?row.delta:0);
    $('delta').textContent=row?`${signedShares(row.delta)} · ${row.imbalancePct==null?'—':signed(row.imbalancePct,1)+'%'}`:'—';tone($('delta'),row?.delta);
    activityTheme($('delta').closest('.metric'),row&&Math.abs(row.imbalancePct??0)>=10?row.delta:0);
    const qualityItem=state.mode==='replay'&&REPLAY_EVIDENCE_V1&&row&&!row.partial?
      replayQualityItem(row.stampMs):null;
    if(state.mode==='replay'&&REPLAY_EVIDENCE_V1){
      const evidence=row?.partial?{kind:'incomplete'}:row?
        window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence({...row,complete:true},qualityItem,state.timeframe):
        {kind:'missing'};
      for(const id of ['shares','delta'])$(id).closest('.metric').dataset.deltaEvidence=evidence.kind;
    }else for(const id of ['shares','delta'])delete $(id).closest('.metric').dataset.deltaEvidence;
    $('coverage').textContent=state.mode==='replay'&&REPLAY_EVIDENCE_V1?
      qualityItem&&Number.isFinite(qualityItem.coverageAll)?
        `${qualityItem.coverageAll.toFixed(1)}% eligible-lit coverage · raw audit`:
        state.replayQualityStatus==='loading'?'Loading raw coverage…':
        row?.partial?'Incomplete candle · coverage provisional':
        row?.coveragePct==null?'Classified coverage unavailable':'Raw coverage unavailable':
      row?.coveragePct==null?'No classified print':`${row.coveragePct.toFixed(1)}% classified coverage`;
    $('ofi').textContent=signed(row?.ofi,3);tone($('ofi'),row?.ofi);
    $('spread').textContent=row?.medianSpreadCents==null?'No valid quote':`${row.medianSpreadCents.toFixed(1)}¢ median spread`;
    $('queue').textContent=signed(row?.queue,3);tone($('queue'),row?.queue);
    $('response').textContent=row?.midMoveCents==null?'—':`${signed(row.midMoveCents,1)}¢`;tone($('response'),row?.midMoveCents);
    $('net').textContent=compact(row?.netOutflowUsd);tone($('net'),-(row?.netOutflowUsd||0));
    $('net-note').textContent=state.mode==='replay'&&state.demo?.available?.netOutflowUsd===false?'Unavailable in this processed session':'Seller − buyer classified dollars';
    if($('freshness'))$('freshness').textContent=state.mode==='live'?(state.live?.eventLagSeconds!=null?`Feed ${state.live.eventLagSeconds}s old · ${state.symbol} bar ${latest?Math.max(0,Math.round(Date.now()/1000-(latest.stampMs/1000+state.timeframe*60)))+'s old':'unavailable'}`:'No feed event yet'):`Recorded ${state.symbol} tape`;
    renderAnalytics();
    renderFlow();
    renderMultiPressure();
    renderReplayChart();
    renderFormationStatus(latest,partial);
    renderTraderView(amd,row);
    renderVolumePanel();
    renderBehindCandle();
    renderDecisionContext();
    renderObservational();
    if(state.mode==='live')paintLiveTick(false);
    refreshLevelsCard();
    if(window.TRADER_UI_V2)requestAnimationFrame(sizeWorkspaceHero);
  }
  function renderFormationStatus(last,partial){
    const replay=state.mode==='replay',today=chicagoDate(Date.now());
    const currentSession=state.live?.date===today&&!isWeekend(today);
    const connected=currentSession&&state.live?.status==='connected';
    const forming=state.selectedStamp==null&&partial&&!partial.awaiting&&(replay||connected);
    const waiting=state.selectedStamp==null&&(replay?partial?.awaiting:connected&&(!partial||partial.awaiting));
    const chosen=state.selectedStamp!=null?current().find(row=>row.stampMs===state.selectedStamp):null;
    const shown=chosen||forming&&partial||last;
    $('formation-title').textContent=forming?'Forming candle':chosen?'Selected candle':replay?'Replay candle':'Latest completed candle';
    $('formation-badge').textContent=forming?'PROVISIONAL':replay?'REPLAY':waiting?'WAITING':connected?'COMPLETE':'NOT LIVE';
    $('formation-badge').className=forming?'provisional':connected?'connected':'';
    const duration=state.timeframe*60_000;
    $('formation-interval').textContent=shown?`${clockTimeSeconds(shown.stampMs)}–${clockTimeSeconds(shown.stampMs+duration)} CT`:'No completed candle';
    $('formation-source').textContent=replay&&forming?`Replay estimate through ${clockTimeSeconds(partial.throughMs)} CT from completed 30-second buckets; no future tape is used.`:
      replay?'Event data only through replay as-of; historical arrival time unrecorded.':
      forming?`Provisional measurements through ${clockTimeSeconds(partial.throughMs)} CT; source buckets close every 30 seconds.`:
      waiting?'Waiting for a completed 30-second bucket; no intrabucket values are available.':
      currentSession?'Last completed candle. Live formation requires a fresh connected feed.':
      'No current trading session; archived data is available in Replay mode.';
    const qualityStatus=$('replay-quality-status');
    qualityStatus.hidden=!(replay&&REPLAY_EVIDENCE_V1);
    if(!qualityStatus.hidden){
      const item=shown&&!shown.partial?replayQualityItem(shown.stampMs):null;
      const evidence=shown?.partial?{kind:'incomplete',label:'Incomplete candle · delta border withheld'}:
        state.replayQualityStatus==='loading'?{kind:'loading',label:'Loading raw-tape quality…'}:
        state.replayQualityStatus!=='ready'?{kind:'missing',label:`Raw quality unavailable · ${state.replayQualityStatus}`}:
        window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence(
          {...shown,complete:true},item,state.timeframe);
      qualityStatus.textContent=`Delta evidence: ${evidence.label}${item?.reason==='insufficient prior dates'?' · score baseline missing':''}`;
      qualityStatus.className=`replay-quality-status ${evidence.kind}`;
    }
    const elapsed=forming?Math.max(0,Math.min(duration,partial.throughMs-partial.stampMs)):0;
    $('formation-progress-bar').style.width=forming?`${100*elapsed/duration}%`:'0%';
  }
  let boardRefreshPending=false,boardReplayPending='',boardReferenceTimer=null;
  let boardReferenceKey='',boardReferenceVersion=0;
  function boardDay(){return state.mode==='replay'?state.demo?.date:state.live?.date}
  function boardSeries(symbol,half=false){
    if(state.mode==='live')return (half?state.boardHalf[symbol]:state.boardLive[symbol])?.bars?.[symbol]||
      (symbol===state.symbol?(half?state.half:state.live)?.bars?.[symbol]:null)||[];
    const day=boardDay(),payload=state.boardReplay[day]?.[symbol];
    if(payload)return half?payload.half:payload.minute;
    return symbol===state.symbol?(half?state.half?.bars?.[symbol]:state.demo?.bars?.[symbol])||[]:[];
  }
  function boardHistory(symbol){
    if(symbol==='AMD'&&!state.symbolHistory.AMD)return state.timeframe===.5?window.AMD_HALF_ANALYTICS_HISTORY:
      state.timeframe<5?window.AMD_SHORT_ANALYTICS_HISTORY:window.AMD_ANALYTICS_HISTORY;
    const history=state.symbolHistory[symbol];
    return state.timeframe===.5?history?.half:history;
  }
  function archiveEndCt(symbol,history){
    return history?.windowCt?.[1]||state.symbolHistory[symbol]?.windowCt?.[1]||sessionWindow().archiveEndCt;
  }
  function sessionWindow(){
    // The collector owns the live clock contract. Defaults preserve the
    // current collector's 11:00 reference limit until it is restarted.
    return state.live?.sessionWindow||{startCt:'03:00',openCt:'08:30',endCt:'15:00',archiveEndCt:'11:00'};
  }
  function referenceEndCt(){return state.live?.referenceEndCt||sessionWindow().archiveEndCt}
  function lastReferenceMinute(stamp){
    const minute=Math.floor(stamp/60_000)*60_000;
    const ct=clockTime(minute),end=referenceEndCt();
    if(ct<end)return minute;
    const [hour,part]=ct.split(':').map(Number),[endHour,endPart]=end.split(':').map(Number);
    return minute-((hour*60+part)-(endHour*60+endPart)+1)*60_000;
  }
  function boardReferenceStamp(anchor){
    const end=anchor+state.timeframe*60_000;
    const completedMinute=Math.floor(end/60_000)*60_000-60_000;
    return lastReferenceMinute(completedMinute);
  }
  function renderWatchlistBoard(skipReferences=false){
    const host=$('board-rows'),day=boardDay(),duration=state.timeframe*60_000;
    const archiveLoading=state.mode==='replay'&&boardReplayPending===day;
    const closedLive=state.mode==='live'&&isWeekend(chicagoDate(Date.now()));
    if(state.mode==='replay'&&$('replay-date').value!==day){
      $('board-asof').textContent=`Loading ${$('replay-date').value}…`;
      host.replaceChildren();return;
    }
    let anchor=state.mode==='replay'?(state.selectedStamp??current().at(-1)?.stampMs):null;
    if(state.mode==='live')for(const symbol of state.watchlist){
      const source=boardSeries(symbol,state.timeframe===.5);
      if(!source.length)continue;
      const bars=aggregate(source,state.timeframe,source.at(-1).stampMs+(state.timeframe===.5?30_000:60_000));
      if(bars.length)anchor=Math.max(anchor??0,bars.at(-1).stampMs);
    }
    const closeStamp=anchor==null?null:anchor+duration;
    $('board-asof').textContent=closedLive?'Market closed · no current session':
      anchor==null?'Waiting for completed watchlist tape':
      `${day||'—'} · ${clockTime(anchor)}–${clockTime(closeStamp)} CT · ${intervalLabel()}`;
    $('board-source').textContent=closedLive?'Market closed · no current live tape':
      state.mode==='replay'?'Historical replay · same selected completed candle across symbols':
      'Live completed candles · same interval across symbols';
    host.replaceChildren();
    for(const symbol of state.watchlist){
      const source=boardSeries(symbol,state.timeframe===.5),minute=boardSeries(symbol,false);
      const bars=anchor==null?[]:aggregate(source,state.timeframe,closeStamp);
      const row=bars.findLast(item=>item.stampMs===anchor);
      const net=(start,end)=>anchor==null?null:minute.filter(item=>item.stampMs<closeStamp&&
        item.t>=start&&item.t<end).reduce((n,item)=>n+(Number.isFinite(item.delta)?item.delta:0),0);
      const session=sessionWindow();
      const verifiedFullReplay=state.mode==='replay'&&
        !!state.symbolHistory[symbol]?.sessions?.some(item=>item.date===day);
      const hasPre=minute.some(item=>item.stampMs<closeStamp&&item.t>=session.startCt&&
        item.t<session.openCt&&(verifiedFullReplay||item.t<='06:01'));
      const hasMarket=minute.some(item=>item.stampMs<closeStamp&&item.t>=session.openCt&&
        item.t<session.endCt&&(verifiedFullReplay||item.t===session.openCt));
      const pre=state.boardPremarket[symbol],preValid=pre?.available&&pre.sessionDate===day&&
      (pre.complete?closeStamp!=null&&clockTime(closeStamp)>='08:26':
          closeStamp!=null&&clockTime(closeStamp)<'08:26'&&pre.asOfStampMs<=closeStamp);
      const midpoint=preValid?pre.midpoint:null;
      const options=state.boardOptions[symbol],optionsValid=options?.available&&
        options.sessionDate===day&&options.capturedStampMs<=boardReferenceStamp(anchor??0)+60_000;
      const oiStrikes=optionsValid&&row?
        window.TRADEYODHA_REPLAY_CHART?.notableOiStrikes(options,3)||[]:[];
      const replayError=state.mode==='replay'?state.boardReplayErrors[symbol]:null;
      const archivePending=state.mode==='replay'&&day===chicagoDate(Date.now())&&
        !verifiedFullReplay&&replayError?.includes('HTTP 404');
      const wrapper=document.createElement('div');wrapper.className='board-row'+(row?'':' missing');
      const cell=(label,value,note='',bias=0,extra='')=>{
        const el=document.createElement('div');el.className=`board-cell ${extra}${bias>0?' buy':bias<0?' sell':''}`;
        const small=document.createElement('small');small.textContent=label;
        const bold=document.createElement('b');bold.textContent=value;
        const em=document.createElement('em');em.textContent=note;
        el.append(small,bold,em);wrapper.append(el);return el;
      };
      const symbolCell=cell('SYMBOL','',row?row.t+' CT':closedLive?'Market closed':archiveLoading?'Loading archive…':replayError||'No candle',0,'board-symbol');
      const link=document.createElement('button');link.type='button';link.textContent=symbol;
      link.title=`Open ${symbol} candle detail`;link.onclick=()=>selectWatchSymbol(symbol);
      link.disabled=state.mode==='replay'&&!state.symbolHistory[symbol]&&symbol!=='AMD';
      symbolCell.querySelector('b').replaceWith(link);
      cell('CLOSE',row?money(row.c):'—',row?`H ${money(row.h)} · L ${money(row.l)}`:
        closedLive?'No current session':archiveLoading?'Loading verified session tape':'Missing interval');
      const shares=cell('BUY / SELL',row?`${number(row.buy)} / ${number(row.sell)}`:'—',
        row?.coveragePct==null?closedLive?'No current session':archiveLoading?'Loading verified session tape':'No classified print':
          `${row.coveragePct.toFixed(1)}% classified`);
      if(row){shares.querySelector('b').textContent='';const buy=document.createElement('span');buy.className='buy-text';buy.textContent=number(row.buy);
        const sell=document.createElement('span');sell.className='sell-text';sell.textContent=number(row.sell);
        shares.querySelector('b').append(buy,document.createTextNode(' / '),sell)}
      cell('TRADE Δ · IMBALANCE',row?`${flowShares(row.delta)} · ${signed(row.imbalancePct,1)}%`:'—',
        row?`Quote OFI ${signed(row.ofi,3)}`:closedLive?'No current session':archiveLoading?'Loading verified session tape':'Missing interval',
        row&&Math.abs(row.imbalancePct??0)>=10?row.delta:0);
      cell('SESSION NET',`${hasPre?flowShares(net(session.startCt,session.openCt)):'—'} / ${hasMarket?flowShares(net(session.openCt,session.endCt)):'—'}`,
        hasPre&&hasMarket?'Premarket / from open':closedLive?'No current session':archiveLoading?'Loading verified session tape':archivePending?
          'Today’s verified full-session archive is still publishing':
          `Incomplete ${session.startCt} / ${session.openCt} tape`);
      cell('PREMARKET LEVELS',preValid?`${money(pre.high)} / ${money(midpoint)} / ${money(pre.low)}`:'—',
        preValid?'High / .50 / low · 03:00–08:25 CT':closedLive?'No current session':archiveLoading?'Loading point-in-time levels':'As-of levels unavailable',0,'board-levels');
      cell('TOP NEARBY OI',oiStrikes.length?oiStrikes.map(item=>money(item.strike)).join(' / '):'—',
        optionsValid?`Top three call + put OI · fixed around ${money(options.referenceSpot)} · ${clockTime(options.capturedStampMs)} CT`:
          closedLive?'No current session':archiveLoading?'Loading point-in-time reference':'Point-in-time snapshot unavailable',0,'board-levels');
      host.append(wrapper);
    }
    if(!skipReferences&&anchor!=null)scheduleBoardReferences(day,boardReferenceStamp(anchor));
  }
  let boardLastFetchKey='';
  async function refreshBoardLive(force=false){
    if(!state.boardMode||boardRefreshPending)return;
    const day=chicagoDate(Date.now());
    const versions={...state.boardVersions};
    const versionKey=Object.keys(versions).length?
      state.watchlist.map(symbol=>`${symbol}:${versions[symbol]??'?'}`).join(','):
      `selected:${state.live?.version??'initial'}`;
    const context=`${day}|${state.live?.runId||''}`;
    const key=`${context}|${state.timeframe}|${versionKey}`;
    if(!force&&key===boardLastFetchKey)return;
    boardRefreshPending=true;
    const base=apiBase();
    const half=state.timeframe===.5;
    const targets=state.watchlist.filter(symbol=>force||context!==state.boardFetchedContext||
      !state.boardLive[symbol]||
      versions[symbol]==null||versions[symbol]!==state.boardFetchedVersions[symbol]||
      half&&!state.boardHalf[symbol]);
    const pull=async(symbol,isHalf)=>{
      const prior=(isHalf?state.boardHalf:state.boardLive)[symbol];
      const stamp=prior?.bars?.[symbol]?.at(-1)?.stampMs;
      const delta=stamp==null?'':`&afterMs=${stamp}&runId=${encodeURIComponent(prior.runId)}&clientDate=${prior.date}`;
      const path=isHalf?`/api/half?date=${day}&symbol=${symbol}`:`/api/state?symbol=${symbol}`;
      const response=await fetch(`${base}${path}${delta}`,{cache:'no-store',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error(`${symbol} ${isHalf?'30s':'1m'} HTTP ${response.status}`);
      const fresh=await response.json();
      if(fresh.date!==day||!Array.isArray(fresh.bars?.[symbol]))throw Error(`${symbol} session mismatch`);
      (isHalf?state.boardHalf:state.boardLive)[symbol]=mergeLiveSnapshot(prior,fresh,symbol,isHalf?1200:600);
    };
    const results=await Promise.allSettled(targets.map(async symbol=>{
      await pull(symbol,false);if(half)await pull(symbol,true);
      if(versions[symbol]!=null)state.boardFetchedVersions[symbol]=versions[symbol];
    }));
    boardLastFetchKey=results.every(result=>result.status==='fulfilled')?key:'';
    if(results.every(result=>result.status==='fulfilled'))state.boardFetchedContext=context;
    boardRefreshPending=false;
    if(state.boardMode&&state.mode==='live')renderWatchlistBoard();
    if(state.boardMode&&state.mode==='live'&&
       state.watchlist.some(symbol=>state.boardVersions[symbol]!==versions[symbol]))
      queueMicrotask(()=>refreshBoardLive());
  }
  let boardReplayVersion=0;
  async function loadBoardReplay(day){
    if(!state.boardMode||!day)return;
    const version=++boardReplayVersion;boardReplayPending=day;
    const base=apiBase();
    const payloads=await Promise.allSettled(state.watchlist.map(async symbol=>{
      const fullArchive=state.symbolHistory[symbol]?.sessions?.some(item=>item.date===day);
      const path=fullArchive||symbol!=='AMD'?`watchlist-replay/${symbol}/${day}.json`:`replay/${day}.json`;
      const response=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error(`${symbol} replay HTTP ${response.status}`);
      const payload=await response.json();
      if(payload.date!==day||(fullArchive||symbol!=='AMD')&&payload.symbol!==symbol)throw Error(`${symbol} replay mismatch`);
      if(symbol==='AMD'&&!fullArchive){
        const halfResponse=await fetch(`replay30/${day}.json`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
        const halfPayload=halfResponse.ok?await halfResponse.json():null;
        return {symbol,minute:payload.bars?.AMD||[],half:halfPayload?.date===day?halfPayload.bars?.AMD||[]:[]};
      }
      const entry=state.symbolHistory[symbol]?.sessions?.find(item=>item.date===day);
      if(!entry||payload.sourceSha256?.trades!==entry.sourceSha256?.trades||
          payload.sourceSha256?.quotes!==entry.sourceSha256?.quotes||
          payload.halfMinuteParityChecks!==entry.parityChecks)throw Error(`${symbol} replay provenance mismatch`);
      return {symbol,minute:payload.bars?.['1m']||[],half:payload.bars?.['30s']||[]};
    }));
    if(version!==boardReplayVersion||!state.boardMode)return;
    const snapshot={};state.boardReplayErrors={};
    payloads.forEach((result,index)=>{
      if(result.status==='fulfilled'){
        const item=result.value;snapshot[item.symbol]={minute:item.minute,half:item.half};
      }else state.boardReplayErrors[state.watchlist[index]]=result.reason?.message||'Replay validation failed';
    });
    state.boardReplay={[day]:snapshot};boardReplayPending='';renderWatchlistBoard();
  }
  function setBoardMode(enabled){
    if(state.boardMode===enabled)return;
    state.boardMode=enabled;
    if(enabled&&state.mode==='replay')boardReplayPending=boardDay();
    if(enabled&&state.mode==='live')state.selectedStamp=null;
    renderWatchlist();render();
    if(!enabled)return;
    if(state.mode==='live')for(const symbol of state.watchlist)if(!state.symbolHistory[symbol])
      loadSymbolHistory(symbol).then(()=>{if(state.boardMode)renderWatchlistBoard()})
        .catch(()=>{if(state.boardMode)renderWatchlistBoard()});
    if(state.mode==='live'&&!isWeekend(chicagoDate(Date.now())))refreshBoardLive(true);
    else Promise.all(state.watchlist.map(symbol=>
      state.symbolHistory[symbol]?Promise.resolve():loadSymbolHistory(symbol).catch(()=>{})))
      .then(()=>loadBoardReplay(boardDay()));
  }
  function scheduleBoardReferences(day,stamp){
    if(!day||!Number.isFinite(stamp))return;
    const fixed=clockTime(stamp)>='08:25';
    const key=`${day}|${state.mode}|${fixed?'fixed':Math.floor(stamp/300000)}|${Math.floor(stamp/900000)}`;
    if(key===boardReferenceKey)return;
    clearTimeout(boardReferenceTimer);
    boardReferenceTimer=setTimeout(()=>refreshBoardReferences(day,stamp,key),150);
  }
  async function refreshBoardReferences(day,stamp,key){
    const version=++boardReferenceVersion;boardReferenceKey=key;
    const base=apiBase();
    const query=(symbol)=>new URLSearchParams({symbol,date:day,asofStampMs:String(stamp)});
    const get=async(symbol,path,timeout)=>{
      const response=await fetch(`${base}${path}?${query(symbol)}`,{signal:AbortSignal.timeout(timeout)});
      const payload=await response.json();if(!response.ok)throw Error(payload.error||`HTTP ${response.status}`);
      return payload;
    };
    await Promise.all(state.watchlist.map(async symbol=>{
      try{const report=await get(symbol,'/api/premarket-levels',15000);
        if(version===boardReferenceVersion)state.boardPremarket[symbol]={...report.premarket,sessionDate:day,asOfStampMs:stamp+60000};
      }catch(_error){if(version===boardReferenceVersion)state.boardPremarket[symbol]={available:false,sessionDate:day}}
    }));
    if(version!==boardReferenceVersion)return;
    if(state.boardMode)renderWatchlistBoard(true);
    for(const symbol of state.watchlist){
      if(version!==boardReferenceVersion)return;
      const cached=state.boardOptions[symbol];
      if(cached?.available&&cached.sessionDate===day&&cached.capturedStampMs<=stamp+60_000)continue;
      try{state.boardOptions[symbol]=await get(symbol,'/api/options-walls',120000)}
      catch(_error){state.boardOptions[symbol]={available:false,sessionDate:day}}
      if(version===boardReferenceVersion&&state.boardMode)renderWatchlistBoard(true);
    }
  }
  function researchWindow(stamp,duration,asOf){
    const bars=state.micro?.bars?.filter(item=>item.stampMs>=stamp&&item.stampMs+30000<=stamp+duration)||[];
    if(bars.length!==duration/30000)return null;
    const sum=key=>bars.reduce((n,item)=>n+(item[key]||0),0);
    const mids=bars.filter(item=>Number.isFinite(item.firstMid)&&Number.isFinite(item.lastMid));
    const midCents=mids.length?100*(mids.at(-1).lastMid-mids[0].firstMid):null;
    const depthDenominator=sum('ofiDepthDenominator');
    const depthOfi=depthDenominator?sum('ofiSigned')/depthDenominator:null;
    const events=bars.flatMap(item=>item.sweepEvents||[]);
    const matured=events.filter(item=>item.observedMs<=asOf);
    const buy=sum('buyShares'),sell=sum('sellShares');
    return {buy,sell,midCents,depthOfi,
      sellSweeps:sum('sellSweepCandidates'),buySweeps:sum('buySweepCandidates'),
      sellSweepShares:sum('sellSweepShares'),buySweepShares:sum('buySweepShares'),
      bidDepletion:sum('bidDepletionShares'),bidReplenishment:sum('bidReplenishmentShares'),
      sellRun:Math.max(...bars.map(item=>item.maxSellRunShares)),
      peakSell5s:Math.max(...bars.map(item=>item.peakSell5sShares)),
      impact:sell-buy>=2500&&(sell-buy)/(sell+buy)>=0.10&&midCents!=null?
        midCents/((sell-buy)/2500):null,
      impact1k:sell-buy>=1000&&(sell-buy)/(sell+buy)>=0.10&&midCents!=null?
        midCents/((sell-buy)/1000):null,
      continuation:matured.length?matured.reduce((n,item)=>n+item.followThroughCents,0)/matured.length:null,
      matured:matured.length};
  }
  const footprintCache=new Map();
  let footprintRequestKey='';
  let footprintPaintKey='';
  function replayFootprint(stamp,duration){
    const parts=state.micro?.bars?.filter(item=>item.stampMs>=stamp&&item.stampMs<stamp+duration)||[];
    if(parts.length!==duration/30000||parts.some((item,index)=>
      item.stampMs!==stamp+index*30000||!Array.isArray(item.priceLevels)))return null;
    const prices=new Map();
    for(const part of parts)for(const [cents,total,buy,sell] of part.priceLevels){
      const row=prices.get(cents)||[0,0,0];row[0]+=total;row[1]+=buy;row[2]+=sell;prices.set(cents,row);
    }
    return {source:state.micro.source,levels:[...prices].sort((a,b)=>a[0]-b[0]).map(([cents,row])=>[cents,...row])};
  }
  function footprintLevels(start,end){
    const levels=[];
    const pre=state.premarketLevels;
    const day=state.mode==='replay'?state.demo?.date:state.live?.date;
    if(pre?.date===day){
      for(const [label,value] of [['PM high',pre.high],['PM .50',pre.midpoint],['PM low',pre.low]])
        if(Number.isFinite(value))levels.push({label,price:value});
    }
    const opening=(minuteTape()||[]).filter(row=>row.t>='08:30'&&row.t<='08:34'&&row.stampMs+60000<=end)
      .sort((a,b)=>a.stampMs-b.stampMs);
    if(opening.length===5&&start>=opening[4].stampMs+60000&&
      opening.every((row,index)=>Number.isFinite(row.h)&&Number.isFinite(row.l)&&
      row.stampMs===opening[0].stampMs+index*60000)){
      const high=Math.max(...opening.map(row=>row.h)),low=Math.min(...opening.map(row=>row.l));
      levels.push({label:'ORB high',price:high},{label:'ORB .50',price:(high+low)/2},{label:'ORB low',price:low});
    }
    return levels;
  }
  function paintFootprint(bar,profile,duration){
    if(!bar||!profile){$('footprint-head').textContent='No complete price-by-price tape for this candle.';
      $('footprint-rows').replaceChildren();$('footprint-levels').textContent='—';return}
    const levels=profile.levels||[];
    const total=levels.reduce((n,row)=>n+row[1],0),buy=levels.reduce((n,row)=>n+row[2],0),
      sell=levels.reduce((n,row)=>n+row[3],0);
    if(total!==bar.litShares||buy!==bar.buy||sell!==bar.sell||levels.some(row=>row[1]<row[2]+row[3])){
      $('footprint-head').textContent='Price-level totals did not match this candle; detail withheld.';
      paintLevelReaction(bar,null,duration);
      $('footprint-rows').replaceChildren();$('footprint-levels').textContent='—';return;
    }
    paintLevelReaction(bar,profile,duration);
    $('footprint-head').textContent=`${clockTime(bar.stampMs)}–${clockTime(bar.stampMs+duration)} CT · ${profile.source} · ${number(total)} lit shares`;
    const poc=levels.reduce((best,row)=>!best||row[1]>best[1]?row:best,null);
    $('footprint-poc').textContent=poc?money(poc[0]/100):'—';
    $('footprint-poc-note').textContent=poc?`${number(poc[1])} shares · ${(100*poc[1]/total).toFixed(1)}% of eligible lit volume`:'No eligible lit trades';
    const priceMove=Number.isFinite(bar.o)&&Number.isFinite(bar.c)?bar.c-bar.o:null;
    const response=priceMove==null?'No price response':
      buy+sell<1?'No classified trades':
      (bar.coveragePct??0)<65?'Low classified coverage':
      Math.abs(buy-sell)/(buy+sell)<.25?'Mixed aggression':
      Math.abs(priceMove)<=Math.max(.05,.2*((bar.h??bar.c)-(bar.l??bar.o)))?'Little price response':
      Math.sign(buy-sell)===Math.sign(priceMove)?'Pressure and price aligned':'Pressure opposed by price';
    $('footprint-effort').textContent=response;
    $('footprint-effort-note').textContent=`Delta ${flowShares(buy-sell)} · close ${priceMove==null?'—':`${priceMove>=0?'+':'−'}$${Math.abs(priceMove).toFixed(2)}`} · OFI ${signed(bar.ofi,3)}`;
    $('footprint-coverage').textContent=`${total?((buy+sell)/total*100).toFixed(1):'0.0'}% classified`;
    const body=$('footprint-rows');body.replaceChildren();
    for(const [cents,shares,atBuy,atSell] of [...levels].reverse()){
      const row=document.createElement('tr');
      const values=[money(cents/100),number(atBuy),number(atSell),number(shares-atBuy-atSell),number(shares),signedShares(atBuy-atSell)];
      for(let index=0;index<values.length;index++){
        const cell=document.createElement('td');cell.textContent=values[index];
        if(index===1||index===2)cell.className=index===1?'positive':'negative';
        if(index===5)tone(cell,atBuy-atSell);
        row.append(cell);
      }
      if(poc&&cents===poc[0])row.className='footprint-poc-row';
      body.append(row);
    }
    const band=Number($('footprint-band').value),close=bar.c;
    const near=footprintLevels(bar.stampMs,bar.stampMs+duration).filter(item=>
      Number.isFinite(bar.l)&&Number.isFinite(bar.h)&&bar.l-band<=item.price&&item.price<=bar.h+band)
      .sort((a,b)=>Math.abs(a.price-close)-Math.abs(b.price-close)).slice(0,4);
    const box=$('footprint-levels');box.replaceChildren();
    if(!near.length){box.textContent='No premarket or completed ORB level near this candle.';return}
    for(const item of near){
      const nearby=levels.filter(row=>Math.abs(row[0]/100-item.price)<=band+1e-9);
      const volume=nearby.reduce((n,row)=>n+row[1],0),delta=nearby.reduce((n,row)=>n+row[2]-row[3],0);
      const div=document.createElement('div');div.className='footprint-reaction';
      const title=document.createElement('b');title.textContent=`${item.label} ${money(item.price)}`;
      const detail=document.createElement('small');detail.textContent=
        `${number(volume)} lit shares within ±${Math.round(band*100)}¢ · delta ${flowShares(delta)} · close ${close>=item.price?'above':'below'} by ${Math.abs(close-item.price).toFixed(2)}`;
      div.append(title,detail);box.append(div);
    }
  }
  function paintLevelReaction(bar,profile,duration){
    const time=$('level-reaction-time'),title=$('level-reaction-state'),detail=$('level-reaction-detail');
    time.textContent=bar?`${clockTime(bar.stampMs)}–${clockTime(bar.stampMs+duration)} CT`:'—';
    const result=window.AMD_LEVEL_REACTION?.reaction(bar,profile,
      bar?footprintLevels(bar.stampMs,bar.stampMs+duration):[],.25);
    title.className='';
    if(!result){title.textContent='Price-level tape unavailable';detail.textContent='No level-local reading for this completed candle.';return}
    if(result.kind==='none'){
      title.textContent='No nearby key-level test';
      detail.textContent='Nearest premarket or completed ORB level is outside this candle’s range ±25¢.';return;
    }
    title.textContent=`${result.level.label} ${money(result.level.price)} · ${result.kind}`;
    title.className=result.kind==='crossed'?'neutral':result.kind==='held above'?'positive':
      result.kind==='rejected below'?'negative':'';
    detail.textContent=`Within ±25¢: ${number(result.localShares)} lit shares (${result.localSharePct.toFixed(0)}% of candle) · local Δ ${signedShares(result.localDelta)} · ${result.localCoveragePct.toFixed(0)}% classified · close ${result.closeDistance>=0?'+':'−'}$${Math.abs(result.closeDistance).toFixed(2)} from level`;
  }
  function renderFootprint(bar,duration){
    $('footprint-title').textContent=bar?`Candle detail · ${clockTime(bar.stampMs)} CT`:'Candle detail · waiting for tape';
    if(!$('footprint-panel').open)return;
    if(!bar){paintLevelReaction(null,null,duration);return}
    const date=state.mode==='replay'?state.demo?.date:state.live?.date;
    const key=`${state.mode}-${date}-${bar.stampMs}-${duration}`;
    const paintKey=`${key}-${$('footprint-band').value}-${state.premarketLevels?.midpoint??''}-${$('footprint-panel').open}`;
    if(footprintPaintKey===paintKey)return;
    const draw=profile=>{paintLevelReaction(bar,profile,duration);
      if($('footprint-panel').open)paintFootprint(bar,profile,duration);
      footprintPaintKey=paintKey};
    if(state.mode==='replay'){draw(replayFootprint(bar.stampMs,duration));return}
    if(footprintCache.has(key)){draw(footprintCache.get(key));return}
    if(footprintRequestKey===key)return;
    footprintRequestKey=key;$('footprint-head').textContent='Loading completed live price levels…';
    const base=apiBase();
    const query=new URLSearchParams({date,stampMs:String(bar.stampMs),durationMs:String(duration)});
    fetch(`${base}/api/footprint?${query}`,{signal:AbortSignal.timeout(10000)})
      .then(async response=>{if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json()})
      .then(profile=>{footprintCache.set(key,profile);if(footprintCache.size>40)footprintCache.delete(footprintCache.keys().next().value);
        if(footprintRequestKey===key)draw(profile)})
      .catch(()=>{if(footprintRequestKey===key)$('footprint-head').textContent='Live price-level detail unavailable for this candle.'})
      .finally(()=>{if(footprintRequestKey===key)footprintRequestKey='' });
  }
  function renderSessionFootprint(endMs,session){
    const source=minuteTape()||[];
    const cutoff=Number.isFinite(endMs)?endMs:0;
    const time=cutoff?clockTime(cutoff).slice(0,5):'';
    const endMinute=time?Number(time.slice(0,2))*60+Number(time.slice(3,5)):-1;
    const minuteOf=text=>Number(text.slice(0,2))*60+Number(text.slice(3,5));
    const classifiedStart=state.mode==='replay'?'06:00':session.startCt;
    $('session-footprint-premarket').querySelector('.session-footprint-top b').textContent=
      `Premarket classified · ${classifiedStart}–08:30`;
    for(const [id,startCt,endCt] of [
      ['session-footprint-premarket',classifiedStart,session.openCt],
      ['session-footprint-market',session.openCt,session.endCt]]){
      const box=$(id),start=minuteOf(startCt),end=minuteOf(endCt);
      const expected=Math.max(0,Math.min(endMinute,end)-start);
      const rows=source.filter(row=>row.stampMs+60_000<=cutoff&&row.t>=startCt&&row.t<endCt);
      const valid=rows.filter(row=>[row.buy,row.sell,row.litShares].every(value=>
        Number.isFinite(value)&&value>=0)&&row.buy+row.sell<=row.litShares);
      const buy=valid.reduce((sum,row)=>sum+row.buy,0);
      const sell=valid.reduce((sum,row)=>sum+row.sell,0);
      const lit=valid.reduce((sum,row)=>sum+row.litShares,0);
      const unknown=lit-buy-sell;
      const quality=box.querySelector('.session-footprint-quality');
      quality.textContent=expected?`${valid.length}/${expected} completed 1m${valid.length===expected?'':' · partial'}`:
        endMinute<start?'Not open yet':'Waiting for tape';
      const values=box.querySelector('.session-footprint-values');
      values.textContent=valid.length?`B ${number(buy)} · S ${number(sell)} · Δ ${signedShares(buy-sell)} · U ${number(unknown)}`:
        'Buyer — · Seller — · Unknown —';
      const track=box.querySelector('.session-footprint-track');
      track.title=`${startCt}–${endCt} CT · ${valid.length}/${expected} completed 1-minute rows · buyer ${number(buy)}, seller ${number(sell)}, unclassified ${number(unknown)} eligible lit shares`;
      for(const [name,value] of [['buy',buy],['sell',sell],['unknown',unknown]])
        track.querySelector(`.footprint-${name}`).style.width=lit?`${100*value/lit}%`:'0%';
    }
  }
  function renderMultiPressure(){
    const panel=$('ui3-pressure'),policy=window.TY_MULTI_PRESSURE;
    if(!panel||!policy||state.boardMode)return;
    const selectedEnd=state.selectedStamp==null?null:state.selectedStamp+state.timeframe*60_000;
    const cursorEnd=state.mode==='replay'?replayCursor()?.stampMs+60_000:Date.now();
    const asOfMs=selectedEnd==null?cursorEnd:Math.min(selectedEnd,cursorEnd??selectedEnd);
    const host=$('ui3-cards');host.replaceChildren();
    if(!Number.isFinite(asOfMs)){$('ui3-asof').textContent='Waiting for recorded tape';return}
    $('ui3-asof').textContent=`${state.mode==='replay'?'Reconstructed as of':'Live as of'} ${clockTimeSeconds(asOfMs)} CT${selectedEnd!=null?' · selected':''}`;
    host.classList.toggle('with-15m',state.ui3Show15);
    const sourceDate=state.mode==='replay'?state.demo?.date:state.live?.date;
    const minute=state.mode==='replay'?state.demo?.bars?.[state.symbol]:state.live?.bars?.[state.symbol];
    const half=state.half?.date===sourceDate?state.half?.bars?.[state.symbol]:null;
    const feed=state.live;
    const feedFresh=state.mode!=='live'||feed?.status==='connected'&&
      feed?.receivedAgeSeconds!=null&&feed.receivedAgeSeconds<=15&&
      feed?.eventLagSeconds!=null&&feed.eventLagSeconds<=15&&
      sourceDate===chicagoDate(Date.now());
    const localTime=stamp=>clockTimeSeconds(stamp);
    const display=(measurement,format)=>measurement?.value==null?'N/A':format(measurement.value);
    for(const width of state.ui3Show15?[.5,1,5,15]:[.5,1,5]){
      const duration=policy.durationMs(width),source=width===.5?half:minute;
      const complete=Array.isArray(source)?aggregate(source,width,asOfMs):[];
      const row=complete.at(-1);
      const constituents=row?(width===.5?[row]:(minute||[]).filter(item=>
        item.stampMs>=row.stampMs&&item.stampMs+60_000<=row.stampMs+duration)):[];
      const quality=row&&state.mode==='replay'?replayQualityItem(row.stampMs,width):null;
      const evidence=row&&state.mode==='replay'?window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence(
        {...row,complete:true},quality,width):null;
      const result=policy.assess({width,row,asOfMs,mode:state.mode,feedFresh,quality,evidence,constituents});
      const forming=feedFresh&&Array.isArray(half)?policy.forming({width,asOfMs,sourceRows:half}):null;
      const card=document.createElement('article');card.className='ui3-card'+
        (width===state.timeframe?' is-current':'')+(result.state==='stale'?' is-stale':'');
      card.dataset.width=String(width);card.dataset.state=result.state;
      card.dataset.endMs=result.endMs==null?'':String(result.endMs);
      card.dataset.trade=result.trade.value==null?'':String(result.trade.value);
      card.dataset.quote=result.quote.value==null?'':String(result.quote.value);
      const header=document.createElement('div');header.className='ui3-card-head';
      const name=document.createElement('b');name.textContent=width===.5?'30s':`${width}m`;
      const time=document.createElement('span');time.textContent=row&&result.state==='complete'?
        `${localTime(row.stampMs)}–${localTime(row.stampMs+duration)}`:result.state==='stale'?'STALE':'N/A';
      header.append(name,time);card.append(header);
      const measures=document.createElement('div');measures.className='ui3-measures';
      for(const [label,measure,format] of [
        ['Trade B−S %',result.trade,value=>`${signed(value,1)}%`],
        ['Best-quote OFI',result.quote,value=>signed(value,3)],
        ['Price Δ',result.price,value=>`${value>=0?'+':'−'}$${Math.abs(value).toFixed(2)}`]]){
        const box=document.createElement('div'),small=document.createElement('small'),value=document.createElement('b');
        small.textContent=label;value.textContent=display(measure,format);
        if(measure?.value>0)value.className='positive';else if(measure?.value<0)value.className='negative';
        box.title=measure?.reason||'';box.append(small,value);measures.append(box);
      }
      card.append(measures);
      const foot=document.createElement('div');foot.className='ui3-card-foot';
      const qualitySummary=result.trade.value==null?
        `Trade N/A · ${state.mode==='replay'?'raw audit: ':''}${result.trade.reason}`:
        result.quote.value==null?`Quote N/A · ${result.quote.reason}`:
        `${result.coverage==null?'Coverage N/A':result.coverage.toFixed(1)+'% classified / eligible lit'}`;
      foot.textContent=result.state==='stale'?result.reason:
        result.state!=='complete'?`${result.reason}${forming?' · FORMING '+localTime(forming.startMs)+'–'+localTime(forming.endMs)+' (hidden values)':''}`:
        `${qualitySummary}${forming?' · FORMING '+localTime(forming.startMs)+'–'+localTime(forming.endMs)+' (hidden values)':''}`;
      card.title=`${width===.5?'30 seconds':width+' minutes'} · ${result.state}. Trade: ${result.trade.reason}. Quote: ${result.quote.reason}. Price: ${result.price.reason}. ${foot.textContent}`;
      card.append(foot);host.append(card);
    }
  }
  function renderBehindCandle(){
    const rail=$('ui4-rail'),multi=window.TY_MULTI_PRESSURE,policy=window.TY_BEHIND_CANDLE;
    if(!window.TRADER_UI_V2||!rail||!multi||!policy||state.boardMode)return;
    const trader=state.mode==='replay'&&state.replayView==='trader';
    const host=trader?$('trader-snapshot'):document.querySelector('.chart-formation');
    if(host&&rail.parentElement!==host)host.append(rail);
    const selectedEnd=state.selectedStamp==null?null:state.selectedStamp+state.timeframe*60_000;
    const cursorEnd=state.mode==='replay'?replayCursor()?.stampMs+60_000:Date.now();
    const asOfMs=selectedEnd==null?cursorEnd:Math.min(selectedEnd,cursorEnd??selectedEnd);
    const sourceDate=state.mode==='replay'?state.demo?.date:state.live?.date;
    const source=state.mode==='replay'?state.demo?.bars?.[state.symbol]:state.live?.bars?.[state.symbol];
    const feed=state.live;
    const feedFresh=state.mode!=='live'||feed?.status==='connected'&&
      feed?.receivedAgeSeconds!=null&&feed.receivedAgeSeconds<=15&&
      feed?.eventLagSeconds!=null&&feed.eventLagSeconds<=15&&
      sourceDate===chicagoDate(Date.now());
    const rows=Number.isFinite(asOfMs)&&Array.isArray(source)?
      aggregate(source,1,asOfMs).filter(item=>!item.partial).slice(-3):[];
    const observations=rows.map(item=>{
      const quality=state.mode==='replay'?replayQualityItem(item.stampMs,1):null;
      const evidence=state.mode==='replay'?window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence(
        {...item,complete:true},quality,1):null;
      return multi.assess({width:1,row:item,asOfMs,mode:state.mode,feedFresh,
        quality,evidence,constituents:[item]});
    });
    const last=rows.at(-1),endMs=last?.stampMs+60_000;
    const completePremarket=visiblePremarketLevels()?.complete===true;
    const touched=last?traderLevels(endMs).filter(item=>
      (completePremarket||!item.name.startsWith('PM '))&&
      item.availableMs<=endMs&&last.l<=item.value&&last.h>=item.value)
      .sort((a,b)=>Math.abs(a.value-last.c)-Math.abs(b.value-last.c))[0]:null;
    const result=policy.evaluate({observations,mode:state.mode,feedFresh,asOfMs,
      forming:state.selectedStamp==null&&!!candlePartial()&&!candlePartial().awaiting,
      spreadCents:last?.medianSpreadCents,quoteAgeMs:last?.quoteAgeMs,
      level:touched?{...touched,close:last.c,high:last.h,low:last.l}:null});
    state.ui4Result=result;state.ui4Row=last||null;
    rail.dataset.state=result.state;
    $('ui4-asof').textContent=Number.isFinite(result.endMs)?
      `${clockTimeSeconds(result.endMs)} CT · completed 1m${result.forming?' · next forming':''}`:
      'No qualified completed minute';
    $('ui4-status').textContent=result.state==='complete'?
      `${state.mode==='replay'?'Historical event-time':'Live processed'} measurements · ${result.trade.value==null?'trade N/A: '+result.trade.reason:'trade quality qualified'} · ${result.quote.value==null?'quote N/A: '+result.quote.reason:'quote quality qualified'}`:
      result.reason;
    const put=(id,measurement,format)=>{const el=$(id);el.textContent=measurement?.value==null?'N/A':format(measurement.value);
      el.title=measurement?.reason||result.reason||'';el.classList.toggle('positive',measurement?.value>0);
      el.classList.toggle('negative',measurement?.value<0)};
    put('ui4-trade',result.trade,value=>`${signed(value,1)}%`);
    put('ui4-quote',result.quote,value=>signed(value,3));
    put('ui4-price',result.price,value=>`${signed(value,2)} USD`);
    put('ui4-spread',result.spread,value=>`${value.toFixed(1)}¢ median`);
    const comparison=(item,format)=>item?.value==null?item?.reason||'Comparison N/A':
      `${item.description} · Δ ${format(item.value)}`;
    $('ui4-trade-change').textContent=comparison(result.tradeChange,v=>`${signed(v,1)} pp`);
    $('ui4-quote-change').textContent=comparison(result.quoteChange,v=>signed(v,3));
    $('ui4-persistence').textContent=result.persistence?.value==null?
      result.persistence?.reason||'Persistence N/A':
      `${result.persistence.value}/3 same-side 1m · ${result.persistence.side}`;
    $('ui4-quote-age').textContent=result.quoteAge?.value==null?'Vendor quote age N/A':
      `Vendor quote age ${Math.round(result.quoteAge.value)} ms · not display latency`;
    $('ui4-conflict').textContent=result.state!=='complete'? 'Directional comparison masked':
      result.conflicts.length?result.conflicts.join(' · '):
      'No sign conflict among available trade, quote, and price measurements';
    $('ui4-level').textContent=result.state!=='complete'?'PM / ORB context masked':result.level?
      `${result.level.name} ${money(result.level.value)} touched by completed 1m range · close ${signed(result.level.closeDistance,2)} USD from level`:
      'No as-of available PM / ORB level touched by the completed 1m range';
  }
  function renderDecisionContext(){
    const panel=$('ui5-context'),policy=window.TY_CONTEXT;
    if(!window.TRADER_UI_V2||!panel||!policy||state.boardMode)return;
    const trader=state.mode==='replay'&&state.replayView==='trader';
    const host=trader?$('trader-snapshot'):document.querySelector('.chart-formation');
    if(host&&panel.parentElement!==host)host.append(panel);
    const pressure=state.ui4Result,row=state.ui4Row;
    const asOfMs=pressure?.asOfMs;
    const sourceDate=state.mode==='replay'?state.demo?.date:state.live?.date;
    const tape=state.mode==='replay'?state.demo?.bars:state.live?.bars;
    const completePremarket=visiblePremarketLevels()?.complete===true;
    const levels=row?traderLevels(row.stampMs+60_000).filter(item=>
      completePremarket||!item.name.startsWith('PM ')):[];
    const indexBars={};
    for(const symbol of ['SPY','QQQ','SMH'])indexBars[symbol]=Array.isArray(tape?.[symbol])?
      tape[symbol].find(item=>item.stampMs===row?.stampMs&&item.stampMs+60_000<=asOfMs):null;
    const ownBars=tape?.[state.symbol];
    const previousBar=Array.isArray(ownBars)?ownBars.find(item=>item.stampMs===row?.stampMs-60_000):null;
    const earlierBar=Array.isArray(ownBars)?ownBars.find(item=>item.stampMs===row?.stampMs-120_000):null;
    const result=policy.evaluate({asOfMs,price:row?.c,levelCandidates:levels,pressure,
      selectedBar:row,previousBar,earlierBar,indexBars,sourceDate,
      asOfDate:Number.isFinite(asOfMs)?chicagoDate(asOfMs):null,
      mode:state.mode,feedFresh:pressure?.state!=='stale',symbol:state.symbol});
    panel.dataset.state=result.state;
    $('ui5-asof').textContent=Number.isFinite(row?.stampMs)?
      `${clockTimeSeconds(row.stampMs+60_000)} CT · completed 1m`:'No completed 1m reference';
    const level=item=>item?`${item.name} ${money(item.value)}`:'N/A';
    $('ui5-nearest').textContent=result.state==='ready'?level(result.nearest):'N/A';
    $('ui5-bracket').textContent=result.state==='ready'?
      `↑ ${level(result.above)} · ↓ ${level(result.below)}`:'N/A';
    $('ui5-alignment').textContent=result.state==='ready'&&result.alignment?.value!=null?
      result.alignment.value:'N/A';
    $('ui5-alignment').title=result.alignment?.reason||result.reason||'';
    $('ui5-indices').textContent=result.state==='ready'?
      ['SPY','QQQ','SMH'].map(symbol=>`${symbol} ${result.context[symbol]?.value==null?
        'N/A':signed(result.context[symbol].value,1)+' bp'}`).join(' · '):'N/A';
    $('ui5-interaction').textContent=result.state==='ready'&&result.interaction?.value!=null?
      `Completed price · ${result.interaction.level.name} ${money(result.interaction.level.value)} · ${result.interaction.value}`:
      'Completed price interaction · N/A';
    $('ui5-interaction').title=result.interaction?.reason||result.reason||'';
    $('ui5-note').textContent=result.state==='stale'?result.reason:
      '1m excess return = selected price return − index price return; synchronized processed OHLC, basis points. SMH is SMH, not SOXX. No probability or entry signal.';
  }
  function renderFlow(){
    $('flow-interval-caption').textContent=`Completed ${intervalLabel()} candles; select a timestamp to inspect one`;
    const bars=tape(),raw=state.mode==='replay'?bars?.[state.symbol]?.filter(row=>row.stampMs<=replayCursor()?.stampMs):bars?.[state.symbol];
    const amd=current(),last=amd.at(-1),selected=state.selectedStamp!=null?amd.find(row=>row.stampMs===state.selectedStamp):null;
    const partial=candlePartial();
    const duration=state.timeframe*60000;
    $('pressure-heading').textContent=selected?
      `${intervalLabel()} candle pressure · Selected ${clockTime(selected.stampMs)}–${clockTime(selected.stampMs+duration)} CT`:
      `${intervalLabel()} candle pressure`;
    const displayStamp=selected?.stampMs??last?.stampMs??partial?.stampMs??null;
    const prior=amd.filter(row=>row.stampMs<=displayStamp);
    const rawPrior=raw?.filter(row=>row.stampMs<(selected?.stampMs??displayStamp??0)+duration)||[];
    const recent=displayStamp!=null?prior.filter(row=>row.stampMs>=displayStamp):[];
    const session=sessionWindow();
    const premarket=rawPrior.filter(row=>row.t>=session.startCt&&row.t<session.openCt);
    const market=rawPrior.filter(row=>row.t>=session.openCt&&row.t<session.endCt);
    const summarize=rows=>{
      if(!rows.length)return null;
      const buy=rows.reduce((n,row)=>n+(row.buy||0),0),sell=rows.reduce((n,row)=>n+(row.sell||0),0);
      const ofi=rows.map(row=>row.ofi).filter(Number.isFinite);
      return {first:rows[0],last:rows.at(-1),count:rows.length,buy,sell,delta:buy-sell,
        ofi:ofi.length?ofi.reduce((a,b)=>a+b,0)/ofi.length:null,
        price:rows.at(-1).c-rows[0].o};
    };
    const r=summarize(recent);
    $('compact-market-label').textContent=raw?.[0]?.t>session.openCt?
      `From ${raw[0].t.slice(0,5)} (partial)`:'From open';
    const lastRecorded=rawPrior.at(-1),endMinute=lastRecorded?Number(lastRecorded.t.slice(0,2))*60+Number(lastRecorded.t.slice(3,5)):-1;
    function updateBucket(prefix,rows,firstMinute,lastMinute){
      const x=summarize(rows),expected=Math.max(0,Math.min(endMinute,lastMinute)-firstMinute+1)*
        (state.timeframe===.5?2:1)-(state.timeframe===.5&&endMinute<lastMinute&&lastRecorded?.t.endsWith(':00')?1:0);
      $(prefix+'-buy').textContent=x?number(x.buy):'—';
      $(prefix+'-sell').textContent=x?number(x.sell):'—';
      $(prefix+'-net').textContent=x?signedShares(x.delta):'—';tone($(prefix+'-net'),x?.delta);
      const lit=rows.reduce((n,row)=>n+(row.litShares||0),0);
      const classified=x&&lit?`${((x.buy+x.sell)/lit*100).toFixed(1)}% classified coverage`:'no classified tape';
      $(prefix+'-coverage').textContent=expected?`${rows.length}/${expected} recorded ${state.timeframe===.5?'30-second':'1-minute'} source intervals · ${classified}`:'Session has not started';
    }
    updateBucket('premarket',premarket,360,509);
    updateBucket('market',market,510,899);
    const sessionFootprintEnd=selected?selected.stampMs+duration:
      state.mode==='replay'?replayCursor()?.stampMs+(state.timeframe===.5?30_000:60_000):
        minuteTape()?.at(-1)?.stampMs+60_000;
    renderSessionFootprint(sessionFootprintEnd,session);
    for(const [source,target] of [['premarket-net','compact-premarket'],['market-net','compact-market']]){
      $(target).textContent=$(source).textContent;
      $(target).classList.toggle('positive',$(source).classList.contains('positive'));
      $(target).classList.toggle('negative',$(source).classList.contains('negative'));
    }
    $('recent-time').textContent=r?`Last complete ${intervalLabel()} candle · ${r.first.t}–${clockTime(r.last.stampMs+duration)} CT`:`No complete ${intervalLabel()} candle`;
    $('recent-shares').textContent=r?`Buyer ${number(r.buy)}   Seller ${number(r.sell)}`:'Buyer —   Seller —';
    $('recent-delta').textContent=r?`Net ${signedShares(r.delta)}`:'Net —';tone($('recent-delta'),r?.delta);
    $('recent-ofi').textContent=signed(r?.ofi,3);tone($('recent-ofi'),r?.ofi);
    $('recent-price').textContent=r?`${signed(r.price,2)} USD`:'—';tone($('recent-price'),r?.price);
    $('orb-context').textContent=displayStamp!=null?orbContext(displayStamp+duration,selected?.c??last?.c):'5m ORB · waiting for tape';
    renderCompactPremarketLevels();
    $('quick-orb').textContent=$('orb-context').textContent;
    $('flow-latest').hidden=state.selectedStamp==null;
    const slotCount=window.innerWidth<=980?4:8;
    const gridPartial=selected?null:partial;
    const grid=$('pressure-grid');grid.replaceChildren();
    grid.style.gridTemplateColumns=`138px repeat(${slotCount},minmax(0,1fr))`;
    grid.setAttribute('aria-label',gridPartial?`Latest ${slotCount-1} completed ${intervalLabel()} candles and current forming candle`:
      `Last ${slotCount} completed ${intervalLabel()} candles`);
    const note=$('research-note');note.hidden=false;
    const pressureCaption=document.querySelector('.pressure-title .flow-caption');
    const latestEnd=displayStamp==null?null:displayStamp+duration;
    pressureCaption.textContent=gridPartial?.awaiting?
      `${clockTime(gridPartial.stampMs)} ${state.mode==='replay'?'REPLAY':'LIVE'} · waiting for first completed 30-second bucket`:
      gridPartial?
      `${clockTime(gridPartial.stampMs)} ${state.mode==='replay'?'REPLAY':'LIVE'} through ${clockTimeSeconds(gridPartial.throughMs)} CT · forming until ${clockTime(gridPartial.stampMs+duration)}`:
      state.mode==='live'&&state.selectedStamp==null&&latestEnd!=null&&Date.now()>=latestEnd&&Date.now()<latestEnd+duration
      ?`Last complete ${clockTime(displayStamp)}–${clockTime(latestEnd)} CT · ${clockTime(latestEnd)}–${clockTime(latestEnd+duration)} forming`
      :`Labels show candle start; each closes ${state.timeframe===.5?'30 seconds':state.timeframe+' min'} later · gray means missing data`;
    if(displayStamp==null){grid.textContent=`Waiting for a complete ${state.symbol} interval`;
      paintLevelReaction(null,null,duration);return}
    const byMinute=new Map(prior.map(row=>[row.stampMs,row]));
    if(gridPartial)byMinute.set(gridPartial.stampMs,gridPartial);
    const gridEndStamp=gridPartial?.stampMs??displayStamp;
    const slots=Array.from({length:slotCount},(_,i)=>gridEndStamp-(slotCount-1-i)*duration);
    const add=(kind,value,extra='')=>{const el=document.createElement(kind);el.className=extra;el.textContent=value;grid.append(el);return el};
    add('span','CT','pressure-label');
    for(const stamp of slots){
      const bar=byMinute.get(stamp),interval=`${clockTime(stamp)}–${clockTime(stamp+duration)} CT`,button=add('button',state.selectedStamp===stamp?`${clockTime(stamp)} SELECTED`:bar?.partial?`${clockTime(stamp)} ${state.mode==='replay'?'REPLAY':'LIVE'}`:clockTime(stamp),'pressure-time'+(state.selectedStamp===stamp?' selected':'')+(bar?.partial?' provisional':''));
      button.type='button';button.disabled=!bar||bar.partial;button.title=bar?.awaiting?`${interval} · waiting for first 30-second bucket`:bar?.partial?`${interval} · provisional through ${clockTimeSeconds(bar.throughMs)}`:interval;
      button.setAttribute('aria-label',bar?.awaiting?`${interval} forming; waiting for first 30-second bucket`:bar?.partial?`${interval} forming through ${clockTimeSeconds(bar.throughMs)}`:bar?`Inspect ${interval}`:`No ${state.symbol} data for ${interval}`);
      if(bar&&!bar.partial)button.onclick=()=>{state.selectedStamp=stamp;render()};
    }
    const rows=[
      ['Trade Δ',row=>row.delta,flowShares],
      ['Aggression',row=>row.imbalancePct,v=>`${signed(v,1)}%`],
      ['Quote OFI',row=>row.ofi,v=>signed(v,3)],
      ['Price change',(row,stamp)=>{const index=prior.findIndex(x=>x.stampMs===stamp);const previous=prior[index-1];return row.c-(previous?.stampMs===stamp-state.timeframe*60000?previous.c:row.o)},v=>`${v>=0?'+':'−'}$${Math.abs(v).toFixed(2)}`],
    ];
    for(const [label,metric,format] of rows){
      add('span',label,'pressure-label');
      for(const stamp of slots){
        const bar=byMinute.get(stamp),value=bar&&!bar.awaiting?metric(bar,stamp):null;
        const missingText=state.mode==='replay'&&REPLAY_EVIDENCE_V1?
          !bar?'Gap':bar.awaiting?'Forming':'N/A':'—';
        const cell=add('span',value==null?missingText:`${bar?.partial&&label==='Quote OFI'?'≈':''}${format(value)}`,'pressure-cell'+(value>0?' positive':value<0?' negative':'')+(state.selectedStamp===stamp?' selected':'')+(bar?.partial?' provisional':''));
        const deltaEvidence=state.mode==='replay'&&REPLAY_EVIDENCE_V1&&bar&&
          (label==='Trade Δ'||label==='Aggression')?
          window.TRADEYODHA_REPLAY_CHART.replayDeltaEvidence(
            {...bar,complete:!bar.partial},replayQualityItem(stamp),state.timeframe):null;
        if(deltaEvidence&&deltaEvidence.kind!=='valid'){
          cell.classList.remove('positive','negative');cell.classList.add('unreliable');
        }
        cell.title=`${clockTime(stamp)} CT · ${label}: ${value==null?
          !bar?'No archived candle for interval':bar.awaiting?'Incomplete candle':
          label==='Quote OFI'?'Unavailable: no valid quote measurement':'Measurement unavailable':format(value)}${bar?.partial?' · provisional; quote OFI approximated from completed 30-second buckets':''}`;
        if(deltaEvidence)cell.title+=` · Delta evidence: ${deltaEvidence.label}`;
      }
    }
    note.textContent=state.symbol!=='AMD'?`${state.symbol} raw trade and quote pressure is available. Additional research rows are AMD-only.`:state.mode==='live'?
      'Live raw order-flow research is not yet computed; gray rows are unavailable.':state.micro?
      `${state.micro.source} · complete raw 30-second buckets only · lit quote-signed trade estimates. Sweep follow-through is included only when observed by that candle's close.`:
      'Raw order-flow rows require a checksum-verified paired trade/quote archive for this date. Missing rows stay gray.';
    $('quick-research').textContent=state.symbol!=='AMD'?`${state.symbol} raw trade and quote pressure is available.`:state.mode==='live'?
      'Live research rows are not computed; gray means unavailable.':
      state.micro?'Replay research rows verified from paired raw tape.':'Raw research rows unavailable for this replay.';
    const research=state.mode==='replay'&&state.micro?
      slots.map(stamp=>byMinute.has(stamp)?researchWindow(stamp,duration,stamp+duration):null):null;
    {
      const shortShares=n=>n>=1000?`${(n/1000).toFixed(1)}K`:number(n);
      const cents=n=>n==null?'—':`${n>0?'+':n<0?'−':''}${Math.abs(n).toFixed(0)}¢`;
      const researchRows=[
        ['Sweep candidates',x=>({text:`S${x.sellSweeps} / B${x.buySweeps}`,bias:x.buySweeps-x.sellSweeps,
          tip:`Cross-venue same-millisecond groups ≥1,000 shares; seller ${number(x.sellSweepShares)} shares, buyer ${number(x.buySweepShares)} shares. Candidate groups, not confirmed parent orders.`})],
        ['Depth OFI',x=>({text:signed(x.depthOfi,3),bias:x.depthOfi,
          tip:'Best-quote order-flow imbalance scaled by displayed depth; positive favors bid-side pressure.'})],
        ['Bid queue net',x=>({text:flowShares(x.bidReplenishment-x.bidDepletion),bias:x.bidReplenishment-x.bidDepletion,
          tip:`Displayed bid replenishment ${number(x.bidReplenishment)} minus depletion ${number(x.bidDepletion)} shares; cancellations and executions are not separable.`})],
        ['Seller run',x=>({text:shortShares(x.sellRun),bias:null,
          tip:`Largest consecutive classified seller-share run ${number(x.sellRun)}; peak seller shares in 5 seconds ${number(x.peakSell5s)}.`})],
        ['Sell impact / 1K',x=>({text:x.impact1k==null?'—':cents(x.impact1k),bias:x.impact1k,
          tip:x.impact1k==null?'Requires ≥1,000 net seller shares, ≥10% seller imbalance, and midpoint response':`Midpoint ${cents(x.midCents)} on ${number(x.sell)} seller versus ${number(x.buy)} buyer shares; cents per 1,000 net seller shares. Descriptive price response, not confirmed absorption.`})],
        ['Sweep 10s',x=>({text:x.continuation==null?'—':cents(x.continuation),bias:null,
          tip:`${x.matured}/${x.sellSweeps+x.buySweeps} candidates have an observed quote at least 10 seconds later by this candle's close. Positive means continuation in the candidate's direction.`})]
      ];
      let hiddenResearchRows=0;
      for(const [label,metric] of researchRows){
        const values=research?.map(item=>item?metric(item):null)??[];
        if(!values.some(value=>value?.text!=null&&value.text!=='—')){
          hiddenResearchRows++;
          continue;
        }
        add('span',label,'pressure-label research-label');
        for(let i=0;i<slots.length;i++){
          const value=values[i];
          const cell=add('span',value?.text??(state.mode==='replay'&&REPLAY_EVIDENCE_V1?'N/A':'—'),'pressure-cell research-cell'+
            (value?.bias>0?' positive':value?.bias<0?' negative':'')+
            (state.selectedStamp===slots[i]?' selected':''));
          cell.title=`${clockTime(slots[i])}–${clockTime(slots[i]+duration)} CT · ${label}: ${value?.tip||'No complete raw tape for this interval.'}`;
        }
      }
      let availability=$('pressure-availability');
      if(!availability){
        availability=document.createElement('span');availability.id='pressure-availability';
        document.querySelector('.pressure-legend').append(availability);
      }
      availability.hidden=hiddenResearchRows===0;
      availability.textContent=hiddenResearchRows?`${hiddenResearchRows} unavailable research rows hidden`:'';
    }
    document.querySelector('.footprint-table-wrap').hidden=state.mode!=='replay';
    renderFootprint(selected??last,duration);
  }
  function selectedAmdMinute(){
    const source=minuteTape();
    const day=state.mode==='replay'?state.demo?.date:state.live?.date;
    const view=current();
    const chosen=state.selectedStamp;
    const interval=chosen==null?view.at(-1):view.find(item=>item.stampMs===chosen);
    const end=(interval?.stampMs||0)+state.timeframe*60000;
    const row=source?.findLast(item=>item.stampMs+60000<=end);
    return {day,row};
  }
  async function askOnDemand(){
    const {day,row}=selectedAmdMinute();
    const note=$('trader-note').value.trim();
    const dialog=$('ask-dialog');
    dialog.querySelector('h2').textContent='AMD on-demand analyst';
    $('ask-context').textContent='';
    $('ask-status').textContent=row&&day?`${day} · ${row.t} CT · last completed 1-minute analyst window`:'No completed AMD minute selected';
    $('ask-answer').textContent='Preparing the selected tape snapshot…';
    if(!dialog.open)dialog.showModal();
    const session=sessionWindow();
    if(!row||!day||row.t<session.startCt||row.t>=referenceEndCt()){
      $('ask-answer').textContent=`Select a completed minute from ${session.startCt} to before ${referenceEndCt()} CT in live tape or replay.`;
      return;
    }
    $('ask-ai').disabled=true;
    try{
      const base=apiBase();
      const response=await fetch(base+'/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({date:day,width:state.timeframe===.5?1:state.timeframe,
          asofStampMs:row.stampMs,traderNote:note}),
        signal:AbortSignal.timeout(50000)});
      const report=await response.json();
      if(!response.ok)throw new Error(report.error||`HTTP ${response.status}`);
      $('ask-status').textContent=`${report.date} · ${report.asOfCt} CT · ${report.width}-minute window · ${report.cached?'saved response':report.model}`;
      $('ask-answer').textContent=report.text;
      $('ask-context').textContent=JSON.stringify({traderNote:report.traderNote||null,...report.context},null,2);
    }catch(error){$('ask-answer').textContent=`Analyst unavailable: ${error.message}`}
    finally{$('ask-ai').disabled=false}
  }
  let macroLastKey='', macroPending=false;
  const chicagoDayClock=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',
    year:'numeric',month:'2-digit',day:'2-digit'});
  const chicagoDate=stamp=>{
    const parts=chicagoDayClock.formatToParts(stamp);
    const get=type=>parts.find(part=>part.type===type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  function macroRequestPoint(){
    if(state.mode==='replay'){
      const row=state.timeframe===.5?selectedAmdMinute().row:state.replayTimeline?.[state.index];
      return row?{day:state.demo.date,stamp:row.stampMs,key:`replay-${state.demo.date}-${Math.floor(row.stampMs/900000)}`}:null;
    }
    const now=Date.now(),day=chicagoDate(now),stamp=Math.floor(now/60000)*60000-60000;
    const ct=clockTime(stamp).slice(0,5);
    if(chicagoDate(stamp)!==day||ct<sessionWindow().startCt)return null;
    const bounded=lastReferenceMinute(stamp);
    return {day,stamp:bounded,key:`live-${day}-${Math.floor(bounded/900000)}`};
  }
  let levelsLastKey='',levelsPendingKey='',levelsRequestId=0;
  function levelRow(box,label,value,detail=''){
    const row=document.createElement('div');row.className='level-row';
    const left=document.createElement('span');left.textContent=label;
    if(detail){const note=document.createElement('small');note.textContent=detail;left.append(document.createElement('br'),note)}
    const right=document.createElement('b');right.textContent=value;
    row.append(left,right);box.append(row);
  }
  function renderStructureLevels(report){
    const pm=$('pm-levels'),long=$('long-levels');pm.replaceChildren();long.replaceChildren();
    state.premarketLevels=report.premarket?.available?{...report.premarket,date:report.asOfCt?.slice(0,10),
      asOfStampMs:Date.parse(report.asOfCt),knownStampMs:premarketKnownStampMs(
        report.asOfCt?.slice(0,10),report.asOfCt,report.premarket.complete)}:null;
    renderCompactPremarketLevels();
    footprintPaintKey='';
    $('overview-price').textContent=report.available?money(report.referencePrice):'—';
    $('overview-asof').textContent=report.available?`Completed aggregate reference · through ${clockTime(Date.parse(report.asOfCt)-60_000)} CT · ${report.asOfCt.slice(0,10)}`:(report.reason||'No completed aggregate reference');
    if(!report.available){levelRow(long,'Structure unavailable',report.reason||'—');return}
    const pre=report.premarket;
    if(pre?.available){
      $('overview-mid').textContent=money(pre.midpoint);
      $('quick-pm-high').textContent=money(pre.high);
      $('quick-pm-mid').textContent=money(pre.midpoint);
      $('quick-pm-low').textContent=money(pre.low);
      levelRow(pm,'High',money(pre.high));levelRow(pm,'Midpoint · 50%',money(pre.midpoint));levelRow(pm,'Low',money(pre.low));
      levelRow(pm,pre.complete?'Range fixed':'Range developing',`${pre.firstCt}–${pre.lastCt} CT`,`${pre.barCount} observed bars`);
    }else levelRow(pm,'Premarket unavailable',pre?.reason||'No 03:00–08:25 data');
    const points=report.levels.filter(item=>item.timeframes.some(frame=>frame==='daily'||frame==='four_hour')).slice(0,5);
    const below=report.levels.filter(item=>item.side==='support'&&item.price<=report.referencePrice).sort((a,b)=>b.price-a.price)[0];
    const above=report.levels.filter(item=>item.side==='resistance'&&item.price>=report.referencePrice).sort((a,b)=>a.price-b.price)[0];
    $('overview-support').textContent=below?money(below.price):'—';
    $('overview-resistance').textContent=above?money(above.price):'—';
    for(const item of points){
      const kind=item.kinds.map(value=>value.replaceAll('_',' ')).join(', ');
      levelRow(long,`${item.timeframes.join(' + ')} · ${item.side}`,money(item.price),kind);
    }
    for(const zone of report.dailyLowZones.slice(0,2))
      levelRow(long,`Daily-low band · ${zone.touches} touches`,`${money(zone.low)}–${money(zone.high)}`);
    if(!points.length&&!report.dailyLowZones.length)levelRow(long,'No nearby completed-candle levels','—');
    $('levels-note').textContent=`Structure: completed daily through ${report.lastCompletedDailyDate}; hourly/4h only through selected minute. Levels are candidates, not verified orders.`;
    if($('footprint-panel').open)renderFlow();
  }
  function renderPremarketReport(report){
    const pm=$('pm-levels');pm.replaceChildren();
    const pre=report.premarket;
    state.premarketLevels=pre?.available?{...pre,date:report.sessionDate,
      asOfStampMs:Date.parse(report.asOfCt),knownStampMs:premarketKnownStampMs(
        report.sessionDate,report.asOfCt,pre.complete)}:null;
    state.premarketGap=report.premarketGap?.available?
      {...report.premarketGap,date:report.sessionDate}:null;
    renderCompactPremarketLevels();
    footprintPaintKey='';
    if(!pre?.available){levelRow(pm,'Premarket unavailable','—',pre?.reason||'No completed bars');return}
    $('overview-mid').textContent=money(pre.midpoint);
    $('quick-pm-high').textContent=money(pre.high);
    $('quick-pm-mid').textContent=money(pre.midpoint);
    $('quick-pm-low').textContent=money(pre.low);
    levelRow(pm,'High',money(pre.high));levelRow(pm,'Midpoint · 50%',money(pre.midpoint));
    levelRow(pm,'Low',money(pre.low));
    levelRow(pm,pre.complete?'Range fixed':'Range developing',`${pre.firstCt}–${pre.lastCt} CT`,
      `${pre.barCount} observed bars`);
    $('levels-note').textContent='Premarket levels use completed 03:00–08:25 CT minute aggregates.';
    if($('footprint-panel').open)renderFlow();
  }
  function nearbyOi(report,side,spot){
    if(!Number.isFinite(spot)||spot<=0)return null;
    const rows=report.oiByStrike?.[side]||report[`${side}OiWalls`]||[];
    const nearby=rows.filter(item=>Number.isFinite(item.strike)&&item.openInterest>0&&
      (side==='call'?item.strike>spot&&item.strike<=spot*1.03:
        item.strike<spot&&item.strike>=spot*.97));
    nearby.sort((a,b)=>b.openInterest-a.openInterest||Math.abs(a.strike-spot)-Math.abs(b.strike-spot));
    return nearby[0]||null;
  }
  function renderOptionsLevels(report){
    const pin=$('pin-levels'),walls=$('walls-levels');pin.replaceChildren();walls.replaceChildren();
    state.optionsWallStatus=report.available?'ready':report.firstEligibleStampMs?'waiting':'unavailable';
    if(!report.available){
      $('overview-pin').textContent='Unavailable';
      $('compact-options-status').textContent=report.firstEligibleStampMs?'Nearby OI · captured; next minute':'Nearby OI · unavailable';
      for(const id of ['compact-call-wall','compact-put-wall']){
        $(id).textContent='—';
        $(id).parentElement.title='No options reference for this selected candle';
      }
      levelRow(pin,'Pin proxy unavailable','—',report.reason||'No eligible options snapshot');return;
    }
    const spot=report.referenceSpot;
    const captured=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(report.capturedAtUtc));
    const oiSource=report.sourceProvider==='Databento OPRA.PILLAR'?
      `OPRA start-of-day · received ${captured} CT`:`snapshot ${captured} CT (delayed)`;
    $('compact-options-status').textContent=`Session-fixed OI · ±3% of ${money(spot)} reference · ${oiSource}`;
    for(const [side,id] of [['call','compact-call-wall'],['put','compact-put-wall']]){
      const item=nearbyOi(report,side,spot);$(id).textContent=item?money(item.strike):'—';
      $(id).parentElement.title=item?`${number(item.openInterest)} open-interest contracts · strongest ${side==='call'?'above':'below'} ${money(spot)} within 3% · ${report.scope?.firstExpiration}–${report.scope?.lastExpiration} expirations · ${oiSource}`:'No qualifying nearby option strike';
    }
    const candidate=report.grossGammaPinProxy;
    $('overview-pin').textContent=candidate?money(candidate.strike):'Unavailable';
    if(candidate)levelRow(pin,'Gross-gamma peak · pin proxy',money(candidate.strike),
      `$${(candidate.grossGammaDollarPer1Pct/1e6).toFixed(1)}M gross / 1% move`);
    else levelRow(pin,'Pin proxy unavailable','—','Insufficient gamma observations');
    for(const [side,label] of [['call','Call OI above price'],['put','Put OI below price']]){
      const item=nearbyOi(report,side,spot);
      if(item)levelRow(walls,label,money(item.strike),`${number(item.openInterest)} OI · within 3% of ${money(spot)}`);
    }
    if(!walls.childElementCount)levelRow(walls,'Nearby OI unavailable','—');
    $('levels-note').textContent+=` Options reference: ${oiSource}; OI updates daily. Pin is an unsigned gamma concentration proxy, not a confirmed dealer pin or signed GEX.`;
  }
  async function refreshLevelsCard(force=false){
    const symbol=state.symbol;
    const selected=selectedAmdMinute();
    const day=selected.day;
    const source=state.mode==='replay'?state.demo?.bars?.[symbol]:state.live?.bars?.[symbol];
    const cursorEnd=state.timeframe===.5&&state.mode==='replay'?replayCursor()?.stampMs+30_000:null;
    const cutoff=state.mode==='replay'?(cursorEnd!=null?cursorEnd-60_000:state.replayTimeline?.[state.index]?.stampMs):source?.at(-1)?.stampMs;
    const start=sessionWindow().startCt,end=referenceEndCt();
    const liveLatest=state.mode==='live'?source?.findLast(item=>item.t>=start&&item.t<end):null;
    const row=liveLatest||(selected.row?.t>=start&&selected.row?.t<end?selected.row:
      source?.findLast(item=>item.stampMs<=cutoff&&item.t>=start&&item.t<end));
    if(!day||!row){
      $('levels-asof').textContent=state.mode==='replay'&&!state.demo?
        `Loading ${symbol} replay reference levels…`:
        `Waiting for a completed ${start}–${end} CT reference minute`;return;
    }
    const key=`${symbol}-${day}-${row.stampMs}`;
    if(!force&&(levelsPendingKey===key||levelsLastKey===key))return;
    const requestId=++levelsRequestId;levelsPendingKey=key;$('levels-refresh').disabled=true;
    $('levels-asof').textContent=`${symbol} · ${day} ${row.t} CT · loading sources…`;
    const base=apiBase();
    const query=new URLSearchParams({symbol,date:day,asofStampMs:String(row.stampMs)});
    const get=async (path,timeout=30000)=>{const response=await fetch(`${base}${path}?${query}`,{signal:AbortSignal.timeout(timeout)});
      const report=await response.json();if(!response.ok)throw new Error(report.error||`HTTP ${response.status}`);return report};
    try{
      const premarket=get('/api/premarket-levels').then(report=>{
        if(requestId===levelsRequestId){renderPremarketReport(report);renderReplayChart()}
      }).catch(error=>{
        if(requestId===levelsRequestId){$('pm-levels').textContent=`Premarket unavailable: ${error.message}`;
          $('compact-pm-status').textContent='PM levels · unavailable'}
      });
      const cachedOptions=state.chartOptions;
      const cachedReport=cachedOptions?.symbol===symbol&&cachedOptions.date===day?
        cachedOptions.report:null;
      if(cachedReport?.available&&cachedReport.capturedStampMs>row.stampMs+60_000){
        renderOptionsLevels({available:false,reason:'Snapshot was captured after this replay candle'});
      }
      const options=(cachedReport?.available&&cachedReport.capturedStampMs<=row.stampMs+60_000?
        Promise.resolve(cachedReport):get('/api/options-walls',120000)).then(report=>{
        if(requestId===levelsRequestId){
          renderOptionsLevels(report);
          state.chartOptions={symbol,date:day,report};
          renderVolumePanel();
          renderReplayChart();
        }
      }).catch(error=>{
        if(requestId===levelsRequestId){
          renderOptionsLevels({available:false,reason:error.message});
          state.chartOptions=null;renderVolumePanel();renderReplayChart();
        }
      });
      await Promise.all([premarket,options]);
      if(requestId!==levelsRequestId)return;
      $('levels-asof').textContent=`${symbol} · as of ${row.t} CT · ${day}`;
      levelsLastKey=key;
    }finally{if(requestId===levelsRequestId){levelsPendingKey='';$('levels-refresh').disabled=false}}
  }
  function renderMacroReport(report){
    $('macro-asof').textContent=`${report.date} · as of ${report.asOfCt} CT · market-wide`;
    $('quick-macro').textContent=`Market-wide context · as of ${report.asOfCt} CT · ${report.scheduledEvents?.events?.length||0} scheduled event${report.scheduledEvents?.events?.length===1?'':'s'} in the verified catalog`;
    const eventBox=$('macro-events');eventBox.replaceChildren();
    const events=report.scheduledEvents?.events||[];
    if(!events.length){const empty=document.createElement('div');empty.className='side-item';empty.textContent='No scheduled event in the verified catalog';eventBox.append(empty)}
    for(const item of events.slice(0,5)){
      const el=document.createElement('div');el.className='side-item';el.textContent=`${item.scheduledCt} CT · ${item.name}`;
      const detail=document.createElement('small');detail.textContent=item.status.replaceAll('_',' ');el.append(detail);eventBox.append(el);
    }
    const proxyBox=$('macro-proxies');proxyBox.replaceChildren();
    for(const symbol of ['SPY','QQQ','TLT','IEF','UUP']){
      const item=report.proxies?.[symbol],el=document.createElement('div');el.className='macro-proxy';
      const name=document.createElement('small');name.textContent=symbol;const value=document.createElement('b');
      value.textContent=item?.available&&Number.isFinite(item.since06Pct)?`${signed(item.since06Pct,2)}%`:'—';
      if(item?.available)tone(value,item.since06Pct);
      const asof=document.createElement('small');asof.textContent=item?.available?`as of ${item.asOfCt} CT`:'No as-of price';
      el.append(name,value,asof);el.title=item?.available?`Price from ${item.baselineCt} to ${item.asOfCt} CT · not yield data`:'No as-of price';proxyBox.append(el);
    }
    const newsBox=$('macro-headlines');newsBox.replaceChildren();
    const eligible=(report.news?.marketWide?.latest||[]).filter(item=>/\b(Fed|FOMC|Treasury|bond|yield|inflation|CPI|PPI|jobs|employment|GDP|economy|tariff|interest rate|dollar)\b/i.test(item.title)||/^Stock Market News for/i.test(item.title)).slice(0,3);
    if(!eligible.length){const empty=document.createElement('div');empty.className='side-item';empty.textContent='No market-wide headline identified in the available feed';newsBox.append(empty)}
    for(const item of eligible){
      const el=document.createElement('div');el.className='side-item';const link=document.createElement('a');link.textContent=item.title;link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';
      const detail=document.createElement('small');detail.textContent=`${item.publisher||'Source unknown'} · published ${item.publishedUtc.slice(11,16)} UTC · 60m availability lag`;
      el.append(link,detail);newsBox.append(el);
    }
    const gaps=Object.entries(report.sourceStatus||{}).filter(([_key,value])=>value!=='available');
    $('macro-status').textContent=`ETF prices, not bond yields · news delayed 60m${gaps.length?` · unavailable: ${gaps.map(([key])=>key).join(', ')}`:''}`;
  }
  async function showMacroContext(force=false){
    const point=macroRequestPoint();
    if(!point){$('macro-asof').textContent='Market context starts at 06:00 CT';return}
    if(macroPending||(!force&&point.key===macroLastKey))return;
    macroPending=true;$('macro-context').disabled=true;$('macro-asof').textContent='Updating market-wide context…';
    try{
      const base=apiBase();
      const query=new URLSearchParams({date:point.day,asofStampMs:String(point.stamp)});
      const response=await fetch(`${base}/api/macro-context?${query}`,{signal:AbortSignal.timeout(30000)});
      const report=await response.json();
      if(!response.ok)throw new Error(report.error||`HTTP ${response.status}`);
      renderMacroReport(report);macroLastKey=point.key;
    }catch(error){$('macro-asof').textContent=`Macro context unavailable: ${error.message}`;$('macro-status').textContent='Refresh to retry'}
    finally{macroPending=false;$('macro-context').disabled=false}
  }
  $('ask-ai').onclick=askOnDemand;$('macro-context').onclick=()=>showMacroContext(true);$('levels-refresh').onclick=()=>refreshLevelsCard(true);$('ask-close').onclick=()=>$('ask-dialog').close();
  updateClock();
  renderWatchlist();
  setInterval(updateClock,1000);
  const libraryReady=loadLibrary();
  const appReady=loadServerWatchlist().catch(error=>watchError(`Watchlist unavailable: ${error.message}`))
    .finally(async()=>{
      await libraryReady;
      try{await loadSymbolHistory(state.symbol)}
      catch(error){status(`${state.symbol} history unavailable: ${error.message}`,'warn')}
    });
  let replayIntentVersion=0;
  async function enterReplay(){try{
    const intent=++replayIntentVersion,symbol=state.symbol;
    await loadSymbolHistory(symbol,true);
    if(intent!==replayIntentVersion||state.symbol!==symbol)return;
    const savedDate=tabValue(REPLAY_DATE_KEY);
    const requestedDate=state.replayDates.includes(savedDate)?savedDate:state.replayDates.at(-1);
    if(state.boardMode){
      const latest=state.symbolHistory[state.symbol]?.dates.at(-1);
      await Promise.all(state.watchlist.filter(symbol=>symbol!==state.symbol&&
        (!state.symbolHistory[symbol]||state.symbolHistory[symbol].dates.at(-1)<latest))
        .map(symbol=>loadSymbolHistory(symbol,true).catch(()=>{})));
    }
    await loadReplay(requestedDate||state.replayDates.at(-1));
  }
    catch(error){status(`Could not load replay: ${error.message}`,'bad');throw error}}
  function setModeMenu(open){
    $('mode-switch-menu').hidden=!open;
    $('mode-switch').setAttribute('aria-expanded',String(open));
  }
  $('mode-switch').onclick=()=>setModeMenu($('mode-switch-menu').hidden);
  $('mode-switch').onkeydown=event=>{
    if(event.key==='Escape'){
      event.preventDefault();setModeMenu(false);
    }else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();setModeMenu(true);
      $(event.key==='ArrowDown'?'mode-live':'mode-replay').focus();
    }
  };
  $('mode-switch-menu').onkeydown=event=>{
    if(event.key==='Escape'){
      event.preventDefault();setModeMenu(false);$('mode-switch').focus();
    }else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      $(event.target.id==='mode-live'?'mode-replay':'mode-live').focus();
    }
  };
  document.addEventListener('pointerdown',event=>{
    if(!event.target.closest('.mode-switch-wrap'))setModeMenu(false);
  });
  $('mode-live').onclick=()=>{
    setModeMenu(false);
    if(state.mode==='live')return;
    replayIntentVersion++;liveMode();
  };
  $('mode-replay').onclick=async()=>{
    setModeMenu(false);
    if(state.mode==='replay')return;
    const switcher=$('mode-switch');switcher.disabled=true;
    try{await appReady;await enterReplay()}
    catch(error){status(`Could not open replay: ${error.message}`,'bad');setModePanels()}
    finally{switcher.disabled=false}
  };
  $('go-live').onclick=liveMode;
  $('enter-live').onclick=()=>{
    replayIntentVersion++;
    $('mode-gate').hidden=true;$('dashboard').hidden=false;
    liveMode();
  };
  $('enter-replay').onclick=async()=>{
    const button=$('enter-replay');button.disabled=true;
    $('mode-gate-status').textContent='Loading verified replay…';
    try{
      await appReady;
      await enterReplay();
      if(state.mode!=='replay')throw new Error('No archived session is ready');
      $('mode-gate').hidden=true;$('dashboard').hidden=false;
    }catch(error){$('mode-gate-status').textContent=`Replay unavailable: ${error.message}`}
    finally{button.disabled=false}
  };
  $('replay-date').onchange=async event=>{
    replayIntentVersion++;
    try{await loadReplay(event.target.value)}
    catch(error){status(`Could not load replay: ${error.message}`,'bad')}
  };
  async function selectTimeframe(minutes){
    if(![.5,1,2,5,15].includes(minutes))return;
    if(state.mode==='replay'&&!state.demo)return;
    if(minutes===.5&&state.mode==='replay'){
      const symbol=state.symbol,date=state.demo.date,requestVersion=replayLoadVersion;
      const previousEnd=replayCursor()?.stampMs+60_000;
      try{
        if(state.half?.date!==date)await loadHalf(date);
      }catch(error){status(`30-second replay unavailable: ${error.message}`,'warn');return}
      if(state.symbol!==symbol||state.demo?.date!==date||
         replayLoadVersion!==requestVersion||state.mode!=='replay')return;
      state.halfIndex=Math.max(0,(state.half?.bars?.[state.symbol]||[])
        .findLastIndex(row=>row.stampMs+30_000<=previousEnd));
    }
    const previousTimeframe=state.timeframe;
    if(previousTimeframe!==minutes){cancelZoneRequest();state.zoneResult=null}
    if(previousTimeframe!==minutes&&state.zone){
      const duration=minutes*60_000,prior=state.zone;
      const startMs=Math.floor(prior.startMs/duration)*duration;
      const endMs=Math.min(Math.ceil(prior.endMs/duration)*duration,
        Math.floor(state.zoneCutoffMs/duration)*duration);
      const day=state.mode==='replay'?state.demo?.date:state.live?.date;
      const half=state.half?.date===day?state.half?.bars?.[state.symbol]:null;
      const minute=(state.mode==='replay'?state.demo:state.live)?.bars?.[state.symbol];
      const selected=endMs>startMs?window.TRADEYODHA_REPLAY_CHART.candlesWithFallback(
        half,minute,minutes,endMs).filter(row=>row.complete&&row.stampMs>=startMs&&
          row.stampMs+duration<=endMs):[];
      state.zone=selected.length?{startMs:selected[0].stampMs,
        endMs:selected.at(-1).stampMs+duration,
        lowCents:Math.floor(Math.min(...selected.map(row=>row.l))*100+1e-8),
        highCents:Math.ceil(Math.max(...selected.map(row=>row.h))*100-1e-8)}:null;
    }
    state.timeframe=minutes;state.selectedStamp=null;
    for(const value of [.5,1,2,5,15])$('candle-'+(value===.5?'30':value))
      .classList.toggle('active',value===minutes);
    render();
    if(previousTimeframe!==minutes&&state.zone&&state.zone.endMs<=state.zoneCutoffMs){
      const day=state.mode==='replay'?state.demo?.date:state.live?.date;
      if(day)void inspectZone(state.zone,day,state.zoneCutoffMs);
    }
  }
  $('candle-30').onclick=()=>selectTimeframe(.5);
  for(const minutes of [1,2,5,15])$('candle-'+minutes).onclick=()=>selectTimeframe(minutes);
  $('view-watchlist').onclick=()=>setBoardMode(true);
  $('view-detail').onclick=()=>setBoardMode(false);
  $('flow-latest').onclick=()=>{state.selectedStamp=null;render()};
  $('footprint-panel').addEventListener('toggle',()=>{if($('footprint-panel').open)renderFlow()});
  $('footprint-band').onchange=()=>{footprintPaintKey='';renderFlow()};
  $('scrub').oninput=e=>{state.selectedStamp=null;if(state.timeframe===.5)state.halfIndex=Number(e.target.value);
    else state.index=Number(e.target.value);
    const row=replayCursor();state.chartFocusMs=row?.stampMs+(state.timeframe===.5?30_000:60_000);
    // A deliberate timeline seek recenters the selected instant. Playback and
    // ordinary candle updates leave a manually zoomed chart alone.
    window.TY_PRO_CHART?.recenter();
    render()};
  $('play').onclick=()=>{if(state.timer){stop();return}state.selectedStamp=null;state.timer=setInterval(()=>{
    const series=state.timeframe===.5?state.half?.bars?.[state.symbol]:state.replayTimeline;
    const index=state.timeframe===.5?state.halfIndex:state.index;
    if(index>=(series?.length||1)-1){stop();return}
    if(state.timeframe===.5)state.halfIndex++;else state.index++;render()},state.speed);$('play').textContent='❚❚ Pause'};
  function setSpeed(next){
    const wasPlaying=Boolean(state.timer);
    state.speed=next;$('speed').textContent=`1 candle / ${next/1000} ${next===1000?'second':'seconds'}`;
    if(wasPlaying){stop();$('play').click()}
  }
  $('slower').onclick=()=>setSpeed(replaySpeeds[Math.min(replaySpeeds.length-1,replaySpeeds.indexOf(state.speed)+1)]);
  $('faster').onclick=()=>setSpeed(replaySpeeds[Math.max(0,replaySpeeds.indexOf(state.speed)-1)]);
  $('previous').onclick=()=>{stop();state.selectedStamp=null;
    if(state.timeframe===.5)state.halfIndex=Math.max(0,state.halfIndex-1);else state.index=Math.max(0,state.index-1);render()};
  $('next').onclick=()=>{stop();state.selectedStamp=null;
    if(state.timeframe===.5)state.halfIndex=Math.min((state.half?.bars?.[state.symbol]?.length||1)-1,state.halfIndex+1);
    else state.index=Math.min((state.replayTimeline?.length||1)-1,state.index+1);render()};
  appReady.then(async()=>{
    if(state.mode!=='choose')return;
    const savedMode=tabValue(MODE_KEY);
    if(savedMode==='live'){
      $('mode-gate').hidden=true;$('dashboard').hidden=false;liveMode();
    }else if(savedMode==='replay'){
      $('mode-gate-status').textContent='Restoring historical replay…';
      try{
        await enterReplay();
        if(state.mode==='replay'){$('mode-gate').hidden=true;$('dashboard').hidden=false}
      }catch(error){$('mode-gate-status').textContent=`Replay unavailable: ${error.message}`}
    }
  });
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden&&state.mode==='live')refreshLive().finally(connectLiveUpdates)
  });
  window.addEventListener('focus',()=>{if(state.mode==='live')refreshLive()});
  const widthBand=()=>window.innerWidth<=650?0:window.innerWidth<=980?1:2;
  let previousCompact=widthBand();
  window.addEventListener('resize',()=>{
    const compact=widthBand();
    if(compact!==previousCompact){previousCompact=compact;render()}
  });
})();
