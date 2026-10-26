/* Descriptive candle arithmetic shared by live Trader View and historical replay.
 * No model, threshold-trained signal, or future candle enters this module. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TRADEYODHA_TAPE_INTEL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const finite = Number.isFinite;
  function quoteUsable(row) {
    return finite(row?.ofi) && finite(row?.quoteUpdates) && row.quoteUpdates >= 3 &&
      finite(row?.quoteAgeMs) && row.quoteAgeMs <= 2000;
  }
  function summarize(row, durationMs, {provisional = false, feedFresh = true,
    replayQuality = null} = {}) {
    if (!row) return {state:'missing', observation:'No completed candle', unknown:null};
    const buy = row.buy, sell = row.sell, lit = row.litShares;
    const validShares = [buy,sell,lit].every(finite) && buy >= 0 && sell >= 0 &&
      lit >= buy + sell;
    const unknown = validShares ? lit - buy - sell : null;
    const classified = validShares ? buy + sell : null;
    const coverage = validShares && lit > 0 ? 100 * classified / lit : null;
    const delta = validShares ? buy - sell : null;
    const imbalance = classified > 0 ? 100 * delta / classified : null;
    const priceMove = finite(row.o) && finite(row.c) ? row.c - row.o : null;
    // Forming bars contain only completed source buckets. Their rate uses that
    // observed span, never the still-unseen remainder of the candle.
    const observedMs = provisional ? row.throughMs - row.stampMs : durationMs;
    const intensity = validShares && finite(durationMs) && durationMs > 0 &&
      finite(observedMs) && observedMs > 0 && observedMs <= durationMs ?
      lit / (observedMs / 1000) : null; // shares/s, not trade prints/s
    const age = finite(row.quoteAgeMs) ? row.quoteAgeMs : null;
    const spread = finite(row.medianSpreadCents) ? row.medianSpreadCents : null;
    let state = !validShares || priceMove == null ? 'missing' :
      !feedFresh ? 'stale' : provisional ? 'provisional' :
      age == null || age > 2000 || !finite(row.ofi) ||
        !finite(row.quoteUpdates) || row.quoteUpdates < 3 ||
        finite(row.quoteTotalMinutes) &&
          (!finite(row.quoteUsableMinutes) ||
           row.quoteUsableMinutes * 2 <= row.quoteTotalMinutes) ? 'quote-limited' :
      coverage == null || coverage < 65 || replayQuality && replayQuality !== 'valid' ?
        'limited' : 'qualified';
    let observation = 'Pressure and price response unavailable';
    if (state === 'provisional') observation = 'Forming candle · pressure and price may revise';
    else if (state === 'stale') observation = 'Feed stale · last recorded candle only';
    else if (delta != null && priceMove != null && state === 'qualified') {
      const flat = Math.abs(priceMove) <= Math.max(0.01, (spread || 0) / 100);
      // A tiny difference between classified sides is balanced tape, not dominant effort.
      // This is a conservative display gate, not an absorption signal or fitted threshold.
      const dominant = Math.abs(delta) >= 100 && Math.abs(imbalance) >= 20;
      if (!dominant) observation = 'Mixed or balanced pressure and price response';
      else if (delta > 0 && priceMove < -0.01) observation =
        'Price declined despite estimated buying pressure';
      else if (delta < 0 && priceMove > 0.01) observation =
        'Price advanced despite estimated selling pressure';
      else if (delta > 0 && flat) observation =
        'Pressure–Price Divergence · Research Observation: buying dominant, price progress within spread';
      else if (delta < 0 && flat) observation =
        'Pressure–Price Divergence · Research Observation: selling dominant, price progress within spread';
      else if (delta > 0 && priceMove > 0) observation = 'Estimated buyers dominant · price advanced';
      else if (delta < 0 && priceMove < 0) observation = 'Estimated sellers dominant · price declined';
      else observation = 'Mixed or balanced pressure and price response';
    } else if (state === 'limited' || state === 'quote-limited') {
      observation = 'Pressure interpretation withheld · source quality limited';
    }
    return {state,observation,buy:validShares?buy:null,sell:validShares?sell:null,
      unknown,lit:validShares?lit:null,delta,imbalance,coverage,priceMove,intensity,
      quoteAgeMs:age,spreadCents:spread,ofi:finite(row.ofi)?row.ofi:null,
      provisional};
  }
  function nearestLevel(levels, price, asOfMs) {
    if (!finite(price) || !finite(asOfMs)) return null;
    return (levels || []).filter(level => finite(level.value) &&
      finite(level.availableMs) && level.availableMs <= asOfMs)
      .sort((a,b) => Math.abs(a.value-price)-Math.abs(b.value-price))[0] || null;
  }
  function levelResponse(rows, level, asOfMs, band = 0.25) {
    if (!level || !finite(asOfMs)) return null;
    const visible = (rows || []).filter(row => finite(row.stampMs) &&
      finite(row.c) && row.stampMs < asOfMs).slice(-3);
    if (!visible.length) return null;
    const last = visible.at(-1), first = visible[0];
    const touching = visible.some(row => finite(row.l) && finite(row.h) &&
      row.l - band <= level.value && row.h + band >= level.value);
    const approach = visible.length < 2 ? 'approach unavailable' :
      Math.abs(last.c-level.value) < Math.abs(first.c-level.value)-0.01 ? 'approaching' :
      Math.abs(last.c-level.value) > Math.abs(first.c-level.value)+0.01 ? 'moving away' :
      'holding distance';
    return `${approach} · ${touching?'recent range tested level':'no recent range test'} · last close ${last.c >= level.value?'above':'below'}`;
  }
  function stripEvidenceKey(context, candles) {
    // Quality and level inputs can arrive after the price bars. Include them
    // so cached badges cannot survive a same-status evidence update.
    return JSON.stringify([context,(candles || []).map(item =>
      [item.stampMs,item.bar,item.quality,item.levels])]);
  }
  return {summarize,quoteUsable,nearestLevel,levelResponse,stripEvidenceKey};
});
