'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  ChevronDown,
  Circle,
  Clock3,
  ExternalLink,
  Gauge,
  Layers3,
  Menu,
  Minus,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Tone = 'bullish' | 'bearish' | 'neutral';

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

type SymbolData = {
  symbol: string; name: string; price: string; change: string; gap: string;
  volume: string; relativeVolume: string; range: string; tone: Tone; score: number;
  read: string; callWall: string; putWall: string; maxPain: string; expectedMove: string;
  supports: string[]; resistances: string[]; pivot: string; vwap: string;
  thesis: string; bullCase: string; bearCase: string; invalidate: string;
};

const initialWatchlist: SymbolData[] = [
  {
    symbol: 'NVDA', name: 'NVIDIA Corp.', price: '$188.24', change: '+2.84%', gap: '+2.1%', volume: '1.82M', relativeVolume: '2.4×', range: '$183.10–$189.45', tone: 'bullish', score: 72,
    read: 'Constructive above the opening pivot', callWall: '$195', putWall: '$180', maxPain: '$185', expectedMove: '±$7.30', supports: ['$185.60', '$182.90', '$180.00'], resistances: ['$189.50', '$192.20', '$195.00'], pivot: '$187.10', vwap: '$186.42',
    thesis: 'Premarket buyers are holding above yesterday’s value area while semis trade firm. The cleanest setup is patience above the pivot—not chasing the gap.', bullCase: 'Hold $187.10, reclaim $189.50, then look for acceptance toward $192.20.', bearCase: 'Lose $185.60 on volume and the gap-fill path opens toward $182.90.', invalidate: 'No long thesis below $185.60; no short thesis after acceptance above $189.50.',
  },
  {
    symbol: 'TSLA', name: 'Tesla, Inc.', price: '$421.37', change: '-1.16%', gap: '-0.8%', volume: '934K', relativeVolume: '1.7×', range: '$417.80–$429.10', tone: 'bearish', score: 38,
    read: 'Weak below prior-day value', callWall: '$440', putWall: '$410', maxPain: '$425', expectedMove: '±$16.80', supports: ['$417.80', '$412.50', '$410.00'], resistances: ['$425.00', '$429.10', '$440.00'], pivot: '$423.80', vwap: '$424.65',
    thesis: 'Sellers are defending the prior close and the tape remains headline-sensitive. Favor confirmation at extremes instead of trading the middle of the overnight range.', bullCase: 'Reclaim $425.00 and hold for a squeeze through $429.10.', bearCase: 'Reject $423.80, then target the premarket low and $412.50.', invalidate: 'Avoid shorts above $425.00; avoid longs if $417.80 fails cleanly.',
  },
  {
    symbol: 'META', name: 'Meta Platforms', price: '$713.08', change: '+0.62%', gap: '+0.4%', volume: '286K', relativeVolume: '1.2×', range: '$706.20–$716.40', tone: 'neutral', score: 56,
    read: 'Balanced; waiting for range expansion', callWall: '$725', putWall: '$700', maxPain: '$710', expectedMove: '±$18.40', supports: ['$706.20', '$702.40', '$700.00'], resistances: ['$716.40', '$720.00', '$725.00'], pivot: '$711.50', vwap: '$710.84',
    thesis: 'The overnight range is compressed and options positioning is balanced. Let price leave the range before assigning direction.', bullCase: 'Acceptance over $716.40 creates room toward $720 and the call wall.', bearCase: 'Failure at $711.50 followed by a break of $706.20 targets $702.40.', invalidate: 'Stand down while price rotates between $706.20 and $716.40.',
  },
  {
    symbol: 'AMD', name: 'Advanced Micro Devices', price: '$164.92', change: '+1.48%', gap: '+1.1%', volume: '742K', relativeVolume: '1.9×', range: '$161.70–$166.30', tone: 'bullish', score: 67,
    read: 'Relative strength with sector support', callWall: '$170', putWall: '$155', maxPain: '$162.50', expectedMove: '±$6.10', supports: ['$162.50', '$160.80', '$155.00'], resistances: ['$166.30', '$168.00', '$170.00'], pivot: '$163.90', vwap: '$163.32',
    thesis: 'AMD is participating in the semiconductor bid with improving premarket volume. It still needs to clear the overnight high to prove momentum.', bullCase: 'Hold $163.90 and clear $166.30 for continuation toward $168–$170.', bearCase: 'A failed breakout and loss of $162.50 favors mean reversion to $160.80.', invalidate: 'Long setup invalid below $162.50; short setup invalid above $166.30.',
  },
  {
    symbol: 'SPY', name: 'SPDR S&P 500 ETF', price: '$662.14', change: '+0.21%', gap: '+0.1%', volume: '1.14M', relativeVolume: '0.9×', range: '$659.80–$663.05', tone: 'neutral', score: 51,
    read: 'Index pinned near weekly max pain', callWall: '$665', putWall: '$655', maxPain: '$660', expectedMove: '±$5.20', supports: ['$659.80', '$657.20', '$655.00'], resistances: ['$663.05', '$665.00', '$667.40'], pivot: '$661.20', vwap: '$660.72',
    thesis: 'Index futures are quiet and price is near a high-gamma zone. Expect chop until price proves acceptance outside the overnight range.', bullCase: 'Hold $661.20 and clear $663.05 for a measured push to $665.', bearCase: 'Lose $659.80 and target $657.20, with $655 as the larger magnet.', invalidate: 'Directional conviction stays low inside $659.80–$663.05.',
  },
];

