(() => {
  'use strict';
  const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const average = values => values.reduce((a, b) => a + b, 0) / values.length;
  const percentile = (values, value) => Math.round(100 * values.filter(x => x <= value).length / values.length);
  const deviation = (values, center, floor) => Math.max(floor, Math.sqrt(average(values.map(x => (x - center) ** 2))));

  function analyze(bars, date, width, library) {
    if (!library?.windows?.length) return {reason:'Historical AMD windows are unavailable'};
    if (!bars.length || bars.at(-1).t < '08:30' || bars.at(-1).t >= '11:00')
      return {reason:'Historical comparison covers 08:30–11:00 CT only'};
    const session = bars.filter(row => row.t >= '08:30' && row.t < '11:00');
    if (session.length < width) return {reason:`Waiting for ${width} complete regular-session minutes`};
    const rows = session.slice(-width);
    if (rows.some((row, i) => i && minute(row.t) - minute(rows[i - 1].t) !== 1))
      return {reason:'Minute gap in the current window; comparison paused'};
    const buy = rows.reduce((total, row) => total + (row.buy || 0), 0);
    const sell = rows.reduce((total, row) => total + (row.sell || 0), 0);
    const classified = buy + sell;
    const ofis = rows.map(row => row.ofi).filter(Number.isFinite);
    const coverages = rows.map(row => row.coveragePct).filter(Number.isFinite);
    if (classified < 1000 || ofis.length < Math.max(3, Math.ceil(width * .6)) || coverages.length !== width || average(coverages) < 65 || !rows[0].o || !rows.at(-1).c)
      return {reason:'Trade classification or quote coverage is too thin for a comparison'};
    const current = {
      end:rows.at(-1).t, width, buy, sell, classified,
      delta:(buy - sell) / classified,
      ofi:average(ofis),
      priceBps:10000 * (rows.at(-1).c / rows[0].o - 1),
      coverage:average(coverages),
    };
    const endMinute = minute(current.end);
    const peers = library.windows.filter(row => row[2] === width && row[0] < date && Math.abs(minute(row[1]) - endMinute) <= 15 && row[7] >= 65);
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
    const analogs=[];
    for(const row of peers.map(row=>({row,distance:
      ((current.delta-row[3])/deltaScale)**2+
      ((current.ofi-row[4])/ofiScale)**2+
      .5*((current.priceBps-row[5])/priceScale)**2+
      .2*Math.log(current.classified/row[6])**2
    })).sort((a,b)=>a.distance-b.distance)){
      if(!analogs.some(item=>item[0]===row.row[0]))analogs.push(row.row);
      if(analogs.length===3)break;
    }
    return {current,label,kind,deltaRank,ofiRank,days,peers:peers.length,analogs};
  }
  window.AMD_TAPE_ANALYTICS={analyze};
})();
