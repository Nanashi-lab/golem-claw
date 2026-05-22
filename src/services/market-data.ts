// Fetches simple end-of-day stock quotes and formats them for chat.
export type StockQuote = {
  symbol: string;
  sourceSymbol: string;
  asOfIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  changeFromOpen: number;
  changePercentFromOpen: number;
  source: 'stooq-eod';
};

// Fetches one Stooq end-of-day quote and normalizes it into a typed record.
export async function fetchStockQuote(symbol: string): Promise<StockQuote | undefined> {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) {
    return undefined;
  }

  const sourceSymbol = normalizedSymbol.includes('.') ? normalizedSymbol.toLowerCase() : `${normalizedSymbol.toLowerCase()}.us`;
  const response = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(sourceSymbol)}&i=d`);
  if (!response.ok) {
    return undefined;
  }

  const text = (await response.text()).trim();
  const [returnedSymbol, date, time, openText, highText, lowText, closeText, volumeText] = text.split(',');
  if (!returnedSymbol || !date || date === 'N/D') {
    return undefined;
  }

  const open = Number(openText);
  const high = Number(highText);
  const low = Number(lowText);
  const close = Number(closeText);
  const volume = Number(volumeText);
  if (![open, high, low, close, volume].every((value) => Number.isFinite(value))) {
    return undefined;
  }

  const iso = toQuoteIso(date, time ?? '');
  const changeFromOpen = close - open;
  const changePercentFromOpen = open === 0 ? 0 : (changeFromOpen / open) * 100;

  return {
    symbol: normalizedSymbol,
    sourceSymbol: returnedSymbol,
    asOfIso: iso,
    open,
    high,
    low,
    close,
    volume,
    changeFromOpen,
    changePercentFromOpen,
    source: 'stooq-eod',
  };
}

// Formats one quote snapshot into a Telegram-friendly response.
export function formatQuote(quote: StockQuote): string {
  return [
    `${quote.symbol} EOD quote`,
    `Close: ${quote.close.toFixed(2)}`,
    `Open: ${quote.open.toFixed(2)}`,
    `Day range: ${quote.low.toFixed(2)} - ${quote.high.toFixed(2)}`,
    `Change from open: ${quote.changeFromOpen >= 0 ? '+' : ''}${quote.changeFromOpen.toFixed(2)} (${quote.changePercentFromOpen >= 0 ? '+' : ''}${quote.changePercentFromOpen.toFixed(2)}%)`,
    `Volume: ${quote.volume}`,
    `As of: ${quote.asOfIso.slice(0, 10)}`,
    'Source: Stooq end-of-day data',
  ].join('\n');
}

// Canonicalizes user-entered ticker symbols before storage or lookup.
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\s+/g, '');
}

// Converts Stooq date/time fields into an ISO timestamp.
function toQuoteIso(date: string, time: string): string {
  const safeTime = time && time !== 'N/D' ? time : '000000';
  const year = date.slice(0, 4);
  const month = date.slice(4, 6);
  const day = date.slice(6, 8);
  const hours = safeTime.slice(0, 2) || '00';
  const minutes = safeTime.slice(2, 4) || '00';
  const seconds = safeTime.slice(4, 6) || '00';
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
}
