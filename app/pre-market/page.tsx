'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Circle,
  Clock3,
  ExternalLink,
  Gauge,
  Layers3,
  Menu,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Target,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { MarketBrief, MarketTone, WatchlistQuote, WatchlistResponse } from '@/lib/market-types';

const DEFAULT_SYMBOLS = ['NVDA', 'TSLA', 'META', 'AMD', 'SPY'];
const WATCHLIST_KEY = 'tradeyodha.watchlist.v1';

type WebModelContext = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => Promise<object>;
    },
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};

function price(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value >= 1000 ? 2 : 2 }).format(value);
}

function percent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function compact(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function dateLabel(value: string | null | undefined, includeDate = false) {
  if (!value) return 'Waiting for data';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function sessionLabel(status: string | undefined) {
  if (status === 'early_trading') return 'Pre-market';
  if (status === 'open') return 'Market open';
  if (status === 'late_trading') return 'After hours';
  if (status === 'closed') return 'Market closed';
  return 'Market data';
}

function toneFromChange(change: number | null | undefined): MarketTone {
  if (change !== null && change !== undefined && change >= 0.6) return 'bullish';
  if (change !== null && change !== undefined && change <= -0.6) return 'bearish';
  return 'neutral';
}

function DirectionIcon({ tone }: { tone: MarketTone }) {
  if (tone === 'bullish') return <ArrowUpRight className="size-4" />;
  if (tone === 'bearish') return <ArrowDownRight className="size-4" />;
  return <Minus className="size-4" />;
}

function QuoteTrace({ change }: { change: number | null }) {
  const tone = toneFromChange(change);
  const line = tone === 'bullish'
    ? 'M2 34 L14 30 L25 32 L38 24 L51 27 L65 19 L80 21 L94 10 L108 13 L128 5'
    : tone === 'bearish'
      ? 'M2 8 L16 13 L29 10 L42 20 L56 18 L70 26 L84 23 L99 34 L113 30 L128 38'
      : 'M2 25 L15 19 L29 23 L43 14 L57 21 L71 18 L85 26 L99 17 L113 20 L128 16';
  const color = tone === 'bullish' ? '#e9a23b' : tone === 'bearish' ? '#ef6f6c' : '#7693b4';
  return <svg viewBox="0 0 130 42" className="h-10 w-16" aria-hidden="true"><path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function PremarketChart({ brief }: { brief: MarketBrief }) {
  const values = brief.premarket.bars.map((bar) => bar.close);
  if (values.length < 2) return <div className="grid h-20 place-items-center text-xs text-slate-600">Premarket chart is forming</div>;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 300},${64 - ((value - low) / range) * 52}`).join(' ');
  const color = brief.thesis.tone === 'bearish' ? '#fb7185' : brief.thesis.tone === 'bullish' ? '#fbbf24' : '#94a3b8';
  return (
    <div className="border-t border-white/8 px-5 py-3">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-slate-600"><span>4:00 AM</span><span>Premarket 5-minute bars</span><span>9:30 AM</span></div>
      <span className="sr-only">{brief.symbol} premarket five-minute closing prices</span>
      <svg viewBox="0 0 300 68" className="h-20 w-full" aria-hidden="true" preserveAspectRatio="none">
        <defs><linearGradient id="premarket-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <polygon points={`0,68 ${points} 300,68`} fill="url(#premarket-fill)" />
      </svg>
    </div>
  );
}

function LoadingBrief() {
  return (
    <div className="space-y-4" aria-label="Loading market brief">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-24 rounded-xl bg-white/[0.045]" />)}</div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]"><div className="space-y-4"><Skeleton className="h-72 rounded-xl bg-white/[0.045]" /><Skeleton className="h-80 rounded-xl bg-white/[0.045]" /></div><Skeleton className="h-[34rem] rounded-xl bg-white/[0.045]" /></div>
    </div>
  );
}

export default function PreMarketPage() {
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS);
  const [selected, setSelected] = useState(DEFAULT_SYMBOLS[0]);
  const [quotes, setQuotes] = useState<Record<string, WatchlistQuote>>({});
  const [watchlistMeta, setWatchlistMeta] = useState<Pick<WatchlistResponse, 'feed' | 'updatedAt'> | null>(null);
  const [brief, setBrief] = useState<MarketBrief | null>(null);
  const [tickerInput, setTickerInput] = useState('');
  const [mobileWatchlist, setMobileWatchlist] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const saved = window.localStorage.getItem(WATCHLIST_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as unknown;
          if (Array.isArray(parsed)) {
            const valid = parsed.filter((value): value is string => typeof value === 'string' && /^[A-Z.-]{1,6}$/.test(value)).slice(0, 20);
            if (valid.length) { setSymbols([...new Set(valid)]); setSelected(valid[0]); }
          }
        } catch { /* Ignore damaged device-local state. */ }
      }
      setHydrated(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(symbols));
  }, [hydrated, symbols]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    async function loadWatchlist() {
      try {
        const response = await fetch(`/api/market?symbols=${encodeURIComponent(symbols.join(','))}`, { cache: 'no-store' });
        const data = await response.json() as WatchlistResponse & { error?: string };
        if (!response.ok) throw new Error(data.error || 'Watchlist data is unavailable.');
        if (!cancelled) {
          setQuotes(Object.fromEntries(data.quotes.map((quote) => [quote.symbol, quote])));
          setWatchlistMeta({ feed: data.feed, updatedAt: data.updatedAt });
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Watchlist data is unavailable.');
      }
    }
    void loadWatchlist();
    const interval = window.setInterval(loadWatchlist, 30_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [hydrated, symbols]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    async function loadBrief(background = false) {
      if (background) setRefreshing(true); else { setLoading(true); setBrief(null); }
      setError(null);
      try {
        const response = await fetch(`/api/market?symbol=${encodeURIComponent(selected)}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json() as MarketBrief & { error?: string };
        if (!response.ok) throw new Error(data.error || `No market brief is available for ${selected}.`);
        setBrief(data);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Market data is unavailable.');
      } finally {
        if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
      }
    }
    void loadBrief();
    const interval = window.setInterval(() => loadBrief(true), 60_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [hydrated, selected, refreshNonce]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: WebModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = context.registerTool({
      name: 'add_or_select_watchlist_symbol',
      title: 'Open watchlist symbol',
      description: 'Select an existing ticker in the live pre-market brief or add it to the device watchlist.',
      inputSchema: { type: 'object', properties: { symbol: { type: 'string', minLength: 1, maxLength: 6, pattern: '^[A-Za-z.-]+$' } }, required: ['symbol'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const value = input as { symbol?: unknown };
        if (typeof value.symbol !== 'string') throw new Error('A valid ticker symbol is required.');
        const symbol = value.symbol.trim().toUpperCase();
        if (!/^[A-Z.-]{1,6}$/.test(symbol)) throw new Error('Ticker must contain 1–6 letters, periods, or hyphens.');
        setSymbols((items) => items.includes(symbol) ? items : [symbol, ...items].slice(0, 20));
        setSelected(symbol);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return { symbol, status: 'selected' };
      },
    }, { signal: lifecycle.signal });
    void Promise.resolve(register).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const activeQuote = quotes[selected];
  const activeTone = brief?.thesis.tone ?? toneFromChange(activeQuote?.changePercent);
  const rangeLabel = useMemo(() => {
    if (!brief?.premarket.low || !brief.premarket.high) return '—';
    return `${price(brief.premarket.low)}–${price(brief.premarket.high)}`;
  }, [brief]);

  function addTicker(event: { preventDefault: () => void }) {
    event.preventDefault();
    const symbol = tickerInput.trim().toUpperCase().replace(/[^A-Z.-]/g, '').slice(0, 6);
    if (!symbol) return;
    setSymbols((items) => items.includes(symbol) ? items : [symbol, ...items].slice(0, 20));
    setSelected(symbol);
    setTickerInput('');
    setMobileWatchlist(false);
  }

  function removeTicker(symbol: string) {
    if (symbols.length === 1) return;
    const next = symbols.filter((item) => item !== symbol);
    setSymbols(next);
    if (selected === symbol) setSelected(next[0]);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#071019]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
          <button className="grid size-9 place-items-center rounded-lg border border-white/10 text-slate-300 lg:hidden" onClick={() => setMobileWatchlist((value) => !value)} aria-label="Toggle watchlist"><Menu className="size-5" /></button>
          <Link href="/pre-market" className="flex items-center gap-2.5" aria-label="TradeYodha pre-market home"><span className="grid size-8 place-items-center rounded-lg border border-amber-300/30 bg-amber-300/10 text-sm font-bold text-amber-300">Y</span><span className="text-[15px] font-semibold tracking-[0.01em] text-white">TradeYodha</span></Link>
          <span className="hidden h-5 w-px bg-white/10 sm:block" /><span className="hidden text-sm text-slate-400 sm:block">Pre-market Brief</span>
          <div className="ml-auto flex items-center gap-3">
            <div className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium md:flex ${watchlistMeta?.feed === 'real-time' ? 'border-emerald-400/20 bg-emerald-400/8 text-emerald-300' : 'border-amber-300/20 bg-amber-300/[0.06] text-amber-200'}`}><span className="relative flex size-2"><span className={`relative inline-flex size-2 rounded-full ${watchlistMeta?.feed === 'real-time' ? 'bg-emerald-400' : 'bg-amber-300'}`} /></span>Massive · {watchlistMeta?.feed === 'real-time' ? 'Real-time' : '15-min delayed'}</div>
            <span className="hidden text-xs text-slate-600 sm:block">Updated {dateLabel(watchlistMeta?.updatedAt)}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className={`${mobileWatchlist ? 'block' : 'hidden'} border-b border-white/8 bg-[#09131d] lg:sticky lg:top-16 lg:block lg:h-[calc(100vh-4rem)] lg:border-b-0 lg:border-r`}>
          <div className="flex h-full flex-col">
            <div className="border-b border-white/8 p-4">
              <div className="mb-3"><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Watchlist</p><p className="mt-1 text-xs text-slate-400">{symbols.length} symbols · saved on this device</p></div>
              <form className="relative" onSubmit={addTicker}><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" /><Input value={tickerInput} onChange={(event) => setTickerInput(event.target.value)} placeholder="Add ticker" aria-label="Add ticker to watchlist" className="h-9 border-white/10 bg-white/[0.035] pl-9 pr-9 text-sm uppercase text-white placeholder:normal-case placeholder:text-slate-600 focus-visible:border-amber-300/40 focus-visible:ring-amber-300/20" /><button type="submit" className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-slate-500 hover:bg-white/5 hover:text-amber-300" aria-label="Add ticker"><Plus className="size-3.5" /></button></form>
            </div>
            <div className="flex gap-2 overflow-x-auto p-2 lg:block lg:overflow-y-auto">
              {symbols.map((symbol) => {
                const quote = quotes[symbol];
                const tone = toneFromChange(quote?.changePercent);
                return (
                  <div key={symbol} className={`group relative min-w-[190px] rounded-lg border transition lg:mb-1 lg:w-full lg:min-w-0 ${selected === symbol ? 'border-amber-300/25 bg-amber-300/[0.07]' : 'border-transparent hover:border-white/5 hover:bg-white/[0.025]'}`}>
                    <button onClick={() => { setSelected(symbol); setMobileWatchlist(false); }} className="w-full px-3 py-3 text-left">
                      <div className="flex items-start justify-between pr-5"><span className="text-sm font-semibold text-slate-100">{symbol}</span><span className={`flex items-center text-xs font-medium ${tone === 'bullish' ? 'text-emerald-400' : tone === 'bearish' ? 'text-rose-400' : 'text-slate-400'}`}><DirectionIcon tone={tone} />{percent(quote?.changePercent)}</span></div>
                      <div className="mt-1 flex items-center justify-between gap-3"><span className="font-mono text-sm text-slate-300">{price(quote?.price)}</span><QuoteTrace change={quote?.changePercent ?? null} /></div>
                    </button>
                    {symbols.length > 1 && <button onClick={() => removeTicker(symbol)} className="absolute right-2 top-2 grid size-6 place-items-center rounded text-slate-700 opacity-0 transition hover:bg-white/5 hover:text-rose-300 group-hover:opacity-100 focus:opacity-100" aria-label={`Remove ${symbol} from watchlist`}><Trash2 className="size-3" /></button>}
                  </div>
                );
              })}
            </div>
            <div className="mt-auto hidden border-t border-white/8 p-4 lg:block"><p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> Market context only. Not financial advice.</p></div>
          </div>
        </aside>

        <section className="min-w-0 bg-[radial-gradient(circle_at_52%_-10%,rgba(27,70,94,.24),transparent_32%)]">
          <div className="mx-auto max-w-[1340px] p-4 sm:p-6 xl:p-8">
            <div className="mb-6 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs text-slate-500"><Clock3 className="size-3.5" />{sessionLabel(brief?.marketStatus ?? activeQuote?.marketStatus)} · as of {dateLabel(brief?.updatedAt ?? activeQuote?.updatedAt, true)}</div>
                <div className="flex flex-wrap items-end gap-x-4 gap-y-2"><h1 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">{selected}</h1>{brief?.name && <span className="pb-1 text-sm text-slate-500">{brief.name}</span>}<span className="pb-0.5 font-mono text-xl text-slate-100">{price(brief?.price ?? activeQuote?.price)}</span><span className={`mb-1 flex items-center gap-1 text-sm font-medium ${activeTone === 'bullish' ? 'text-emerald-400' : activeTone === 'bearish' ? 'text-rose-400' : 'text-slate-400'}`}><DirectionIcon tone={activeTone} />{percent(brief?.changePercent ?? activeQuote?.changePercent)}</span></div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setRefreshNonce((value) => value + 1)} disabled={refreshing || loading} className="w-fit gap-2 border-white/10 bg-white/[0.025] text-xs text-slate-400 hover:bg-white/5 hover:text-white"><RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />Refresh</Button>
            </div>

            {error && <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200"><AlertCircle className="mt-0.5 size-4 shrink-0" /><div><p className="font-medium">Market data could not be refreshed</p><p className="mt-1 text-xs leading-5 text-rose-200/70">{error}</p></div></div>}

            {loading || !brief ? <LoadingBrief /> : <>
              <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  ['Gap', percent(brief.changePercent), 'vs. prior close', ArrowUpRight],
                  ['Premarket volume', compact(brief.premarket.volume), brief.premarket.relativeVolume ? `${brief.premarket.relativeVolume.toFixed(1)}× recent pace` : 'relative pace forming', Gauge],
                  ['Overnight range', rangeLabel, '4:00–9:30 AM ET', Layers3],
                  ['Expected move', brief.options.expectedMove ? `±${price(brief.options.expectedMove)}` : '—', brief.options.expiration ? `through ${brief.options.expiration}` : 'options unavailable', Target],
                ].map(([label, value, detail, Icon]) => { const MetricIcon = Icon as typeof ArrowUpRight; return <div key={String(label)} className="panel flex min-h-24 items-start justify-between p-4"><div><p className="metric-label">{String(label)}</p><p className="mt-2 font-mono text-lg font-medium text-white">{String(value)}</p><p className="mt-1 text-xs text-slate-500">{String(detail)}</p></div><MetricIcon className="size-4 text-slate-600" /></div>; })}
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
                <div className="space-y-4">
                  <article className="panel overflow-hidden">
                    <div className="panel-header"><div><p className="section-kicker">Positioning</p><h2 className="section-title">Options pressure map</h2></div>{brief.options.expiration && <span className="status-pill"><Circle className="size-2 fill-current" /> {brief.options.expiration} expiry</span>}</div>
                    {brief.options.available ? <>
                      <div className="grid divide-y divide-white/8 sm:grid-cols-4 sm:divide-x sm:divide-y-0">{[
                        ['Call wall', price(brief.options.callWall), 'Largest call OI', 'text-rose-300'],
                        ['Max pain', price(brief.options.maxPain), 'Minimum expiry payout', 'text-amber-300'],
                        ['Put wall', price(brief.options.putWall), 'Largest put OI', 'text-emerald-300'],
                        ['Put / call', brief.options.putCallRatio?.toFixed(2) ?? '—', `${brief.options.contractCount} contracts`, 'text-slate-100'],
                      ].map(([label, value, detail, color]) => <div key={label} className="p-4 sm:p-5"><p className="metric-label">{label}</p><p className={`mt-3 font-mono text-2xl font-semibold ${color}`}>{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>)}</div>
                      <PremarketChart brief={brief} />
                      {brief.options.message && <p className="border-t border-white/8 px-5 py-3 text-xs text-slate-600">{brief.options.message}</p>}
                    </> : <div className="flex items-start gap-3 p-5 text-sm text-slate-400"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" /><div><p className="font-medium text-slate-300">Options positioning unavailable</p><p className="mt-1 text-xs leading-5 text-slate-500">{brief.options.message}</p></div></div>}
                  </article>

                  <article className="panel">
                    <div className="panel-header"><div><p className="section-kicker">Trade map</p><h2 className="section-title">Levels that matter</h2></div><span className="text-xs text-slate-500">Premarket + prior session</span></div>
                    <div className="grid gap-0 sm:grid-cols-[1fr_132px_1fr]"><div className="space-y-2 p-5"><p className="metric-label mb-3 text-rose-300/80">Resistance</p>{brief.levels.resistances.slice().reverse().map((level, index, levels) => <div key={level} className="level-row"><span>R{levels.length - index}</span><strong>{price(level)}</strong></div>)}</div><div className="flex flex-row items-center justify-around border-y border-white/8 bg-white/[0.018] px-4 py-5 sm:flex-col sm:border-x sm:border-y-0"><div className="text-center"><p className="metric-label">Pivot</p><p className="mt-1 font-mono text-sm text-amber-300">{price(brief.levels.pivot)}</p></div><div className="hidden h-8 w-px bg-white/8 sm:block" /><div className="text-center"><p className="metric-label">Prev. VWAP</p><p className="mt-1 font-mono text-sm text-slate-200">{price(brief.levels.previousVwap)}</p></div></div><div className="space-y-2 p-5"><p className="metric-label mb-3 text-emerald-300/80">Support</p>{brief.levels.supports.map((level, index) => <div key={level} className="level-row"><span>S{index + 1}</span><strong>{price(level)}</strong></div>)}</div></div>
                  </article>

                  <article className="panel">
                    <div className="panel-header"><div><p className="section-kicker">FINRA trade reporting facilities</p><h2 className="section-title">Off-exchange activity · 3 sessions</h2></div><span className="status-pill">Massive TRF data</span></div>
                    {brief.offExchange.available ? <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-b border-white/8 bg-white/[0.015] text-[10px] uppercase tracking-[0.12em] text-slate-600"><tr>{['Date', 'Avg. price', 'Shares', 'Notional', 'Prints'].map((label) => <th key={label} className="px-5 py-3 font-semibold">{label}</th>)}</tr></thead><tbody>{brief.offExchange.rows.map((row) => <tr key={row.date} className="border-b border-white/5 last:border-0"><td className="px-5 py-3.5 text-slate-400">{row.date}</td><td className="px-5 py-3.5 font-mono text-slate-200">{price(row.averagePrice)}</td><td className="px-5 py-3.5 font-mono text-slate-300">{compact(row.shares)}</td><td className="px-5 py-3.5 font-mono text-slate-300">{price(row.notional)}</td><td className="px-5 py-3.5 font-mono text-slate-300">{compact(row.printCount)}</td></tr>)}</tbody></table>{brief.offExchange.message && <p className="border-t border-white/8 px-5 py-3 text-xs text-slate-600">{brief.offExchange.message}</p>}</div> : <div className="flex items-start gap-3 p-5"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" /><div><p className="text-sm font-medium text-slate-300">TRF history needs a higher Massive entitlement</p><p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">{brief.offExchange.message} Consolidated TRF records indicate off-exchange reporting; they do not identify a specific dark-pool venue.</p></div></div>}
                  </article>
                </div>

                <div className="space-y-4">
                  <article className="panel border-amber-300/15 bg-[linear-gradient(145deg,rgba(233,162,59,.075),rgba(12,25,37,.82)_38%)]">
                    <div className="panel-header"><div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-amber-300/10 text-amber-300"><Sparkles className="size-4" /></span><div><p className="section-kicker">Structured market read</p><h2 className="section-title">Day-trade thesis</h2></div></div><span className={`score-badge ${brief.thesis.tone}`}>{brief.thesis.score}/100</span></div>
                    <div className="p-5"><div className="mb-4 flex items-center gap-2"><span className={`tone-dot ${brief.thesis.tone}`} /><p className="text-sm font-medium text-slate-200">{brief.thesis.read}</p></div><p className="text-sm leading-6 text-slate-400">{brief.thesis.summary}</p><div className="mt-5 space-y-3"><div className="thesis-row bull"><ArrowUpRight /><div><span>Bull case</span><p>{brief.thesis.bullCase}</p></div></div><div className="thesis-row bear"><ArrowDownRight /><div><span>Bear case</span><p>{brief.thesis.bearCase}</p></div></div><div className="thesis-row neutral"><ShieldAlert /><div><span>Invalidation</span><p>{brief.thesis.invalidation}</p></div></div></div></div>
                  </article>

                  <article className="panel">
                    <div className="panel-header"><div><p className="section-kicker">Ticker-tagged coverage</p><h2 className="section-title">News to know</h2></div><Zap className="size-4 text-slate-600" /></div>
                    {brief.news.length ? <div className="divide-y divide-white/8">{brief.news.map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="block p-5 transition hover:bg-white/[0.02]"><div className="mb-2 flex items-center justify-between gap-3"><span className="text-[11px] text-slate-500">{dateLabel(item.publishedAt, true)} · {item.publisher}</span><ExternalLink className="size-3 text-slate-700" /></div><p className="text-sm leading-5 text-slate-300">{item.title}</p>{item.sentiment && <span className={`mt-3 inline-flex rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-wider ${item.sentiment === 'positive' ? 'bg-emerald-300/[0.06] text-emerald-300/70' : item.sentiment === 'negative' ? 'bg-rose-300/[0.06] text-rose-300/70' : 'bg-sky-300/[0.06] text-sky-300/70'}`}>{item.sentiment}</span>}</a>)}</div> : <p className="p-5 text-sm text-slate-500">No recent ticker-tagged coverage was returned.</p>}
                  </article>

                  <div className="rounded-xl border border-white/8 bg-white/[0.018] p-4 text-xs leading-5 text-slate-600">Prices, bars, news, and option open interest come from Massive. Levels and the structured thesis are derived by TradeYodha. Informational only—not financial advice or a trade signal.</div>
                </div>
              </div>
            </>}
          </div>
        </section>
      </div>
    </main>
  );
}
