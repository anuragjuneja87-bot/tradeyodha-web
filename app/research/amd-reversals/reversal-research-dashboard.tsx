'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  FlaskConical,
  Gauge,
  Layers3,
  ShieldAlert,
  SlidersHorizontal,
  Target,
  Waves,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import rawAnalysis from '../../../analysis/amd-30-session-study/volume-feature-analysis.json';

type Feature = {
  key: string;
  label: string;
  count: number;
  clean15: number;
  clean30: number;
  reachedByNoon: number;
  clean15Lift: number;
  noonLift: number;
  provisionalWeight: number;
};

type Session = {
  date: string;
  setupType: string;
  outcome: { clean15: boolean; clean30: boolean; reachedByNoon: boolean; targetMinutes: number | null; maeR: number | null };
  context: {
    aboveVwap: boolean;
    positiveFromOpen: boolean;
    strongClose: boolean;
    elevatedEventVolume: boolean;
    outperformedQqq: boolean;
    positivePremarketRelativeToSmh: boolean;
    camWithin20R: boolean;
  };
  flow: {
    prior: { buyShare: number; delta: number; offExchange: number; block: number };
    cross: { buyShare: number; delta: number; offExchange: number; block: number };
    next: { buyShare: number; delta: number; offExchange: number; block: number };
    volumeAcceleration: number;
    imbalancePersistent30s: boolean;
    absorptionProxy: boolean;
    litParticipationShift: boolean;
    acceptedReclaim30Seconds: boolean;
    falseReclaim30Seconds: boolean;
    priorImbalancePct: number;
    crossImbalancePct: number;
    nextImbalancePct: number;
  };
  targetBehavior: { touchedOrbHigh: boolean; breakoutRejected5m: boolean };
};

type Analysis = {
  baseline: { clean15: number; clean30: number; noon: number };
  weightingMethod: string;
  features: Feature[];
  volumeAnalysis: {
    absorptionProxy: { count: number; clean15Pct: number; noonPct: number };
    acceptedReclaim30Seconds: { count: number; clean15Pct: number; noonPct: number };
    falseReclaim30Seconds: { count: number; clean15Pct: number; missedTargetPct: number };
    orbHighRejection: { targetTouches: number; rejectedWithinFiveMinutes: number; rejectedPct: number };
    definitions: Record<string, string>;
  };
  sessions: Session[];
};

const analysis = rawAnalysis as unknown as Analysis;

const featureAccess: Record<string, (session: Session) => boolean> = {
  aboveVwap: (session) => session.context.aboveVwap,
  positiveFromOpen: (session) => session.context.positiveFromOpen,
  strongClose: (session) => session.context.strongClose,
  elevatedEventVolume: (session) => session.context.elevatedEventVolume,
  outperformedQqq: (session) => session.context.outperformedQqq,
  buyerDominance: (session) => session.flow.cross.buyShare >= 55,
  persistentImbalance: (session) => session.flow.imbalancePersistent30s,
  absorptionProxy: (session) => session.flow.absorptionProxy,
  accepted30Seconds: (session) => session.flow.acceptedReclaim30Seconds,
  litParticipation: (session) => session.flow.litParticipationShift,
  volumeAcceleration: (session) => session.flow.volumeAcceleration >= 1.5,
  camConfluence: (session) => session.context.camWithin20R,
  premarketRelativeStrength: (session) => session.context.positivePremarketRelativeToSmh,
};

function percent(value: number) {
  return `${value.toFixed(value % 1 ? 1 : 0)}%`;
}

function setupLabel(value: string) {
  if (value === 'bottom_reversal_during_orb') return 'Bottom reversal · during ORB';
  if (value === 'bottom_reversal_post_orb') return 'Bottom reversal · post ORB';
  return 'Bullish pullback';
}

function outcomeLabel(session: Session) {
  if (session.outcome.clean15) return { label: 'Clean ≤15m', tone: 'text-emerald-300 bg-emerald-400/8 border-emerald-400/15' };
  if (session.outcome.clean30) return { label: 'Clean ≤30m', tone: 'text-cyan-300 bg-cyan-400/8 border-cyan-400/15' };
  if (session.outcome.reachedByNoon) return { label: 'Slow / rough hit', tone: 'text-amber-300 bg-amber-400/8 border-amber-400/15' };
  return { label: 'Miss', tone: 'text-rose-300 bg-rose-400/8 border-rose-400/15' };
}

