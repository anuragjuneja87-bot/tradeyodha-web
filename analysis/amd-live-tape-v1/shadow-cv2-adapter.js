/* Shadow C_v2 display contract. Research scores are never inferred from C_v1. */
((root,factory)=>{
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.TRADEYODHA_CV2=api;
})(typeof window==='undefined'?null:window,()=>{
  function reading(payload,symbol,date,width,time,complete){
    if(!complete)return {score:null,reason:'Candle is incomplete'};
    if(!payload)return {score:null,reason:'Shadow C_v2 research data unavailable'};
    if(payload.symbol!==symbol||payload.date!==date||payload.source!=='historical_rest_raw'||
       payload.version!=='Shadow C_v2')
      return {score:null,reason:'Shadow C_v2 source or session mismatch'};
    // Research rolling windows are indexed by their final included minute.
    // Dashboard candles are labeled by start, so a 08:30–08:45 candle maps to 08:44.
    const parts=time.split(':').map(Number);
    const minute=parts[0]*60+parts[1]+(width===.5?0:width-1);
    if(![.5,1,2,5,15].includes(width)||parts.length<2||
       !Number.isInteger(minute)||minute<0||minute>=24*60)
      return {score:null,reason:'Invalid Shadow C_v2 candle time or width'};
    const key=width===.5?time:
      `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
    const item=payload.windows?.[String(width)]?.[key];
    if(!item)return {score:null,reason:'No reconstructed Shadow C_v2 window'};
    if(item.score==null)return {score:null,reason:item.reason||'Shadow C_v2 quality gate failed'};
    if(!Number.isInteger(item.score)||item.score< -100||item.score>100||
       !Number.isInteger(item.priorDates)||item.priorDates<15)
      return {score:null,reason:'Shadow C_v2 score or reference validation failed'};
    return {score:item.score,reason:null,referenceDays:item.priorDates,
      coverageAll:item.coverageAll,quoteAgeMs:item.quoteAgeMs,version:'C_v2'};
  }
  return {reading};
});
