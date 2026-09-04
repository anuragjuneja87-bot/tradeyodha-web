import type {
  MarketBrief,
  MarketTone,
  NewsItem,
  OffExchangeSummary,
  OptionMetrics,
  PremarketBar,
  WatchlistQuote,
  WatchlistResponse,
} from '@/lib/market-types';

const MASSIVE_ORIGIN = 'https://api.massive.com';
const EASTERN_TIME_ZONE = 'America/New_York';

type ApiEnvelope<T> = {
  status?: string;
  results?: T;
  next_url?: string;
  error?: string;
  message?: string;
};

type UnifiedSnapshot = {
  ticker: string;
  type?: string;
  market_status?: string;
  session?: {
    price?: number;
    change_percent?: number;
    last_updated?: number;
  };
};

type StockSnapshot = {
  ticker?: {
    ticker?: string;
    todaysChangePerc?: number;
    updated?: number;
    min?: AggregateBar;
    day?: AggregateBar;
    prevDay?: AggregateBar;
  };
  status?: string;
  error?: string;
  message?: string;
};

type AggregateBar = {
  t?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  vw?: number;
};

type TickerDetails = {
  name?: string;
};

type OptionContract = {
  expiration_date?: string;
};

type OptionSnapshot = {
  details?: {
    contract_type?: 'call' | 'put';
    expiration_date?: string;
    strike_price?: number;
  };
  open_interest?: number;
  implied_volatility?: number;
  last_quote?: {
    bid?: number;
    ask?: number;
    midpoint?: number;
  };
  day?: {
    close?: number;
  };
};

type MassiveNews = {
  id?: string;
  title?: string;
  published_utc?: string;
  article_url?: string;
  publisher?: { name?: string };
  insights?: Array<{
    ticker?: string;
    sentiment?: 'positive' | 'negative' | 'neutral';
    sentiment_reasoning?: string;
  }>;
};

type StockTrade = {
  price?: number;
  size?: number;
  sip_timestamp?: number;
  trf_id?: number;
};

export class MassiveApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MassiveApiError';
    this.status = status;
  }
}

function apiKey() {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new MassiveApiError(503, 'Market data is not configured.');
  return key;
}

async function massiveFetch<T>(pathOrUrl: string, params?: Record<string, string | number | boolean | undefined>) {
  const url = new URL(pathOrUrl, MASSIVE_ORIGIN);
  if (url.origin !== MASSIVE_ORIGIN) throw new MassiveApiError(500, 'Unexpected market-data origin.');
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(9_000),
    });
  } catch {
    throw new MassiveApiError(504, 'Massive did not respond in time.');
  }

  const body = (await response.json().catch(() => ({}))) as ApiEnvelope<T> & Record<string, unknown>;
  if (!response.ok || body.status === 'ERROR' || body.status === 'NOT_AUTHORIZED') {
    throw new MassiveApiError(response.status || 502, body.error || body.message || 'Market data request failed.');
  }
  return body;
}

function dateParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function dateShift(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function previousWeekdays(from: string, count: number) {
  const dates: string[] = [];
  let cursor = from;
  while (dates.length < count) {
    cursor = dateShift(cursor, -1);
    const day = new Date(`${cursor}T12:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor);
  }
  return dates;
}

function unixNsToIso(value?: number) {
  if (!value) return null;
  return new Date(Math.floor(value / 1_000_000)).toISOString();
}

function marketStatusNow() {
  const now = dateParts(new Date());
  const weekday = new Date(`${now.date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return 'closed';
  if (now.minutes >= 240 && now.minutes < 570) return 'early_trading';
  if (now.minutes >= 570 && now.minutes < 960) return 'open';
  if (now.minutes >= 960 && now.minutes < 1200) return 'late_trading';
  return 'closed';
}

function feedFromTimestamp(timestamp: string | null): 'real-time' | 'delayed' {
  if (process.env.MASSIVE_REALTIME_ENABLED !== 'true' || !timestamp) return 'delayed';
  return Date.now() - new Date(timestamp).getTime() > 5 * 60_000 ? 'delayed' : 'real-time';
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function uniquePrices(values: Array<number | null | undefined>) {
  const seen = new Set<number>();
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .filter((value) => {
      const cents = Math.round(value * 100);
      if (seen.has(cents)) return false;
      seen.add(cents);
      return true;
    });
}

export function validateSymbols(input: string) {
  const symbols = input.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length || symbols.length > 20 || symbols.some((symbol) => !/^[A-Z.-]{1,6}$/.test(symbol))) {
    throw new MassiveApiError(400, 'Provide between 1 and 20 valid U.S. ticker symbols.');
  }
  return [...new Set(symbols)];
}

export async function getWatchlist(symbols: string[]): Promise<WatchlistResponse> {
  const envelope = await massiveFetch<UnifiedSnapshot[]>('/v3/snapshot', {
    'ticker.any_of': symbols.join(','),
    limit: Math.max(symbols.length, 10),
  });
  const results = (envelope.results ?? []).filter((item) => item.type === 'stocks');
  const quotes: WatchlistQuote[] = symbols.map((symbol) => {
    const item = results.find((result) => result.ticker === symbol);
    const updatedAt = unixNsToIso(item?.session?.last_updated);
    return {
      symbol,
      price: typeof item?.session?.price === 'number' ? item.session.price : null,
      changePercent: typeof item?.session?.change_percent === 'number' ? item.session.change_percent : null,
      marketStatus: item?.market_status ?? 'unavailable',
      updatedAt,
    };
  });
  const newest = quotes.map((quote) => quote.updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? new Date().toISOString();
  return { quotes, feed: feedFromTimestamp(newest), updatedAt: newest };
}

function toPremarketBars(bars: AggregateBar[], targetDate: string): PremarketBar[] {
  return bars.flatMap((bar) => {
    if (!bar.t) return [];
    const eastern = dateParts(new Date(bar.t));
    if (eastern.date !== targetDate || eastern.minutes < 240 || eastern.minutes >= 570) return [];
    return [{
      timestamp: bar.t,
      open: asNumber(bar.o),
      high: asNumber(bar.h),
      low: asNumber(bar.l),
      close: asNumber(bar.c),
      volume: asNumber(bar.v),
      vwap: typeof bar.vw === 'number' ? bar.vw : null,
    }];
  });
}

function premarketStats(bars: PremarketBar[]) {
  if (!bars.length) return { open: null, high: null, low: null, close: null, volume: 0, vwap: null };
  const volume = bars.reduce((sum, bar) => sum + bar.volume, 0);
  const weighted = bars.reduce((sum, bar) => sum + (bar.vwap ?? bar.close) * bar.volume, 0);
  return {
    open: bars[0].open,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    close: bars.at(-1)?.close ?? null,
    volume,
    vwap: volume ? weighted / volume : null,
  };
}

function relativePremarketVolume(history: AggregateBar[], today: string, currentVolume: number) {
  if (!currentVolume) return null;
  const cutoff = Math.min(Math.max(dateParts(new Date()).minutes, 240), 570);
  const totals = new Map<string, number>();
  for (const bar of history) {
    if (!bar.t) continue;
    const eastern = dateParts(new Date(bar.t));
    if (eastern.date === today || eastern.minutes < 240 || eastern.minutes >= cutoff) continue;
    totals.set(eastern.date, (totals.get(eastern.date) ?? 0) + asNumber(bar.v));
  }
  const samples = [...totals.values()].filter((value) => value > 0).slice(-10);
  if (!samples.length) return null;
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return average ? currentVolume / average : null;
}

async function getOptions(symbol: string, spot: number, today: string): Promise<OptionMetrics> {
  try {
    const contracts = await massiveFetch<OptionContract[]>('/v3/reference/options/contracts', {
      underlying_ticker: symbol,
      'expiration_date.gte': today,
      expired: false,
      order: 'asc',
      sort: 'expiration_date',
      limit: 1,
    });
    const expiration = contracts.results?.[0]?.expiration_date;
    if (!expiration) throw new MassiveApiError(404, 'No active option expiration was found.');

    const params = {
      expiration_date: expiration,
      'strike_price.gte': Math.max(0.5, spot * 0.65),
      'strike_price.lte': spot * 1.35,
      order: 'asc',
      sort: 'ticker',
      limit: 250,
    };
    const first = await massiveFetch<OptionSnapshot[]>(`/v3/snapshot/options/${encodeURIComponent(symbol)}`, params);
    const chain = [...(first.results ?? [])];
    let nextUrl = first.next_url;
    for (let page = 1; nextUrl && page < 4; page += 1) {
      const next = await massiveFetch<OptionSnapshot[]>(nextUrl);
      chain.push(...(next.results ?? []));
      nextUrl = next.next_url;
    }

    const usable = chain.filter((contract) =>
      typeof contract.details?.strike_price === 'number' &&
      (contract.details?.contract_type === 'call' || contract.details?.contract_type === 'put'));
    if (!usable.length) throw new MassiveApiError(404, 'Option open interest is not available for this expiration.');

    const calls = new Map<number, number>();
    const puts = new Map<number, number>();
    for (const contract of usable) {
      const strike = contract.details!.strike_price!;
      const target = contract.details!.contract_type === 'call' ? calls : puts;
      target.set(strike, (target.get(strike) ?? 0) + asNumber(contract.open_interest));
    }
    const callWall = [...calls].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const putWall = [...puts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const totalCallOi = [...calls.values()].reduce((sum, value) => sum + value, 0);
    const totalPutOi = [...puts.values()].reduce((sum, value) => sum + value, 0);
    const strikes = uniquePrices([...calls.keys(), ...puts.keys()]).sort((a, b) => a - b);
    let maxPain: number | null = null;
    let minimumPayout = Number.POSITIVE_INFINITY;
    for (const settlement of strikes) {
      let payout = 0;
      for (const [strike, oi] of calls) payout += Math.max(0, settlement - strike) * oi;
      for (const [strike, oi] of puts) payout += Math.max(0, strike - settlement) * oi;
      if (payout < minimumPayout) { minimumPayout = payout; maxPain = settlement; }
    }

    const nearestCall = usable.filter((item) => item.details?.contract_type === 'call').sort((a, b) => Math.abs(a.details!.strike_price! - spot) - Math.abs(b.details!.strike_price! - spot))[0];
    const nearestPut = usable.filter((item) => item.details?.contract_type === 'put').sort((a, b) => Math.abs(a.details!.strike_price! - spot) - Math.abs(b.details!.strike_price! - spot))[0];
    const midpoint = (item?: OptionSnapshot) => {
      if (!item) return null;
      if (typeof item.last_quote?.midpoint === 'number') return item.last_quote.midpoint;
      if (typeof item.last_quote?.bid === 'number' && typeof item.last_quote?.ask === 'number') return (item.last_quote.bid + item.last_quote.ask) / 2;
      return typeof item.day?.close === 'number' ? item.day.close : null;
    };
    const callPremium = midpoint(nearestCall);
    const putPremium = midpoint(nearestPut);
    let expectedMove = callPremium !== null && putPremium !== null ? callPremium + putPremium : null;
    if (expectedMove === null) {
      const iv = nearestCall?.implied_volatility ?? nearestPut?.implied_volatility;
      if (typeof iv === 'number') {
        const days = Math.max(1, Math.ceil((new Date(`${expiration}T20:00:00Z`).getTime() - Date.now()) / 86_400_000));
        expectedMove = spot * iv * Math.sqrt(days / 365);
      }
    }

    return {
      available: true,
      expiration,
      callWall,
      putWall,
      maxPain,
      putCallRatio: totalCallOi ? totalPutOi / totalCallOi : null,
      expectedMove,
      contractCount: usable.length,
      message: nextUrl ? 'Metrics use the nearest 1,000 contracts around spot.' : null,
    };
  } catch (error) {
    return {
      available: false,
      expiration: null,
      callWall: null,
      putWall: null,
      maxPain: null,
      putCallRatio: null,
      expectedMove: null,
      contractCount: 0,
      message: error instanceof MassiveApiError && error.status === 403
        ? 'Options open interest is not included in the current Massive plan.'
        : error instanceof Error ? error.message : 'Options data is temporarily unavailable.',
    };
  }
}

async function getNews(symbol: string): Promise<NewsItem[]> {
  const envelope = await massiveFetch<MassiveNews[]>('/v2/reference/news', {
    ticker: symbol,
    order: 'desc',
    sort: 'published_utc',
    limit: 5,
  });
  return (envelope.results ?? []).flatMap((item) => {
    if (!item.id || !item.title || !item.article_url || !item.published_utc) return [];
    const insight = item.insights?.find((value) => value.ticker === symbol);
    return [{
      id: item.id,
      title: item.title,
      publisher: item.publisher?.name ?? 'Market source',
      publishedAt: item.published_utc,
      url: item.article_url,
      sentiment: insight?.sentiment ?? null,
      sentimentReasoning: insight?.sentiment_reasoning ?? null,
    }];
  });
}

async function getOffExchange(symbol: string, today: string): Promise<OffExchangeSummary> {
  if (process.env.MASSIVE_TRADES_ENABLED !== 'true') {
    return {
      available: false,
      rows: [],
      message: 'The current Massive plan does not include historical tick/TRF data. Enable that entitlement to calculate off-exchange activity.',
    };
  }
  const dates = previousWeekdays(today, 3);
  try {
    const pages = await Promise.all(dates.map((date) => massiveFetch<StockTrade[]>(`/v3/trades/${encodeURIComponent(symbol)}`, {
      'timestamp.gte': date,
      'timestamp.lt': dateShift(date, 1),
      order: 'desc',
      sort: 'timestamp',
      limit: 50_000,
    })));
    const rows = pages.map((page, index) => {
      const trades = (page.results ?? []).filter((trade) => trade.trf_id !== undefined && asNumber(trade.price) > 0 && asNumber(trade.size) > 0);
      const shares = trades.reduce((sum, trade) => sum + asNumber(trade.size), 0);
      const notional = trades.reduce((sum, trade) => sum + asNumber(trade.size) * asNumber(trade.price), 0);
      return { date: dates[index], averagePrice: shares ? notional / shares : 0, shares, notional, printCount: trades.length };
    }).filter((row) => row.printCount > 0);
    return {
      available: true,
      rows,
      message: pages.some((page) => Boolean(page.next_url)) ? 'Each day is capped to the latest 50,000 trades; totals may be partial.' : null,
    };
  } catch (error) {
    return {
      available: false,
      rows: [],
      message: error instanceof MassiveApiError && error.status === 403
        ? 'Historical tick/TRF data is not included in the current Massive plan.'
        : 'Off-exchange activity is temporarily unavailable.',
    };
  }
}

function buildThesis(price: number, previousClose: number, premarket: ReturnType<typeof premarketStats>, relativeVolume: number | null, supports: number[], resistances: number[]) {
  const gap = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
  const tone: MarketTone = gap >= 0.6 ? 'bullish' : gap <= -0.6 ? 'bearish' : 'neutral';
  const volumeAdjustment = relativeVolume === null ? 0 : Math.max(-8, Math.min(12, (relativeVolume - 1) * 10));
  const score = Math.max(10, Math.min(90, Math.round(50 + gap * 7 + volumeAdjustment)));
  const support = supports[0] ?? premarket.low ?? previousClose;
  const resistance = resistances[0] ?? premarket.high ?? previousClose;
  const rvolText = relativeVolume === null ? 'relative premarket volume is still forming' : `premarket volume is ${relativeVolume.toFixed(1)}× its recent pace`;
  const read = tone === 'bullish' ? 'Constructive above first support' : tone === 'bearish' ? 'Weak below first resistance' : 'Balanced; wait for range expansion';
  const summary = `${gap >= 0 ? 'Price is above' : 'Price is below'} the prior close by ${Math.abs(gap).toFixed(2)}%, and ${rvolText}. The overnight range—not the headline gap—defines the first decision area.`;
  return {
    tone,
    score,
    read,
    summary,
    bullCase: `Acceptance above ${formatPrice(resistance)} keeps the path open to the next resistance level; use ${formatPrice(support)} as the first risk reference.`,
    bearCase: `A failed hold at ${formatPrice(support)} shifts focus to lower support; reclaiming ${formatPrice(resistance)} weakens that read.`,
    invalidation: `Directional conviction is low while price remains between ${formatPrice(support)} and ${formatPrice(resistance)}. Wait for price and volume to confirm.`,
  };
}

function formatPrice(value: number) {
  return `$${value.toFixed(value >= 1000 ? 0 : 2)}`;
}

export async function getMarketBrief(symbol: string): Promise<MarketBrief> {
  const now = new Date();
  const today = dateParts(now).date;
  const historyStart = dateShift(today, -24);
  const warnings: string[] = [];

  const [snapshotResult, detailsResult, todayBarsResult, historyResult, newsResult] = await Promise.allSettled([
    massiveFetch<never>(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`),
    massiveFetch<TickerDetails>(`/v3/reference/tickers/${encodeURIComponent(symbol)}`),
    massiveFetch<AggregateBar[]>(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/5/minute/${today}/${today}`, { adjusted: true, sort: 'asc', limit: 5_000 }),
    massiveFetch<AggregateBar[]>(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/30/minute/${historyStart}/${today}`, { adjusted: true, sort: 'asc', limit: 50_000 }),
    getNews(symbol),
  ]);

  if (snapshotResult.status === 'rejected') throw snapshotResult.reason;
  const snapshotEnvelope = snapshotResult.value as StockSnapshot;
  const snapshot = snapshotEnvelope.ticker;
  const previous = snapshot?.prevDay;
  if (!snapshot || !previous?.c || !previous.h || !previous.l) throw new MassiveApiError(404, `No market snapshot is available for ${symbol}.`);

  const todayBars = todayBarsResult.status === 'fulfilled' ? toPremarketBars(todayBarsResult.value.results ?? [], today) : [];
  if (todayBarsResult.status === 'rejected') warnings.push('Premarket bars are temporarily unavailable.');
  const premarket = premarketStats(todayBars);
  const historyBars = historyResult.status === 'fulfilled' ? historyResult.value.results ?? [] : [];
  if (historyResult.status === 'rejected') warnings.push('Relative-volume history is temporarily unavailable.');
  const relativeVolume = relativePremarketVolume(historyBars, today, premarket.volume);
  const price = premarket.close ?? asNumber(snapshot.min?.c, asNumber(previous.c));
  const previousClose = asNumber(previous.c);
  const updatedAt = unixNsToIso(snapshot.updated) ?? new Date().toISOString();

  const [options, offExchange] = await Promise.all([
    getOptions(symbol, price, today),
    getOffExchange(symbol, today),
  ]);

  const pivot = (asNumber(previous.h) + asNumber(previous.l) + previousClose) / 3;
  const r1 = 2 * pivot - asNumber(previous.l);
  const s1 = 2 * pivot - asNumber(previous.h);
  const r2 = pivot + (asNumber(previous.h) - asNumber(previous.l));
  const s2 = pivot - (asNumber(previous.h) - asNumber(previous.l));
  const supports = uniquePrices([premarket.low, pivot, s1, s2, options.putWall]).filter((value) => value < price).sort((a, b) => b - a).slice(0, 3);
  const resistances = uniquePrices([premarket.high, pivot, r1, r2, options.callWall]).filter((value) => value > price).sort((a, b) => a - b).slice(0, 3);
  const safeSupports = supports.length ? supports : uniquePrices([s1, s2, previousClose]).sort((a, b) => b - a).slice(0, 3);
  const safeResistances = resistances.length ? resistances : uniquePrices([r1, r2, previousClose]).sort((a, b) => a - b).slice(0, 3);

  if (!options.available && options.message) warnings.push(options.message);
  if (!offExchange.available && offExchange.message) warnings.push(offExchange.message);

  return {
    symbol,
    name: detailsResult.status === 'fulfilled' ? detailsResult.value.results?.name ?? symbol : symbol,
    price,
    previousClose,
    changePercent: previousClose ? ((price - previousClose) / previousClose) * 100 : asNumber(snapshot.todaysChangePerc),
    marketStatus: marketStatusNow(),
    updatedAt,
    feed: feedFromTimestamp(updatedAt),
    premarket: { ...premarket, relativeVolume, bars: todayBars },
    options,
    levels: {
      pivot,
      previousVwap: typeof previous.vw === 'number' ? previous.vw : null,
      supports: safeSupports,
      resistances: safeResistances,
    },
    thesis: buildThesis(price, previousClose, premarket, relativeVolume, safeSupports, safeResistances),
    news: newsResult.status === 'fulfilled' ? newsResult.value : [],
    offExchange,
    warnings,
  };
}
