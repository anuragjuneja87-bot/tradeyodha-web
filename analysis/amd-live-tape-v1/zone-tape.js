/* Completed 30-second, price-level execution arithmetic for live and replay.
 * Inputs are already authenticated source buckets; no price or side is inferred. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.TRADEYODHA_ZONE_TAPE=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const BUCKET_MS=30_000;
  const finite=Number.isFinite;
  const clock=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',
    month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function inspect(buckets,zone,asOfMs,options={}){
    const {startMs,endMs,lowCents,highCents}=zone||{};
    const invalid=reason=>({status:'insufficient',reason,startMs,endMs,lowCents,highCents});
    if(![startMs,endMs,lowCents,highCents,asOfMs].every(finite)||
       ![startMs,endMs,lowCents,highCents].every(Number.isInteger)||
       startMs%BUCKET_MS||endMs%BUCKET_MS||endMs<=startMs||
       endMs-startMs>2*60*60_000||lowCents>highCents)
      return invalid('Invalid completed time or price boundaries');
    if(endMs>asOfMs)return invalid('Selection extends beyond available completed tape');
    const byStamp=new Map((buckets||[]).filter(row=>finite(row.stampMs)&&
      row.stampMs+BUCKET_MS<=asOfMs).map(row=>[row.stampMs,row]));
    const selected=[],slots=[];
    for(let stamp=startMs;stamp<endMs;stamp+=BUCKET_MS){
      const row=byStamp.get(stamp);
      if(!row){slots.push({stampMs:stamp,endMs:stamp+BUCKET_MS,gap:true});continue}
      if(row.priceOnly||row.complete===false||row.corrected===true||
         row.invalid===true||!Array.isArray(row.priceLevels)||
         ![row.litShares,row.buy,row.sell,row.o,row.c].every(finite)||
         row.litShares<0||row.buy<0||row.sell<0||row.buy+row.sell>row.litShares)
        return invalid(`Missing or incomplete price-level bucket at ${clock.format(stamp)} CT`);
      let lit=0,buy=0,sell=0;
      for(const level of row.priceLevels){
        if(!Array.isArray(level)||level.length<4||
           !level.slice(0,4).every(finite)||!Number.isInteger(level[0])||
           level[1]<0||level[2]<0||level[3]<0||level[2]+level[3]>level[1])
          return invalid(`Invalid price-level record at ${clock.format(stamp)} CT`);
        lit+=level[1];buy+=level[2];sell+=level[3];
      }
      if(lit!==row.litShares||buy!==row.buy||sell!==row.sell)
        return invalid(`Price-level totals differ from completed bucket at ${clock.format(stamp)} CT`);
      selected.push(row);slots.push(row);
    }
    if(!selected.length)return invalid('No completed price-level buckets in this selection');
    const levels=new Map(),series=[];
    let cumulativeDelta=0;
    for(const row of slots){
      if(row.gap){series.push(row);continue}
      let bucketBuy=0,bucketSell=0,bucketUnknown=0;
      for(const [cents,lit,buy,sell] of row.priceLevels){
        if(cents<lowCents||cents>highCents)continue;
        const found=levels.get(cents)||{cents,lit:0,buy:0,sell:0,unknown:0};
        found.lit+=lit;found.buy+=buy;found.sell+=sell;found.unknown+=lit-buy-sell;
        levels.set(cents,found);
        bucketBuy+=buy;bucketSell+=sell;bucketUnknown+=lit-buy-sell;
      }
      cumulativeDelta+=bucketBuy-bucketSell;
      const quoteUsable=finite(row.ofi)&&finite(row.quoteAgeMs)&&
        row.quoteAgeMs>=0&&row.quoteAgeMs<=2000&&finite(row.quoteUpdates)&&
        row.quoteUpdates>=2;
      series.push({stampMs:row.stampMs,endMs:row.stampMs+BUCKET_MS,
        buy:bucketBuy,sell:bucketSell,unknown:bucketUnknown,
        delta:bucketBuy-bucketSell,cumulativeDelta,
        priceOpen:row.o,priceClose:row.c,quoteUsable,
        classifiedPct:bucketBuy+bucketSell+bucketUnknown?
          100*(bucketBuy+bucketSell)/(bucketBuy+bucketSell+bucketUnknown):null});
    }
    const all=[...levels.values()];
    const sum=key=>all.reduce((total,row)=>total+row[key],0);
    const lit=sum('lit'),buy=sum('buy'),sell=sum('sell'),unknown=sum('unknown');
    const classified=buy+sell,delta=buy-sell;
    let outputSeries=series;
    let missingBuckets=slots.length-selected.length;
    let bucketCount=slots.length,observedBucketCount=selected.length;
    let first=slots[0],last=slots.at(-1);
    const intervalMs=options.intervalMs||BUCKET_MS;
    if(intervalMs!==BUCKET_MS){
      if(!Number.isInteger(intervalMs)||intervalMs%BUCKET_MS||
         startMs%intervalMs||endMs%intervalMs)
        return invalid('Selection does not align with the selected chart timeframe');
      const references=new Map((options.referenceBars||[]).map(row=>[row.stampMs,row]));
      outputSeries=[];
      for(let stamp=startMs;stamp<endMs;stamp+=intervalMs){
        const group=series.slice((stamp-startMs)/BUCKET_MS,(stamp-startMs+intervalMs)/BUCKET_MS);
        const sources=slots.slice((stamp-startMs)/BUCKET_MS,(stamp-startMs+intervalMs)/BUCKET_MS)
          .filter(row=>!row.gap);
        const reference=references.get(stamp);
        const validReference=reference?.complete===true&&
          [reference.o,reference.c,reference.litShares,reference.buy,reference.sell].every(finite)&&
          reference.litShares>=0&&reference.buy>=0&&reference.sell>=0&&
          reference.buy+reference.sell<=reference.litShares;
        // A missing half-minute can be a genuine zero-lit interval. Only a
        // completed chart candle whose full lit/B/S totals reconcile with the
        // recorded price ladders can establish that; otherwise leave a gap.
        const reconciled=validReference&&['litShares','buy','sell'].every(key=>
          reference[key]===sources.reduce((total,row)=>total+row[key],0));
        if(!reconciled){outputSeries.push({stampMs:stamp,endMs:stamp+intervalMs,gap:true});continue}
        const present=group.filter(row=>!row.gap);
        const buy=present.reduce((total,row)=>total+row.buy,0);
        const sell=present.reduce((total,row)=>total+row.sell,0);
        const unknown=present.reduce((total,row)=>total+row.unknown,0);
        outputSeries.push({stampMs:stamp,endMs:stamp+intervalMs,buy,sell,unknown,
          delta:buy-sell,cumulativeDelta:present.at(-1)?.cumulativeDelta??0,
          priceOpen:reference.o,priceClose:reference.c,
          quoteUsable:present.length===intervalMs/BUCKET_MS&&present.every(row=>row.quoteUsable),
          classifiedPct:buy+sell+unknown?100*(buy+sell)/(buy+sell+unknown):null});
      }
      bucketCount=outputSeries.length;
      observedBucketCount=outputSeries.filter(row=>!row.gap).length;
      missingBuckets=bucketCount-observedBucketCount;
      first=outputSeries[0];last=outputSeries.at(-1);
    }
    const recent=outputSeries.slice(-Math.max(1,60_000/intervalMs));
    const last60=recent.length===Math.max(1,60_000/intervalMs)&&recent.every(row=>!row.gap)?
      {delta:recent.reduce((total,row)=>total+row.delta,0),
        priceMove:recent.at(-1).priceClose-recent[0].priceOpen}:null;
    const quoteUsable=selected.filter(row=>finite(row.ofi)&&
      finite(row.quoteAgeMs)&&row.quoteAgeMs>=0&&row.quoteAgeMs<=2000&&
      finite(row.quoteUpdates)&&row.quoteUpdates>=2).length;
    const maxQuoteAgeMs=Math.max(0,...selected.map(row=>
      finite(row.quoteAgeMs)?row.quoteAgeMs:0));
    return {status:missingBuckets?'partial':'available',startMs,endMs,lowCents,highCents,
      bucketCount,observedBucketCount,missingBuckets,intervalMs,
      lit,buy,sell,unknown,delta,
      series:outputSeries,startPrice:missingBuckets?null:first.priceOpen??first.o,
      endPrice:missingBuckets?null:last.priceClose??last.c,last60,
      imbalancePct:classified?100*delta/classified:null,
      coveragePct:lit?100*classified/lit:null,
      intensity:missingBuckets?null:lit/((endMs-startMs)/1000),
      topPrices:all.filter(row=>row.buy+row.sell>0)
        .sort((a,b)=>(b.buy+b.sell)-(a.buy+a.sell)||a.cents-b.cents)
        .slice(0,5).map(row=>({cents:row.cents,buy:row.buy,sell:row.sell,
          classified:row.buy+row.sell})),
      fullWindowPriceMove:missingBuckets?null:(last.priceClose??last.c)-(first.priceOpen??first.o),
      quoteContext:{usableBuckets:quoteUsable,totalBuckets:selected.length,
        lastQuoteAgeMs:finite(selected.at(-1).quoteAgeMs)?selected.at(-1).quoteAgeMs:null,
        maxRecordedQuoteAgeMs:maxQuoteAgeMs,
        warning:missingBuckets?
          'Some selected candles could not be reconciled; totals cover recorded executions only':
          quoteUsable*2<=selected.length?
            'Most buckets lack fresh usable quote context; trade-side estimates may be uncertain':null},
      availability:'Completed source buckets; historical receipt times unrecorded when replayed'};
  }
  return {inspect,BUCKET_MS};
});
