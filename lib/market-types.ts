export type MarketTone = 'bullish' | 'bearish' | 'neutral';

export type WatchlistQuote = {
  symbol: string;
  price: number | null;
  changePercent: number | null;
  marketStatus: string;
  updatedAt: string | null;
};

export type PremarketBar = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
};

export type OptionMetrics = {
  available: boolean;
  expiration: string | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number | null;
  putCallRatio: number | null;
  expectedMove: number | null;
  contractCount: number;
  message: string | null;
};

export type NewsItem = {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
  sentiment: 'positive' | 'negative' | 'neutral' | null;
  sentimentReasoning: string | null;
};

export type OffExchangeSummary = {
  available: boolean;
  rows: Array<{
    date: string;
    averagePrice: number;
    shares: number;
    notional: number;
    printCount: number;
  }>;
  message: string | null;
};

export type MarketBrief = {
  symbol: string;
  name: string;
  price: number;
  previousClose: number;
  changePercent: number;
  marketStatus: string;
  updatedAt: string;
  feed: 'real-time' | 'delayed';
  premarket: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number;
    vwap: number | null;
    relativeVolume: number | null;
    bars: PremarketBar[];
  };
  options: OptionMetrics;
  levels: {
    pivot: number;
    previousVwap: number | null;
    supports: number[];
    resistances: number[];
  };
  thesis: {
    tone: MarketTone;
    score: number;
    read: string;
    summary: string;
    bullCase: string;
    bearCase: string;
    invalidation: string;
  };
  news: NewsItem[];
  offExchange: OffExchangeSummary;
  warnings: string[];
};

export type WatchlistResponse = {
  quotes: WatchlistQuote[];
  feed: 'real-time' | 'delayed';
  updatedAt: string;
};
