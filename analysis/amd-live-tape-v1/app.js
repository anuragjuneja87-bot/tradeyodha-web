(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const replaySpeeds = [1000, 2000, 5000, 10000, 15000, 30000, 60000];
  const state = {mode:'replay', demo:null, live:null, index:162, timer:null, speed:1000, timeframe:1, analyticWindow:5, flowWindow:5, flowStart:'open'};
  const number = n => n == null ? '—' : Math.round(n).toLocaleString();
  const signed = (n, digits=0) => n == null ? '—' : `${n>0?'+':''}${Number(n).toFixed(digits)}`;
  const money = n => n == null ? '—' : `$${Number(n).toFixed(2)}`;
  const compact = n => n == null ? '—' : `${n>0?'+':n<0?'−':''}$${(Math.abs(n)/1e6).toFixed(1)}M`;
  const tone = (el, n) => {el.classList.remove('positive','negative');if(n>0)el.classList.add('positive');if(n<0)el.classList.add('negative')};
  const pairs = () => state.mode === 'replay' ? state.demo?.bars : state.live?.bars;
  const clockTime = stampMs => new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit',hour12:false}).format(stampMs);
  function aggregate(source, minutes, cutoff){
    if(minutes===1)return source.filter(r=>r.stampMs+60000<=cutoff);
    const duration=minutes*60000, buckets=new Map();
    for(const row of source){
      const start=Math.floor(row.stampMs/duration)*duration;
      if(start+duration>cutoff)continue;
      if(!buckets.has(start))buckets.set(start,[]);
      buckets.get(start).push(row);
    }
    const sum=(rows,key)=>rows.reduce((n,r)=>n+(r[key]||0),0);
    const mean=(rows,key)=>{const values=rows.map(r=>r[key]).filter(Number.isFinite);return values.length?values.reduce((a,b)=>a+b,0)/values.length:null};
    return [...buckets].sort((a,b)=>a[0]-b[0]).map(([stampMs,rows])=>{
      const last=rows.at(-1),litShares=sum(rows,'litShares'),buy=sum(rows,'buy'),sell=sum(rows,'sell');
      return {t:clockTime(stampMs),stampMs,o:rows[0].o,h:Math.max(...rows.map(r=>r.h)),l:Math.min(...rows.map(r=>r.l)),c:last.c,
        litShares,buy,sell,delta:buy-sell,imbalancePct:buy+sell?(buy-sell)/(buy+sell)*100:null,
        coveragePct:litShares?(buy+sell)/litShares*100:null,netOutflowUsd:sum(rows,'netOutflowUsd'),
        ofi:mean(rows,'ofi'),queue:last.queue,medianSpreadCents:mean(rows,'medianSpreadCents'),
        midMoveCents:rows.some(r=>Number.isFinite(r.midMoveCents))?sum(rows,'midMoveCents'):null,quoteAgeMs:last.quoteAgeMs};
    });
  }
  const current = () => {
    const bars = pairs();if(!bars)return {amd:[],amdl:[]};
    const source=state.mode==='replay'?bars.AMD.slice(0,state.index+1):bars.AMD;
    const cutoff=source.at(-1)?.stampMs+60000;
    if(!cutoff)return {amd:[],amdl:[]};
    return {amd:aggregate(source,state.timeframe,cutoff),amdl:aggregate(bars.AMDL,state.timeframe,cutoff)};
  };
  const status = (value,style) => {const el=$('status');el.textContent=value;el.className=`status ${style}`};
  function renderAnalytics(){
    const source=state.mode==='replay'?state.demo?.bars.AMD.slice(0,state.index+1):state.live?.bars.AMD;
    const date=state.mode==='replay'?state.demo?.date:state.live?.date;
    $('analytic-asof').textContent=source?.at(-1)?`${source.at(-1).t} CT · ${state.analyticWindow}m window`:'—';
    const signal=$('analytic-signal'),evidence=$('analytic-evidence'),analogs=$('analytic-analogs');
    signal.className='analytics-signal';evidence.textContent='';analogs.textContent='';
    if(state.mode==='live'){
      const feed=state.live||{},age=feed.receivedAgeSeconds,lag=feed.eventLagSeconds;
      if(feed.status!=='connected'||age==null||age>15||lag==null||lag>15){signal.textContent='Live feed is not fresh; analysis paused';return}
      if(!source?.at(-1)||Date.now()-(source.at(-1).stampMs+60000)>90000){signal.textContent='No recent complete AMD minute; analysis paused';return}
    }
    if(!source?.length||!date||!window.AMD_TAPE_ANALYTICS){signal.textContent='Waiting for completed AMD tape';return}
    const result=window.AMD_TAPE_ANALYTICS.analyze(source,date,state.analyticWindow,window.AMD_ANALYTICS_HISTORY);
    if(result.reason){signal.textContent=result.reason;return}
    signal.textContent=result.label;signal.classList.add(result.kind);
    const c=result.current;
    evidence.textContent=`${c.width}m ${source.at(-c.width).t}–${c.end} CT · classified ${number(c.buy)} buy / ${number(c.sell)} sell · Δ ${signed(c.delta*100,1)}% (P${result.deltaRank}) · mean OFI ${signed(c.ofi,3)} (P${result.ofiRank}) · price ${signed(c.priceBps,1)} bp`;
    analogs.textContent=`Compared with ${result.peers} same-clock windows across ${result.days} prior sessions. Closest dates: ${result.analogs.map(row=>`${row[0]} ${row[1]} (Δ ${signed(row[3]*100,1)}%, OFI ${signed(row[4],3)})`).join(' · ')}`;
  }
  function replayMode(){
    state.mode='replay';$('replay').classList.add('active');$('live').classList.remove('active');
    $('replay-controls').hidden=false;$('mode-note').textContent='Recorded October 6 session · slider reveals only completed earlier minutes';
    stop();render();
  }
  function liveMode(){
    state.mode='live';$('live').classList.add('active');$('replay').classList.remove('active');
    $('replay-controls').hidden=true;$('mode-note').textContent='Local Massive WebSocket collector · last completed minute';
    stop();refreshLive();render();
  }
  function stop(){if(state.timer){clearInterval(state.timer);state.timer=null}$('play').textContent='▶ Play'}
  async function refreshLive(){
    try{
      const base=location.protocol==='file:'?'http://127.0.0.1:8765':'';
      const res=await fetch(base+'/api/state',{cache:'no-store',signal:AbortSignal.timeout(3000)});
      if(!res.ok)throw new Error('HTTP '+res.status);
      state.live=await res.json();
    }catch(_error){state.live={status:'offline',message:'Local collector is not running',bars:{AMD:[],AMDL:[]},receivedAgeSeconds:null,eventLagSeconds:null}}
    if(state.mode==='live')render();
  }
  function render(){
    const {amd,amdl}=current(),row=amd.at(-1),etf=amdl.findLast(r=>r.stampMs===row?.stampMs);
    $('aggregation-note').textContent=state.timeframe===1?'1-minute tape':`${state.timeframe}-minute candles · trade shares and dollars summed · OFI is the mean of available 1-minute OFI readings · midprice response sums available 1-minute moves`;
    if(state.mode==='replay'){
      if(state.demo){status('REPLAY · October 6, 2026','warn');$('asof').textContent=state.demo.bars.AMD[state.index]?`${state.demo.bars.AMD[state.index].t} CT`:'—';$('scrub').max=Math.max(0,state.demo.bars.AMD.length-1);$('scrub').value=state.index}
    }else{
      const feed=state.live||{},age=feed.receivedAgeSeconds,lag=feed.eventLagSeconds;
      const gaps=feed.feedGapsOrOutOfOrderDrops||0;
      const barAge=row?Math.max(0,Math.round(Date.now()/1000-(row.stampMs/1000+60))):null;
      const text=`${String(feed.status||'waiting').toUpperCase()} · ${feed.message||'Waiting for collector'}${gaps?` · ${gaps} gap/drop${gaps===1?'':'s'}`:''}`;
      status(text,feed.status==='connected'&&age!=null&&age<=15&&lag!=null&&lag<=15&&barAge!=null&&barAge<=90&&!gaps?'good':feed.status==='offline'||feed.status==='error'?'bad':'warn');
    }
    $('clock').textContent=`Last complete ${state.timeframe}m candle: ${row?.t||'—'} CT`;
    $('price').textContent=money(row?.c);$('range').textContent=row?`H ${money(row.h)} · L ${money(row.l)}`:'Waiting for a complete minute';
    $('shares').textContent=row?`${number(row.buy)} / ${number(row.sell)}`:'—';
    $('delta').textContent=signed(row?.delta);tone($('delta'),row?.delta);
    $('coverage').textContent=row?.coveragePct==null?'No classified print':`${row.coveragePct.toFixed(1)}% classified coverage`;
    $('ofi').textContent=signed(row?.ofi,3);tone($('ofi'),row?.ofi);
    $('spread').textContent=row?.medianSpreadCents==null?'No valid quote':`${row.medianSpreadCents.toFixed(1)}¢ median spread`;
    $('queue').textContent=signed(row?.queue,3);tone($('queue'),row?.queue);
    $('response').textContent=row?.midMoveCents==null?'—':`${signed(row.midMoveCents,1)}¢`;tone($('response'),row?.midMoveCents);
    $('amdl').textContent=signed(etf?.delta);tone($('amdl'),etf?.delta);
    $('net').textContent=compact(row?.netOutflowUsd);tone($('net'),-(row?.netOutflowUsd||0));
    $('freshness').textContent=state.mode==='live'?(state.live?.eventLagSeconds!=null?`Feed ${state.live.eventLagSeconds}s old · AMD bar ${row?Math.max(0,Math.round(Date.now()/1000-(row.stampMs/1000+60)))+'s old':'unavailable'}`:'No feed event yet'):'Recorded paired tape';
    renderAnalytics();
    renderFlow();
  }
  function renderFlow(){
    // Summaries always use complete one-minute bars, independent of the selected candle size.
    const bars=pairs();
    const amd=state.mode==='replay'?bars?.AMD.slice(0,state.index+1):bars?.AMD;
    const amdl=state.mode==='replay'?bars?.AMDL.filter(r=>r.stampMs<=(amd?.at(-1)?.stampMs||0)):bars?.AMDL;
    const last=amd?.at(-1);
    const aligned=new Map((amdl||[]).map(r=>[r.stampMs,r]));
    const recent=last?amd.filter(r=>r.stampMs>last.stampMs-state.flowWindow*60000):[];
    const running=amd?.filter(r=>state.flowStart==='open'?r.t>='08:30':r.t>='06:00')||[];
    function summary(rows){
      if(!rows.length)return null;
      const sum=(key)=>rows.reduce((total,row)=>total+(Number.isFinite(row[key])?row[key]:0),0);
      const buy=sum('buy'),sell=sum('sell'),lit=sum('litShares');
      const ofi=rows.map(r=>r.ofi).filter(Number.isFinite);
      const mid=rows.map(r=>r.midMoveCents).filter(Number.isFinite);
      return {first:rows[0],last:rows.at(-1),buy,sell,delta:buy-sell,imbalance:buy+sell?(buy-sell)/(buy+sell)*100:null,
        coverage:lit?(buy+sell)/lit*100:null,ofi:ofi.length?ofi.reduce((a,b)=>a+b,0)/ofi.length:null,
        price:rows.at(-1).c-rows[0].o,mid:mid.length?mid.reduce((a,b)=>a+b,0):null,
        amdl:rows.reduce((total,row)=>total+(aligned.get(row.stampMs)?.delta||0),0),count:rows.length};
    }
    function update(prefix,rows){
      const x=summary(rows),set=(name,value)=>$(prefix+'-'+name).textContent=value;
      set('time',x?`${x.first.t}–${x.last.t} CT · ${x.count} bars`:'No completed tape');
      set('delta',x?signed(x.delta)+' sh':'—');tone($(prefix+'-delta'),x?.delta);
      set('shares',x?`${number(x.buy)} buyer / ${number(x.sell)} seller shares`:'—');
      $(prefix+'-split').style.width=x&&x.buy+x.sell?`${x.buy/(x.buy+x.sell)*100}%`:'50%';
      set('imbalance',x?.imbalance==null?'—':`${signed(x.imbalance,1)}%`);tone($(prefix+'-imbalance'),x?.imbalance);
      set('ofi',signed(x?.ofi,3));tone($(prefix+'-ofi'),x?.ofi);
      set('price',x?`${signed(x.price,2)} USD`:'—');tone($(prefix+'-price'),x?.price);
      set('amdl',x?signed(x.amdl)+' sh':'—');tone($(prefix+'-amdl'),x?.amdl);
      set('mid',x?.mid==null?'—':`${signed(x.mid,1)}¢`);tone($(prefix+'-mid'),x?.mid);
      set('coverage',x?.coverage==null?'—':`${x.coverage.toFixed(1)}%`);
    }
    $('recent-title').textContent=`Last ${state.flowWindow} minutes`;
    $('running-title').textContent=state.flowStart==='open'?'Since 08:30 open':'Since 06:00 session';
    update('recent',recent);update('running',running);
    const body=$('minute-tape');body.replaceChildren();
    if(!last){const tr=body.insertRow(),td=tr.insertCell();td.colSpan=8;td.className='empty';td.textContent='Waiting for complete AMD tape';return}
    for(const row of amd.slice(-8).reverse()){
      const cells=[row.t,money(row.c),number(row.buy),number(row.sell),signed(row.delta),signed(row.ofi,3),row.midMoveCents==null?'—':signed(row.midMoveCents,1),signed(aligned.get(row.stampMs)?.delta)];
      const tr=body.insertRow();cells.forEach((value,i)=>{const td=tr.insertCell();td.textContent=value;if([4,5,6,7].includes(i))tone(td,i===4?row.delta:i===5?row.ofi:i===6?row.midMoveCents:aligned.get(row.stampMs)?.delta)});
    }
  }
  $('replay').onclick=replayMode;$('live').onclick=liveMode;
  for(const minutes of [1,2,5])$('candle-'+minutes).onclick=()=>{state.timeframe=minutes;for(const value of [1,2,5])$('candle-'+value).classList.toggle('active',value===minutes);render()};
  for(const minutes of [5,15])$('analytic-'+minutes).onclick=()=>{state.analyticWindow=minutes;for(const value of [5,15])$('analytic-'+value).classList.toggle('active',value===minutes);render()};
  for(const value of ['open','session'])$('flow-'+value).onclick=()=>{state.flowStart=value;for(const option of ['open','session'])$('flow-'+option).classList.toggle('active',option===value);render()};
  for(const minutes of [5,15,30])$('flow-'+minutes).onclick=()=>{state.flowWindow=minutes;for(const value of [5,15,30])$('flow-'+value).classList.toggle('active',value===minutes);render()};
  $('scrub').oninput=e=>{state.index=Number(e.target.value);render()};
  $('play').onclick=()=>{if(state.timer){stop();return}state.timer=setInterval(()=>{if(state.index>=state.demo.bars.AMD.length-1){stop();return}state.index++;render()},state.speed);$('play').textContent='❚❚ Pause'};
  function setSpeed(next){
    const wasPlaying=Boolean(state.timer);
    state.speed=next;$('speed').textContent=`1 candle / ${next/1000} ${next===1000?'second':'seconds'}`;
    if(wasPlaying){stop();$('play').click()}
  }
  $('slower').onclick=()=>setSpeed(replaySpeeds[Math.min(replaySpeeds.length-1,replaySpeeds.indexOf(state.speed)+1)]);
  $('faster').onclick=()=>setSpeed(replaySpeeds[Math.max(0,replaySpeeds.indexOf(state.speed)-1)]);
  $('previous').onclick=()=>{stop();state.index=Math.max(0,state.index-1);render()};
  $('next').onclick=()=>{stop();state.index=Math.min(state.demo.bars.AMD.length-1,state.index+1);render()};
  if(window.AMD_LIVE_DEMO){state.demo=window.AMD_LIVE_DEMO;state.index=Math.min(162,state.demo.bars.AMD.length-1);replayMode()}
  else status('October 6 replay data unavailable','bad');
  setInterval(()=>{if(state.mode==='live')refreshLive()},2000);
})();
