(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('chart'), ctx = canvas.getContext('2d');
  const colors = {bg:'#0a1829', panel:'#12263a', grid:'#2b4359', text:'#ecf5ff', muted:'#9bb2c7', green:'#33d4a7', red:'#ff6c7d', amber:'#f3bc69', blue:'#80bafa'};
  const replaySpeeds = [1000, 2000, 5000, 10000, 15000, 30000, 60000];
  const state = {mode:'replay', demo:null, live:null, index:162, timer:null, speed:1000, timeframe:1, analyticWindow:5, flowStart:'open', showPrice:false, hover:null};
  const number = n => n == null ? '—' : Math.round(n).toLocaleString();
  const signed = (n, digits=0) => n == null ? '—' : `${n>0?'+':''}${Number(n).toFixed(digits)}`;
  const money = n => n == null ? '—' : `$${Number(n).toFixed(2)}`;
  const compact = n => n == null ? '—' : `${n>0?'+':n<0?'−':''}$${(Math.abs(n)/1e6).toFixed(1)}M`;
  const tone = (el, n) => {el.classList.remove('positive','negative');if(n>0)el.classList.add('positive');if(n<0)el.classList.add('negative')};
  const pairs = () => state.mode === 'replay' ? state.demo?.bars : state.live?.bars;
  const visibleBars = amd => {
    const open=state.flowStart==='open'&&!state.showPrice?amd.find(r=>r.t>='08:30')?.stampMs:null;
    return (open==null?amd:amd.filter(r=>r.stampMs>=open)).slice(-70);
  };
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
    draw(amd,amdl);
  }
  function draw(amd,amdl){
    const box=canvas.getBoundingClientRect(),w=Math.max(700,Math.floor(box.width)),h=Math.max(320,Math.floor(box.height));
    const dpr=Math.min(2,devicePixelRatio||1);canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle=colors.bg;ctx.fillRect(0,0,w,h);
    const left=58,right=82,top=24,bottom=h-30,graphW=w-left-right;
    const show=visibleBars(amd),amdlMap=new Map(amdl.map(r=>[r.stampMs,r]));
    if(!show.length){ctx.fillStyle=colors.muted;ctx.font='15px system-ui';ctx.fillText(state.mode==='live'?'Waiting for complete one-minute AMD tape…':'Loading replay…',left+16,90);return}
    const height=bottom-top;
    const lanes=state.showPrice?[
      {name:'AMD PRICE',a:top,b:top+height*.41},
      {name:'CUMULATIVE CLASSIFIED SHARES',a:top+height*.43,b:top+height*.61},
      {name:'RUNNING AMD BUYER − SELLER SHARES',a:top+height*.63,b:top+height*.77},
      {name:'ROLLING QUOTE OFI · LAST 5 CANDLES',a:top+height*.79,b:top+height*.88},
      {name:'RUNNING AMDL BUYER − SELLER SHARES',a:top+height*.9,b:bottom}]:[
      {name:'CUMULATIVE CLASSIFIED SHARES',a:top,b:top+height*.28},
      {name:'RUNNING AMD BUYER − SELLER SHARES',a:top+height*.30,b:top+height*.55},
      {name:'ROLLING QUOTE OFI · LAST 5 CANDLES',a:top+height*.57,b:top+height*.78},
      {name:'RUNNING AMDL BUYER − SELLER SHARES',a:top+height*.80,b:bottom}];
    const priceLane=state.showPrice?lanes[0]:null;
    const [sharesLane,deltaLane,ofiLane,etfLane]=lanes.slice(state.showPrice?1:0);
    const n=show.length,step=graphW/n,x=i=>left+(i+.5)*step;
    const label=(value,x,y,color=colors.muted,size=11)=>{ctx.fillStyle=color;ctx.font=`${size}px system-ui`;ctx.fillText(value,x,y)};
    for(const lane of lanes){ctx.fillStyle=colors.panel;ctx.fillRect(left,lane.a,graphW,lane.b-lane.a);label(lane.name,left+7,lane.a+14,colors.muted,10)}
    let lo=0,hi=1;
    if(priceLane){
      lo=Math.min(...show.map(r=>r.l).filter(Number.isFinite));hi=Math.max(...show.map(r=>r.h).filter(Number.isFinite));
      if(!Number.isFinite(lo)||!Number.isFinite(hi)){lo=0;hi=1}const pad=Math.max(.2,(hi-lo)*.08);lo-=pad;hi+=pad;
    }
    const py=p=>priceLane.b-(p-lo)/(hi-lo)*(priceLane.b-priceLane.a);
    if(priceLane)for(let k=0;k<=4;k++){let v=lo+(hi-lo)*k/4,yy=py(v);ctx.strokeStyle=colors.grid;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke();label('$'+v.toFixed(2),w-right+5,yy+4)}
    const open=amd.find(r=>r.t>='08:30')?.stampMs;
    const start=state.flowStart==='open'&&open!=null?open:amd[0].stampMs;
    const running=new Map();let buy=0,sell=0,etfDelta=0,etfIndex=0;
    const rolling=[];
    for(const r of amd){
      if(r.stampMs<start)continue;
      buy+=r.buy||0;sell+=r.sell||0;
      while(etfIndex<amdl.length&&amdl[etfIndex].stampMs<=r.stampMs){
        if(amdl[etfIndex].stampMs>=start)etfDelta+=amdl[etfIndex].delta||0;
        etfIndex++;
      }
      rolling.push(r.ofi);
      const recent=rolling.slice(-5).filter(Number.isFinite);
      running.set(r.stampMs,{buy,sell,delta:buy-sell,ofi:recent.length?recent.reduce((a,b)=>a+b,0)/recent.length:null,etfDelta});
    }
    const flow=show.map(r=>running.get(r.stampMs));
    const short=n=>Math.abs(n)>=1e6?`${(n/1e6).toFixed(2)}M`:`${Math.round(n/1000)}K`;
    function scale(values,minSpan=1){
      let low=Math.min(...values.filter(Number.isFinite)),high=Math.max(...values.filter(Number.isFinite));
      if(!Number.isFinite(low)||!Number.isFinite(high))return [0,minSpan];
      const pad=Math.max(minSpan*.1,(high-low)*.12);return [low-pad,high+pad];
    }
    function y(value,lane,range){return lane.b-7-(value-range[0])/(range[1]-range[0])*(lane.b-lane.a-34)}
    function path(lane,range,key,color,width=2.5){
      ctx.beginPath();let started=false;
      flow.forEach((point,i)=>{const value=point?.[key];if(!Number.isFinite(value)){started=false;return}const xx=x(i),yy=y(value,lane,range);if(!started){ctx.moveTo(xx,yy);started=true}else ctx.lineTo(xx,yy)});
      ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.stroke();
    }
    function zero(lane,range){if(range[0]>0||range[1]<0)return;const yy=y(0,lane,range);ctx.strokeStyle=colors.grid;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke()}
    const last=flow.findLast(Boolean);
    const sharesRange=scale(flow.flatMap(p=>p?[p.buy,p.sell]:[]),1000);
    const deltaRange=scale(flow.map(p=>p?.delta),1000);
    const ofiRange=scale(flow.map(p=>p?.ofi),.15);
    const etfRange=scale(flow.map(p=>p?.etfDelta),1000);
    path(sharesLane,sharesRange,'buy',colors.green);path(sharesLane,sharesRange,'sell',colors.red);
    zero(deltaLane,deltaRange);path(deltaLane,deltaRange,'delta',colors.blue,3);
    zero(ofiLane,ofiRange);path(ofiLane,ofiRange,'ofi',colors.amber,3);
    zero(etfLane,etfRange);path(etfLane,etfRange,'etfDelta',colors.blue,2.5);
    if(last){
      label(`BUY ${short(last.buy)}`,left+7,sharesLane.a+29,colors.green,11);label(`SELL ${short(last.sell)}`,left+118,sharesLane.a+29,colors.red,11);
      label(`NET ${last.delta>=0?'+':''}${short(last.delta)}`,left+7,deltaLane.a+29,last.delta>=0?colors.green:colors.red,11);
      if(last.ofi!=null)label(`5-candle avg ${signed(last.ofi,3)}`,left+7,ofiLane.a+29,last.ofi>=0?colors.green:colors.red,11);
      label(`AMDL NET ${last.etfDelta>=0?'+':''}${short(last.etfDelta)}`,left+7,etfLane.a+29,last.etfDelta>=0?colors.green:colors.red,11);
    }
    show.forEach((r,i)=>{
      if(r.c==null)return;const xx=x(i);
      if(priceLane){const color=r.c>=r.o?colors.green:colors.red;
        ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(xx,py(r.h));ctx.lineTo(xx,py(r.l));ctx.stroke();
        const bodyWidth=Math.max(2,Math.min(14,step*.6));ctx.fillStyle=color;ctx.fillRect(xx-bodyWidth/2,Math.min(py(r.o),py(r.c)),bodyWidth,Math.max(2,Math.abs(py(r.o)-py(r.c))));}
      if(i%Math.max(1,Math.ceil(90/step))===0)label(r.t,xx-13,h-9,colors.muted,10);
    });
    if(state.hover!=null&&state.hover>=0&&state.hover<show.length){const i=state.hover,xx=x(i);ctx.strokeStyle=colors.blue;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);ctx.stroke();ctx.setLineDash([]);const r=show[i],e=amdlMap.get(r.stampMs),p=flow[i];$('readout').textContent=`${r.t} CT · AMD ${money(r.c)} · buyer ${number(r.buy)} / seller ${number(r.sell)} · Δ ${signed(r.delta)} · running Δ ${signed(p?.delta)} · OFI ${signed(r.ofi,3)} · rolling OFI ${signed(p?.ofi,3)} · queue ${signed(r.queue,3)} · mid ${signed(r.midMoveCents,1)}¢ · AMDL Δ ${signed(e?.delta)} · coverage ${r.coveragePct==null?'—':r.coveragePct+'%'}`}
  }
  $('replay').onclick=replayMode;$('live').onclick=liveMode;
  for(const minutes of [1,2,5])$('candle-'+minutes).onclick=()=>{state.timeframe=minutes;for(const value of [1,2,5])$('candle-'+value).classList.toggle('active',value===minutes);state.hover=null;render()};
  for(const minutes of [5,15])$('analytic-'+minutes).onclick=()=>{state.analyticWindow=minutes;for(const value of [5,15])$('analytic-'+value).classList.toggle('active',value===minutes);render()};
  $('show-price').onclick=()=>{state.showPrice=!state.showPrice;$('show-price').classList.toggle('active',state.showPrice);$('show-price').textContent=state.showPrice?'Hide price chart':'Show price chart';render()};
  for(const value of ['open','session'])$('flow-'+value).onclick=()=>{state.flowStart=value;for(const option of ['open','session'])$('flow-'+option).classList.toggle('active',option===value);state.hover=null;render()};
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
  canvas.onmousemove=e=>{const show=visibleBars(current().amd),box=canvas.getBoundingClientRect(),w=Math.max(700,box.width),step=(w-140)/Math.max(show.length,1);state.hover=Math.floor((e.clientX-box.left-58)/step);render()};
  canvas.onmouseleave=()=>{state.hover=null;$('readout').textContent='Hover over a candle to inspect the aligned indicators.';render()};
  window.onresize=()=>render();
  if(window.AMD_LIVE_DEMO){state.demo=window.AMD_LIVE_DEMO;state.index=Math.min(162,state.demo.bars.AMD.length-1);replayMode()}
  else status('October 6 replay data unavailable','bad');
  setInterval(()=>{if(state.mode==='live')refreshLive()},2000);
})();