const news = [
  { time: '8:12 AM', source: 'Reuters', headline: 'Chipmakers edge higher as AI infrastructure demand remains in focus', impact: 'Sector tailwind' },
  { time: '7:46 AM', source: 'MarketWatch', headline: 'Index futures steady ahead of services data and Fed speakers', impact: 'Macro watch' },
  { time: 'Yesterday', source: 'Company filing', headline: 'Management discloses scheduled investor conference appearance', impact: 'Low impact' },
];

const darkPool = [
  { date: 'Sep 02', price: '$185.72', shares: '1.84M', value: '$341.7M', relation: 'Below spot' },
  { date: 'Sep 01', price: '$181.48', shares: '924K', value: '$167.7M', relation: 'Support zone' },
  { date: 'Aug 31', price: '$190.05', shares: '711K', value: '$135.1M', relation: 'Overhead' },
];

function DirectionIcon({ tone }: { tone: Tone }) {
  if (tone === 'bullish') return <ArrowUpRight className="size-4" />;
  if (tone === 'bearish') return <ArrowDownRight className="size-4" />;
  return <Minus className="size-4" />;
}

function MiniChart({ tone }: { tone: Tone }) {
  const bullish = tone === 'bullish';
  const bearish = tone === 'bearish';
  const line = bullish ? 'M2 35 L14 31 L25 33 L38 24 L51 27 L65 19 L80 21 L94 10 L108 13 L128 4' : bearish ? 'M2 8 L16 13 L29 10 L42 20 L56 18 L70 26 L84 23 L99 34 L113 30 L128 38' : 'M2 25 L15 19 L29 23 L43 14 L57 21 L71 18 L85 26 L99 17 L113 20 L128 16';
  const color = bullish ? '#e9a23b' : bearish ? '#ef6f6c' : '#7693b4';
  return (
    <svg viewBox="0 0 130 42" className="h-11 w-full" role="img" aria-label={`${tone} premarket price trace`}>
      <defs><linearGradient id={`fill-${tone}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".24" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={`${line} L128 42 L2 42 Z`} fill={`url(#fill-${tone})`} />
    </svg>
  );
}

export default function PreMarketPage() {
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const [selected, setSelected] = useState('NVDA');
  const [tickerInput, setTickerInput] = useState('');
  const [mobileWatchlist, setMobileWatchlist] = useState(false);
  const active = useMemo(() => watchlist.find((item) => item.symbol === selected) ?? watchlist[0], [watchlist, selected]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: WebModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = context.registerTool({
      name: 'add_or_select_watchlist_symbol',
      title: 'Open watchlist symbol',
      description: 'Select an existing ticker in the visible pre-market brief, or add a sample profile when the ticker is not present.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string', minLength: 1, maxLength: 6, pattern: '^[A-Za-z.-]+$' } },
        required: ['symbol'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const value = input as { symbol?: unknown };
        if (typeof value.symbol !== 'string') throw new Error('A valid ticker symbol is required.');
        const symbol = value.symbol.trim().toUpperCase();
        if (!/^[A-Z.-]{1,6}$/.test(symbol)) throw new Error('Ticker must contain 1–6 letters, periods, or hyphens.');
        setWatchlist((items) => items.some((item) => item.symbol === symbol) ? items : [{ ...initialWatchlist[2], symbol, name: 'Sample market profile' }, ...items]);
        setSelected(symbol);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return { symbol, status: 'selected', profile: initialWatchlist.some((item) => item.symbol === symbol) ? 'watchlist' : 'sample' };
      },
    }, { signal: lifecycle.signal });
    void Promise.resolve(register).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  function addTicker(event: FormEvent) {
    event.preventDefault();
    const symbol = tickerInput.trim().toUpperCase().replace(/[^A-Z.-]/g, '').slice(0, 6);
    if (!symbol) return;
    const existing = watchlist.find((item) => item.symbol === symbol);
    if (existing) { setSelected(existing.symbol); setTickerInput(''); return; }
    setWatchlist((items) => [{ ...initialWatchlist[2], symbol, name: 'Sample market profile' }, ...items]);
    setSelected(symbol); setTickerInput('');
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#071019]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
          <button className="grid size-9 place-items-center rounded-lg border border-white/10 text-slate-300 lg:hidden" onClick={() => setMobileWatchlist((value) => !value)} aria-label="Toggle watchlist"><Menu className="size-5" /></button>
          <a href="/pre-market" className="flex items-center gap-2.5" aria-label="TradeYodha pre-market home"><span className="grid size-8 place-items-center rounded-lg border border-amber-300/30 bg-amber-300/10 text-sm font-bold text-amber-300">Y</span><span className="text-[15px] font-semibold tracking-[0.01em] text-white">TradeYodha</span></a>
          <span className="hidden h-5 w-px bg-white/10 sm:block" /><span className="hidden text-sm text-slate-400 sm:block">Pre-market Brief</span>
          <div className="ml-auto flex items-center gap-2 sm:gap-4">
            <div className="hidden items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/8 px-3 py-1.5 text-xs font-medium text-emerald-300 md:flex"><span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-300 opacity-50" /><span className="relative inline-flex size-2 rounded-full bg-emerald-400" /></span>Data synced · 8:47:12 AM ET</div>
            <Button variant="ghost" size="icon" className="text-slate-400 hover:bg-white/5 hover:text-white" aria-label="Notifications"><Bell className="size-4" /></Button>
            <Button variant="ghost" className="gap-2 px-2 text-slate-300 hover:bg-white/5 hover:text-white"><span className="grid size-7 place-items-center rounded-full bg-[#172536] text-xs font-semibold">AJ</span><ChevronDown className="hidden size-3.5 sm:block" /></Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className={`${mobileWatchlist ? 'block' : 'hidden'} border-b border-white/8 bg-[#09131d] lg:sticky lg:top-16 lg:block lg:h-[calc(100vh-4rem)] lg:border-b-0 lg:border-r`}>
          <div className="flex h-full flex-col">
            <div className="border-b border-white/8 p-4">
              <div className="mb-3 flex items-center justify-between"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Watchlist</p><p className="mt-1 text-xs text-slate-400">{watchlist.length} symbols tracked</p></div><Button variant="ghost" size="icon" className="size-8 text-slate-500 hover:bg-white/5 hover:text-white" aria-label="Watchlist settings"><Layers3 className="size-4" /></Button></div>
              <form className="relative" onSubmit={addTicker}><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" /><Input value={tickerInput} onChange={(event) => setTickerInput(event.target.value)} placeholder="Add ticker" aria-label="Add ticker to watchlist" className="h-9 border-white/10 bg-white/[0.035] pl-9 pr-9 text-sm uppercase text-white placeholder:normal-case placeholder:text-slate-600 focus-visible:border-amber-300/40 focus-visible:ring-amber-300/20" /><button type="submit" className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-slate-500 hover:bg-white/5 hover:text-amber-300" aria-label="Add ticker"><Plus className="size-3.5" /></button></form>
            </div>
            <div className="flex gap-2 overflow-x-auto p-2 lg:block lg:overflow-y-auto">
              {watchlist.map((item) => (
                <button key={item.symbol} onClick={() => { setSelected(item.symbol); setMobileWatchlist(false); }} className={`group min-w-[190px] rounded-lg border px-3 py-3 text-left transition lg:mb-1 lg:w-full lg:min-w-0 ${selected === item.symbol ? 'border-amber-300/25 bg-amber-300/[0.07]' : 'border-transparent hover:border-white/5 hover:bg-white/[0.025]'}`}>
                  <div className="flex items-start justify-between"><div><span className="text-sm font-semibold text-slate-100">{item.symbol}</span><p className="mt-0.5 max-w-[125px] truncate text-[11px] text-slate-500">{item.name}</p></div><span className={`flex items-center text-xs font-medium ${item.tone === 'bullish' ? 'text-emerald-400' : item.tone === 'bearish' ? 'text-rose-400' : 'text-slate-400'}`}><DirectionIcon tone={item.tone} />{item.change}</span></div>
                  <div className="mt-2 flex items-end justify-between gap-3"><span className="font-mono text-sm text-slate-300">{item.price}</span><div className="w-16"><MiniChart tone={item.tone} /></div></div>
                </button>
              ))}
            </div>
            <div className="mt-auto hidden border-t border-white/8 p-4 lg:block"><p className="flex items-center gap-2 text-xs text-slate-500"><ShieldAlert className="size-3.5" /> Sample data · Prototype only</p></div>
          </div>
        </aside>

        <section className="min-w-0 bg-[radial-gradient(circle_at_52%_-10%,rgba(27,70,94,.24),transparent_32%)]">
          <div className="mx-auto max-w-[1340px] p-4 sm:p-6 xl:p-8">
            <div className="mb-6 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
              <div><div className="mb-2 flex items-center gap-2 text-xs text-slate-500"><Clock3 className="size-3.5" /> Thursday, September 3 · Market opens in <span className="font-mono text-amber-300">00:42:18</span></div><div className="flex flex-wrap items-end gap-x-4 gap-y-2"><h1 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">{active.symbol}</h1><span className="pb-1 text-sm text-slate-500">{active.name}</span><span className="pb-0.5 font-mono text-xl text-slate-100">{active.price}</span><span className={`mb-1 flex items-center gap-1 text-sm font-medium ${active.tone === 'bullish' ? 'text-emerald-400' : active.tone === 'bearish' ? 'text-rose-400' : 'text-slate-400'}`}><DirectionIcon tone={active.tone} />{active.change} pre-market</span></div></div>
              <Tabs defaultValue="brief" className="w-fit"><TabsList className="h-9 border border-white/8 bg-white/[0.025] p-1 text-slate-500"><TabsTrigger value="brief" className="px-4 text-xs data-[state=active]:bg-white/8 data-[state=active]:text-white">Brief</TabsTrigger><TabsTrigger value="chart" className="px-4 text-xs data-[state=active]:bg-white/8 data-[state=active]:text-white">Chart</TabsTrigger><TabsTrigger value="options" className="px-4 text-xs data-[state=active]:bg-white/8 data-[state=active]:text-white">Options</TabsTrigger></TabsList></Tabs>
            </div>

            <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ['Gap', active.gap, 'vs. prior close', ArrowUpRight], ['Premarket volume', active.volume, `${active.relativeVolume} relative`, Gauge], ['Overnight range', active.range, 'high / low', Layers3], ['Expected move', active.expectedMove, 'weekly options', Target],
              ].map(([label, value, detail, Icon]) => { const MetricIcon = Icon as typeof ArrowUpRight; return <div key={String(label)} className="panel flex min-h-24 items-start justify-between p-4"><div><p className="metric-label">{String(label)}</p><p className="mt-2 font-mono text-lg font-medium text-white">{String(value)}</p><p className="mt-1 text-xs text-slate-500">{String(detail)}</p></div><MetricIcon className="size-4 text-slate-600" /></div>; })}
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
              <div className="space-y-4">
                <article className="panel overflow-hidden">
                  <div className="panel-header"><div><p className="section-kicker">Positioning</p><h2 className="section-title">Options pressure map</h2></div><span className="status-pill"><Circle className="size-2 fill-current" /> Sep 04 expiry</span></div>
                  <div className="grid divide-y divide-white/8 sm:grid-cols-4 sm:divide-x sm:divide-y-0">{[['Call wall', active.callWall, 'Largest call OI', 'text-rose-300'], ['Max pain', active.maxPain, 'Expiry magnet', 'text-amber-300'], ['Put wall', active.putWall, 'Largest put OI', 'text-emerald-300'], ['Put / call', '0.82', 'Open interest', 'text-slate-100']].map(([label, value, detail, color]) => <div key={label} className="p-4 sm:p-5"><p className="metric-label">{label}</p><p className={`mt-3 font-mono text-2xl font-semibold ${color}`}>{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>)}</div>
                  <div className="border-t border-white/8 px-5 py-4"><div className="relative h-12"><div className="absolute left-0 right-0 top-5 h-1 rounded-full bg-gradient-to-r from-emerald-400/70 via-amber-300/70 to-rose-400/70" /><div className="absolute left-[29%] top-2 text-center"><span className="block h-7 w-px bg-emerald-300" /><span className="text-[10px] text-emerald-300">PUT</span></div><div className="absolute left-[54%] top-2 text-center"><span className="block h-7 w-px bg-amber-300" /><span className="text-[10px] text-amber-300">SPOT</span></div><div className="absolute left-[78%] top-2 text-center"><span className="block h-7 w-px bg-rose-300" /><span className="text-[10px] text-rose-300">CALL</span></div></div></div>
                </article>

                <article className="panel">
                  <div className="panel-header"><div><p className="section-kicker">Trade map</p><h2 className="section-title">Levels that matter</h2></div><span className="text-xs text-slate-500">Prior day + premarket structure</span></div>
                  <div className="grid gap-0 sm:grid-cols-[1fr_132px_1fr]"><div className="space-y-2 p-5"><p className="metric-label mb-3 text-rose-300/80">Resistance</p>{active.resistances.slice().reverse().map((level, index) => <div key={level} className="level-row"><span>R{3 - index}</span><strong>{level}</strong></div>)}</div><div className="flex flex-row items-center justify-around border-y border-white/8 bg-white/[0.018] px-4 py-5 sm:flex-col sm:border-x sm:border-y-0"><div className="text-center"><p className="metric-label">Pivot</p><p className="mt-1 font-mono text-sm text-amber-300">{active.pivot}</p></div><div className="hidden h-8 w-px bg-white/8 sm:block" /><div className="text-center"><p className="metric-label">Prev. VWAP</p><p className="mt-1 font-mono text-sm text-slate-200">{active.vwap}</p></div></div><div className="space-y-2 p-5"><p className="metric-label mb-3 text-emerald-300/80">Support</p>{active.supports.map((level, index) => <div key={level} className="level-row"><span>S{index + 1}</span><strong>{level}</strong></div>)}</div></div>
                </article>

                <article className="panel">
                  <div className="panel-header"><div><p className="section-kicker">Off-exchange prints</p><h2 className="section-title">Dark pool activity · 3 days</h2></div><Button variant="ghost" size="sm" className="gap-1.5 text-xs text-slate-500 hover:bg-white/5 hover:text-white">Methodology <ExternalLink className="size-3" /></Button></div>
                  <div className="overflow-x-auto"><table className="w-full min-w-[580px] text-left text-sm"><thead className="border-b border-white/8 bg-white/[0.015] text-[10px] uppercase tracking-[0.12em] text-slate-600"><tr>{['Date', 'Avg. print', 'Shares', 'Notional', 'Context'].map((label) => <th key={label} className="px-5 py-3 font-semibold">{label}</th>)}</tr></thead><tbody>{darkPool.map((row) => <tr key={row.date} className="border-b border-white/5 last:border-0"><td className="px-5 py-3.5 text-slate-400">{row.date}</td><td className="px-5 py-3.5 font-mono text-slate-200">{row.price}</td><td className="px-5 py-3.5 font-mono text-slate-300">{row.shares}</td><td className="px-5 py-3.5 font-mono text-slate-300">{row.value}</td><td className="px-5 py-3.5"><span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-1 text-xs text-slate-400">{row.relation}</span></td></tr>)}</tbody></table></div>
                </article>
              </div>

              <div className="space-y-4">
                <article className="panel border-amber-300/15 bg-[linear-gradient(145deg,rgba(233,162,59,.075),rgba(12,25,37,.82)_38%)]">
                  <div className="panel-header"><div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-amber-300/10 text-amber-300"><Sparkles className="size-4" /></span><div><p className="section-kicker">Yodha read</p><h2 className="section-title">Day-trade thesis</h2></div></div><span className={`score-badge ${active.tone}`}>{active.score}/100</span></div>
                  <div className="p-5"><div className="mb-4 flex items-center gap-2"><span className={`tone-dot ${active.tone}`} /><p className="text-sm font-medium text-slate-200">{active.read}</p></div><p className="text-sm leading-6 text-slate-400">{active.thesis}</p><div className="mt-5 space-y-3"><div className="thesis-row bull"><ArrowUpRight /><div><span>Bull case</span><p>{active.bullCase}</p></div></div><div className="thesis-row bear"><ArrowDownRight /><div><span>Bear case</span><p>{active.bearCase}</p></div></div><div className="thesis-row neutral"><ShieldAlert /><div><span>Invalidation</span><p>{active.invalidate}</p></div></div></div></div>
                </article>

                <article className="panel">
                  <div className="panel-header"><div><p className="section-kicker">Catalysts</p><h2 className="section-title">News to know</h2></div><Zap className="size-4 text-slate-600" /></div>
                  <div className="divide-y divide-white/8">{news.map((item) => <button key={item.headline} className="block w-full p-5 text-left transition hover:bg-white/[0.02]"><div className="mb-2 flex items-center justify-between gap-3"><span className="text-[11px] text-slate-500">{item.time} · {item.source}</span><ExternalLink className="size-3 text-slate-700" /></div><p className="text-sm leading-5 text-slate-300">{item.headline}</p><span className="mt-3 inline-flex rounded-full bg-sky-300/[0.06] px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-sky-300/70">{item.impact}</span></button>)}</div>
                </article>
                <div className="rounded-xl border border-white/8 bg-white/[0.018] p-4 text-xs leading-5 text-slate-600">Prototype data is illustrative and delayed. TradeYodha provides market context, not financial advice or trade signals.</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