function rate(rows: Session[], predicate: (session: Session) => boolean) {
  return rows.length ? (rows.filter(predicate).length / rows.length) * 100 : 0;
}

function scoreFor(session: Session, weights: Record<string, number>) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (!total) return 0;
  const earned = Object.entries(weights).reduce((sum, [key, weight]) => sum + (featureAccess[key]?.(session) ? weight : 0), 0);
  return (earned / total) * 100;
}

function Metric({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: typeof Gauge }) {
  return (
    <div className="research-panel min-h-28 p-4">
      <div className="flex items-start justify-between gap-4">
        <div><p className="research-label">{label}</p><p className="mt-2 font-mono text-2xl font-semibold text-white">{value}</p><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p></div>
        <Icon className="size-4 text-slate-600" />
      </div>
    </div>
  );
}

export function ReversalResearchDashboard() {
  const defaultWeights = useMemo(() => Object.fromEntries(analysis.features.map((feature) => [feature.key, feature.provisionalWeight])), []);
  const [weights, setWeights] = useState<Record<string, number>>(defaultWeights);
  const [threshold, setThreshold] = useState(55);
  const [selectedDate, setSelectedDate] = useState('2026-09-04');
  const scored = useMemo(() => analysis.sessions.map((session) => ({ session, score: scoreFor(session, weights) })), [weights]);
  const qualified = useMemo(() => scored.filter((row) => row.score >= threshold), [scored, threshold]);
  const qualifiedSessions = qualified.map((row) => row.session);
  const selectedSession = analysis.sessions.find((session) => session.date === selectedDate) ?? analysis.sessions.at(-1)!;
  const imbalanceData = [
    { window: 'Prior 30s', imbalance: selectedSession.flow.priorImbalancePct },
    { window: 'Reclaim ±5s', imbalance: selectedSession.flow.crossImbalancePct },
    { window: 'Next 30s', imbalance: selectedSession.flow.nextImbalancePct },
  ];

  function updateWeight(key: string, value: number) {
    setWeights((current) => ({ ...current, [key]: value }));
  }

  return (
    <main className="min-h-screen bg-[#071019] text-slate-200">
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#071019]/94 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1580px] items-center gap-4 px-4 sm:px-6">
          <Link href="/pre-market" className="grid size-9 place-items-center rounded-lg border border-white/10 text-slate-400 transition hover:border-amber-300/30 hover:text-amber-300" aria-label="Back to pre-market brief"><ArrowLeft className="size-4" /></Link>
          <div><p className="text-[15px] font-semibold text-white">AMD Reversal Lab</p><p className="text-xs text-slate-600">30 sessions · July 27–September 4, 2026</p></div>
          <div className="ml-auto flex items-center gap-2 rounded-full border border-amber-300/15 bg-amber-300/[0.055] px-3 py-1.5 text-xs text-amber-200"><FlaskConical className="size-3.5" />Exploratory weights</div>
        </div>
      </header>

      <div className="mx-auto max-w-[1580px] px-4 py-6 sm:px-6 lg:py-8">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div><p className="research-kicker">0.70 reclaim → ORB-high exit</p><h1 className="mt-1 max-w-3xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Measure the setup you actually trade.</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">Weights emphasize fast, controlled rotations—not eventual touches after large drawdowns. Change any weight or the qualification threshold to see the historical cohort update.</p></div>
          <div className="flex items-center gap-2 text-xs text-slate-500"><CircleDashed className="size-3.5" />27 exact tape windows · tick-rule direction</div>
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Qualified sessions" value={`${qualified.length} / ${analysis.sessions.length}`} detail={`Composite score ≥ ${threshold}`} icon={Target} />
          <Metric label="Clean ≤15 minutes" value={percent(rate(qualifiedSessions, (session) => session.outcome.clean15))} detail={`${qualifiedSessions.filter((session) => session.outcome.clean15).length} qualified rotations`} icon={CheckCircle2} />
          <Metric label="Reached ORB high" value={percent(rate(qualifiedSessions, (session) => session.outcome.reachedByNoon))} detail="Before 12:00 ET" icon={BarChart3} />
          <Metric label="Baseline clean rate" value={percent(analysis.baseline.clean15)} detail="All exact-tape reclaims" icon={Gauge} />
        </div>

        <Tabs defaultValue="score" className="gap-5">
          <TabsList variant="line" className="h-10 gap-4 border-b border-white/8">
            <TabsTrigger value="score" className="px-2 text-slate-500 data-active:text-amber-300"><SlidersHorizontal data-icon="inline-start" />Score model</TabsTrigger>
            <TabsTrigger value="volume" className="px-2 text-slate-500 data-active:text-amber-300"><Waves data-icon="inline-start" />Volume behavior</TabsTrigger>
            <TabsTrigger value="sessions" className="px-2 text-slate-500 data-active:text-amber-300"><Layers3 data-icon="inline-start" />Session ledger</TabsTrigger>
          </TabsList>

          <TabsContent value="score">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,.7fr)]">
              <section className="research-panel overflow-hidden">
                <div className="research-panel-header"><div><p className="research-kicker">Observed influence</p><h2 className="research-title">Feature evidence and adjustable weight</h2></div><Button variant="outline" size="sm" onClick={() => setWeights(defaultWeights)} className="border-white/10 bg-white/[0.025] text-xs text-slate-400 hover:bg-white/5 hover:text-white">Reset weights</Button></div>
                <div className="divide-y divide-white/6">
                  {analysis.features.map((feature) => (
                    <div key={feature.key} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(190px,1fr)_100px_100px_minmax(150px,.8fr)] sm:items-center">
                      <div><p className="text-sm font-medium text-slate-200">{feature.label}</p><p className="mt-1 text-xs text-slate-600">N={feature.count} · clean lift <span className={feature.clean15Lift > 0 ? 'text-emerald-400' : feature.clean15Lift < 0 ? 'text-rose-400' : ''}>{feature.clean15Lift > 0 ? '+' : ''}{feature.clean15Lift.toFixed(1)}pp</span></p></div>
                      <div><p className="research-label">Clean ≤15m</p><p className="mt-1 font-mono text-sm text-white">{percent(feature.clean15)}</p></div>
                      <div><p className="research-label">By noon</p><p className="mt-1 font-mono text-sm text-white">{percent(feature.reachedByNoon)}</p></div>
                      <div><div className="mb-2 flex items-center justify-between"><span className="research-label">Weight</span><span className="font-mono text-xs text-amber-300">{weights[feature.key].toFixed(1)}</span></div><Slider min={0} max={30} step={0.5} value={[weights[feature.key]]} onValueChange={(value) => updateWeight(feature.key, Array.isArray(value) ? value[0] : value)} aria-label={`${feature.label} weight`} /></div>
                    </div>
                  ))}
                </div>
              </section>

              <aside className="space-y-4">
                <section className="research-panel p-5"><div className="mb-4 flex items-center justify-between"><div><p className="research-kicker">Qualification gate</p><h2 className="research-title">Minimum score</h2></div><span className="font-mono text-xl text-amber-300">{threshold}</span></div><Slider min={0} max={100} step={1} value={[threshold]} onValueChange={(value) => setThreshold(Array.isArray(value) ? value[0] : value)} aria-label="Qualification score threshold" /><div className="mt-4 flex justify-between text-xs text-slate-600"><span>More opportunities</span><span>Stricter confirmation</span></div></section>
                <section className="research-panel overflow-hidden"><div className="research-panel-header"><div><p className="research-kicker">Current cohort</p><h2 className="research-title">Qualified sessions</h2></div><span className="rounded-lg border border-white/8 px-2 py-1 font-mono text-xs text-slate-400">{qualified.length}</span></div><div className="max-h-[31rem] divide-y divide-white/6 overflow-y-auto">{qualified.length ? qualified.sort((a, b) => b.score - a.score).map(({ session, score }) => { const outcome = outcomeLabel(session); return <div key={session.date} className="flex items-center gap-3 px-5 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium text-slate-200">{session.date}</p><p className="mt-0.5 truncate text-xs text-slate-600">{setupLabel(session.setupType)}</p></div><span className={`rounded-md border px-2 py-1 text-[10px] ${outcome.tone}`}>{outcome.label}</span><span className="w-10 text-right font-mono text-xs text-amber-300">{score.toFixed(0)}</span></div>; }) : <p className="p-5 text-sm leading-6 text-slate-500">No sessions meet this combination. Lower the threshold or increase evidence-backed weights.</p>}</div></section>
                <section className="research-panel p-5"><p className="research-kicker">How weight is derived</p><p className="mt-2 text-xs leading-5 text-slate-500">70% clean-15-minute lift plus 30% by-noon lift, with two baseline pseudo-observations for shrinkage. Positive evidence is normalized to 100. Correlated factors are exploratory—not independent probabilities.</p></section>
              </aside>
            </div>
          </TabsContent>

          <TabsContent value="volume">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,.75fr)]">
              <section className="research-panel overflow-hidden">
                <div className="research-panel-header"><div><p className="research-kicker">Buyer / seller imbalance</p><h2 className="research-title">Flow transition around the reclaim</h2></div><Select value={selectedDate} onValueChange={(value) => value && setSelectedDate(value)}><SelectTrigger className="w-40 border-white/10 bg-white/[0.025] text-slate-300"><SelectValue /></SelectTrigger><SelectContent>{analysis.sessions.map((session) => <SelectItem key={session.date} value={session.date}>{session.date}</SelectItem>)}</SelectContent></Select></div>
                <div className="h-[360px] p-4 sm:p-6"><ResponsiveContainer width="100%" height="100%"><BarChart data={imbalanceData} margin={{ top: 16, right: 12, bottom: 12, left: 0 }}><CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} /><XAxis dataKey="window" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={{ stroke: 'rgba(255,255,255,.08)' }} tickLine={false} /><YAxis domain={[-100, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} /><ReferenceLine y={0} stroke="rgba(255,255,255,.22)" /><ChartTooltip cursor={{ fill: 'rgba(255,255,255,.025)' }} contentStyle={{ background: '#0c1925', border: '1px solid rgba(255,255,255,.1)', borderRadius: 8 }} formatter={(value) => [`${Number(value).toFixed(1)}%`, 'Imbalance']} /><Bar dataKey="imbalance" radius={[4, 4, 0, 0]}>{imbalanceData.map((entry) => <Cell key={entry.window} fill={entry.imbalance >= 0 ? '#34d399' : '#fb7185'} />)}</Bar></BarChart></ResponsiveContainer></div>
                <div className="grid border-t border-white/8 sm:grid-cols-4 sm:divide-x sm:divide-white/8">{[
                  ['Buyer share', `${selectedSession.flow.cross.buyShare.toFixed(1)}%`],
                  ['Volume acceleration', `${selectedSession.flow.volumeAcceleration.toFixed(2)}×`],
                  ['30s acceptance', selectedSession.flow.acceptedReclaim30Seconds ? 'Yes' : 'No'],
                  ['ORB-high result', selectedSession.outcome.reachedByNoon ? `${selectedSession.outcome.targetMinutes ?? '—'} min` : 'Miss'],
                ].map(([label, value]) => <div key={label} className="p-4"><p className="research-label">{label}</p><p className="mt-2 font-mono text-sm text-slate-200">{value}</p></div>)}</div>
              </section>

              <div className="space-y-4">
                <section className="research-panel p-5"><p className="research-kicker">Volume findings</p><div className="mt-4 space-y-4">{[
                  ['Absorption proxy', `${analysis.volumeAnalysis.absorptionProxy.count} cases`, `${analysis.volumeAnalysis.absorptionProxy.noonPct}% eventually hit; ${analysis.volumeAnalysis.absorptionProxy.clean15Pct}% were clean`],
                  ['30-second acceptance', `${analysis.volumeAnalysis.acceptedReclaim30Seconds.clean15Pct}% clean`, `${analysis.volumeAnalysis.acceptedReclaim30Seconds.count} cases`],
                  ['False 30-second reclaim', `${analysis.volumeAnalysis.falseReclaim30Seconds.clean15Pct}% clean`, `${analysis.volumeAnalysis.falseReclaim30Seconds.count} cases`],
                  ['ORB-high rejection', `${analysis.volumeAnalysis.orbHighRejection.rejectedPct}%`, `${analysis.volumeAnalysis.orbHighRejection.rejectedWithinFiveMinutes}/${analysis.volumeAnalysis.orbHighRejection.targetTouches} touches closed back below within 5 minutes`],
                ].map(([label, value, detail]) => <div key={label} className="border-b border-white/6 pb-4 last:border-0 last:pb-0"><div className="flex items-baseline justify-between gap-3"><p className="text-sm text-slate-300">{label}</p><p className="font-mono text-sm text-white">{value}</p></div><p className="mt-1 text-xs leading-5 text-slate-600">{detail}</p></div>)}</div></section>
                <section className="research-panel border-amber-300/15 p-5"><div className="flex gap-3"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" /><div><p className="text-sm font-medium text-slate-200">Absorption is inferred</p><p className="mt-2 text-xs leading-5 text-slate-500">The proxy detects seller imbalance with limited downside progress followed by recovery. Historical trades do not expose the resting NBBO queue or Bookmap heatmap, so it cannot prove hidden passive orders.</p></div></div></section>
                <section className="research-panel p-5"><p className="research-kicker">Next feature family</p><h2 className="mt-1 text-sm font-semibold text-slate-200">Options and gamma · not yet weighted</h2><div className="mt-4 space-y-2">{['Gamma exposure and flip level','0DTE strike concentration','Call / put walls near ORB levels','IV skew and term structure','Directional premium and opening flow'].map((item) => <div key={item} className="flex items-center gap-2 rounded-lg border border-white/6 bg-white/[0.018] px-3 py-2.5 text-xs text-slate-500"><ChevronRight className="size-3 text-slate-700" />{item}</div>)}</div></section>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="sessions">
            <section className="research-panel overflow-hidden">
              <div className="research-panel-header"><div><p className="research-kicker">Exact tape cohort</p><h2 className="research-title">Session-by-session evidence</h2></div><span className="text-xs text-slate-600">MAE shown as % of ORB range</span></div>
              <Table><TableHeader><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="px-5 text-[10px] uppercase tracking-wider text-slate-600">Date</TableHead><TableHead className="text-[10px] uppercase tracking-wider text-slate-600">Setup</TableHead><TableHead className="text-[10px] uppercase tracking-wider text-slate-600">Model score</TableHead><TableHead className="text-[10px] uppercase tracking-wider text-slate-600">Buyer share</TableHead><TableHead className="text-[10px] uppercase tracking-wider text-slate-600">Vol. accel.</TableHead><TableHead className="text-[10px] uppercase tracking-wider text-slate-600">MAE</TableHead><TableHead className="pr-5 text-[10px] uppercase tracking-wider text-slate-600">Result</TableHead></TableRow></TableHeader><TableBody>{scored.slice().sort((a, b) => b.session.date.localeCompare(a.session.date)).map(({ session, score }) => { const outcome = outcomeLabel(session); return <TableRow key={session.date} className="border-white/6 hover:bg-white/[0.018]"><TableCell className="px-5 font-mono text-slate-300">{session.date}</TableCell><TableCell className="text-xs text-slate-500">{setupLabel(session.setupType)}</TableCell><TableCell><span className="font-mono text-amber-300">{score.toFixed(0)}</span></TableCell><TableCell className="font-mono text-slate-300">{session.flow.cross.buyShare.toFixed(1)}%</TableCell><TableCell className="font-mono text-slate-300">{session.flow.volumeAcceleration.toFixed(2)}×</TableCell><TableCell className="font-mono text-slate-300">{session.outcome.maeR === null ? '—' : `${(session.outcome.maeR * 100).toFixed(1)}%`}</TableCell><TableCell className="pr-5"><span className={`inline-flex rounded-md border px-2 py-1 text-[10px] ${outcome.tone}`}>{outcome.label}</span></TableCell></TableRow>; })}</TableBody></Table>
            </section>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
