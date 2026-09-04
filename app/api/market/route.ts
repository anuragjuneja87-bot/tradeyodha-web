import { getMarketBrief, getWatchlist, MassiveApiError, validateSymbols } from '@/lib/massive';

export const runtime = 'edge';

function json(body: object, status = 200, maxAge = 30) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': status === 200
        ? `public, max-age=10, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}`
        : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const watchlist = url.searchParams.get('symbols');
    if (watchlist) {
      const symbols = validateSymbols(watchlist);
      return json(await getWatchlist(symbols), 200, 20);
    }

    const symbol = validateSymbols(url.searchParams.get('symbol') ?? '')[0];
    return json(await getMarketBrief(symbol), 200, 45);
  } catch (error) {
    const status = error instanceof MassiveApiError && error.status >= 400 && error.status < 600 ? error.status : 500;
    const publicStatus = status === 401 || status === 403 ? 502 : status;
    const message = error instanceof MassiveApiError
      ? error.message
      : 'Market data could not be loaded right now.';
    return json({ error: message }, publicStatus, 0);
  }
}
