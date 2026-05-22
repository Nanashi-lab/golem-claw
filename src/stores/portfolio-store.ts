// Stores holdings, watchlist entries, cached quotes, and research linkage.
import { BaseAgent, agent } from '@golemcloud/golem-ts-sdk';
import { fetchStockQuote, formatQuote, normalizeSymbol, type StockQuote } from '../services/market-data';

export type PortfolioHolding = {
  symbol: string;
  shares: number;
  averageCost?: number;
  sector?: string;
  thesis?: string;
  addedAt: string;
  updatedAt: string;
  lastQuote?: StockQuote;
  lastResearchAt?: string;
};

export type WatchStock = {
  symbol: string;
  sector?: string;
  thesis?: string;
  addedAt: string;
  updatedAt: string;
  lastResearchNoteName?: string;
  lastResearchAt?: string;
  lastQuote?: StockQuote;
};

export type PortfolioSnapshot = {
  holdings: PortfolioHolding[];
  watchlist: WatchStock[];
};

export type PortfolioStoreResult = {
  tool:
    | 'addPortfolioHolding'
    | 'listPortfolio'
    | 'addWatchStock'
    | 'listWatchStocks'
    | 'getStockQuote'
    | 'markResearchSaved';
  ok: boolean;
  summary: string;
  snapshot: PortfolioSnapshot;
  quote?: StockQuote;
};

type MutationResult = {
  key: string;
  result: PortfolioStoreResult;
};

const HOLDING_LIMIT = 50;
const WATCH_LIMIT = 50;
const MUTATION_RESULT_LIMIT = 100;

@agent()
export class PortfolioStore extends BaseAgent {
  private holdings: PortfolioHolding[] = [];
  private watchlist: WatchStock[] = [];
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string) {
    super();
  }

  // Adds or updates a portfolio holding with optional thesis and sector context.
  async addPortfolioHolding(
    symbol: string,
    shares: number,
    averageCost: number | undefined,
    sector: string | undefined,
    thesis: string | undefined,
    updateKey?: string
  ): Promise<PortfolioStoreResult> {
    const existing = this.getMutationResult('addPortfolioHolding', updateKey);
    if (existing) {
      return existing;
    }

    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedSector = this.cleanOptional(sector);
    const normalizedThesis = this.cleanOptional(thesis);
    if (!normalizedSymbol) {
      return this.saveAndReturn('addPortfolioHolding', updateKey, this.makeResult('addPortfolioHolding', false, 'Please provide a stock symbol.'));
    }
    if (!Number.isFinite(shares) || shares <= 0) {
      return this.saveAndReturn('addPortfolioHolding', updateKey, this.makeResult('addPortfolioHolding', false, 'Please provide a positive number of shares.'));
    }
    if (averageCost !== undefined && (!Number.isFinite(averageCost) || averageCost < 0)) {
      return this.saveAndReturn('addPortfolioHolding', updateKey, this.makeResult('addPortfolioHolding', false, 'Average cost must be a non-negative number.'));
    }

    const now = new Date().toISOString();
    const holding = this.holdings.find((entry) => entry.symbol === normalizedSymbol);
    if (holding) {
      holding.shares = shares;
      if (averageCost !== undefined) {
        holding.averageCost = averageCost;
      }
      if (normalizedSector !== undefined) {
        holding.sector = normalizedSector;
      }
      if (normalizedThesis !== undefined) {
        holding.thesis = normalizedThesis;
      }
      holding.updatedAt = now;
      return this.saveAndReturn('addPortfolioHolding', updateKey, this.makeResult('addPortfolioHolding', true, `Updated portfolio holding ${normalizedSymbol} with ${shares} shares.`));
    }

    this.holdings.push({
      symbol: normalizedSymbol,
      shares,
      averageCost,
      sector: normalizedSector,
      thesis: normalizedThesis,
      addedAt: now,
      updatedAt: now,
    });
    this.holdings.sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (this.holdings.length > HOLDING_LIMIT) {
      this.holdings.shift();
    }

    return this.saveAndReturn('addPortfolioHolding', updateKey, this.makeResult('addPortfolioHolding', true, `Added ${normalizedSymbol} to the portfolio with ${shares} shares.`));
  }

  // Lists current holdings in a compact Telegram-friendly format.
  async listPortfolio(): Promise<PortfolioStoreResult> {
    if (this.holdings.length === 0) {
      return this.makeResult('listPortfolio', true, 'No portfolio holdings saved yet.');
    }

    return this.makeResult(
      'listPortfolio',
      true,
      ['Portfolio holdings:', ...this.holdings.map((holding) => this.formatHolding(holding))].join('\n')
    );
  }

  // Adds or updates a watchlist entry with optional thesis and sector context.
  async addWatchStock(symbol: string, thesis: string | undefined, sector: string | undefined, updateKey?: string): Promise<PortfolioStoreResult> {
    const existing = this.getMutationResult('addWatchStock', updateKey);
    if (existing) {
      return existing;
    }

    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedThesis = this.cleanOptional(thesis);
    const normalizedSector = this.cleanOptional(sector);
    if (!normalizedSymbol) {
      return this.saveAndReturn('addWatchStock', updateKey, this.makeResult('addWatchStock', false, 'Please provide a stock symbol to watch.'));
    }

    const now = new Date().toISOString();
    const existingWatch = this.watchlist.find((entry) => entry.symbol === normalizedSymbol);
    if (existingWatch) {
      existingWatch.thesis = normalizedThesis ?? existingWatch.thesis;
      existingWatch.sector = normalizedSector ?? existingWatch.sector;
      existingWatch.updatedAt = now;
      return this.saveAndReturn('addWatchStock', updateKey, this.makeResult('addWatchStock', true, `Updated watchlist entry for ${normalizedSymbol}.`));
    }

    this.watchlist.push({
      symbol: normalizedSymbol,
      thesis: normalizedThesis,
      sector: normalizedSector,
      addedAt: now,
      updatedAt: now,
    });
    this.watchlist.sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (this.watchlist.length > WATCH_LIMIT) {
      this.watchlist.shift();
    }

    return this.saveAndReturn('addWatchStock', updateKey, this.makeResult('addWatchStock', true, `Added ${normalizedSymbol} to the watchlist.`));
  }

  // Lists current watchlist entries.
  async listWatchStocks(): Promise<PortfolioStoreResult> {
    if (this.watchlist.length === 0) {
      return this.makeResult('listWatchStocks', true, 'No watchlist stocks saved yet.');
    }

    return this.makeResult(
      'listWatchStocks',
      true,
      ['Watchlist:', ...this.watchlist.map((entry) => this.formatWatch(entry))].join('\n')
    );
  }

  // Fetches and caches one end-of-day quote.
  async getStockQuote(symbol: string): Promise<PortfolioStoreResult> {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) {
      return this.makeResult('getStockQuote', false, 'Please provide a stock symbol.', undefined);
    }

    const quote = await fetchStockQuote(normalized);
    if (!quote) {
      return this.makeResult('getStockQuote', false, `I could not fetch an end-of-day quote for ${normalized}. Try a symbol like AAPL or TSLA.`);
    }

    this.saveQuote(normalized, quote);
    return this.makeResult('getStockQuote', true, formatQuote(quote), quote);
  }

  // Links a saved research note back to a holding or watchlist entry.
  async markResearchSaved(symbol: string, noteName: string, timestampIso = new Date().toISOString(), updateKey?: string): Promise<PortfolioStoreResult> {
    const existing = this.getMutationResult('markResearchSaved', updateKey);
    if (existing) {
      return existing;
    }

    const normalized = normalizeSymbol(symbol);
    const watch = this.watchlist.find((entry) => entry.symbol === normalized);
    const holding = this.holdings.find((entry) => entry.symbol === normalized);
    if (!watch && !holding) {
      const missing = this.makeResult('markResearchSaved', false, `No saved holding or watchlist entry matches ${symbol}.`);
      this.saveMutationResult('markResearchSaved', updateKey, missing);
      return missing;
    }

    if (watch) {
      watch.lastResearchAt = timestampIso;
      watch.lastResearchNoteName = noteName;
      watch.updatedAt = timestampIso;
    }
    if (holding) {
      holding.lastResearchAt = timestampIso;
      holding.updatedAt = timestampIso;
    }

    const result = this.makeResult('markResearchSaved', true, `Linked research note ${noteName} to ${normalized}.`);
    this.saveMutationResult('markResearchSaved', updateKey, result);
    return result;
  }

  // Returns a defensive copy for reports and analyst prompts.
  async getSnapshot(): Promise<PortfolioSnapshot> {
    return {
      holdings: this.holdings.map((holding) => ({ ...holding, lastQuote: holding.lastQuote ? { ...holding.lastQuote } : undefined })),
      watchlist: this.watchlist.map((entry) => ({ ...entry, lastQuote: entry.lastQuote ? { ...entry.lastQuote } : undefined })),
    };
  }

  // Builds a research brief with current portfolio context for one symbol.
  async buildResearchBrief(symbol: string, focus: string | undefined): Promise<{ topic: string; displayTopic: string; researchBrief: string } | undefined> {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) {
      return undefined;
    }

    const quote = await fetchStockQuote(normalized);
    if (quote) {
      this.saveQuote(normalized, quote);
    }

    return {
      topic: `${normalized} stock valuation portfolio fit`,
      displayTopic: `${normalized} stock research`,
      researchBrief: this.buildResearchTopic(normalized, focus, quote),
    };
  }

  // Picks the oldest or least-reviewed names for automation nudges.
  async getReviewCandidates(limit = 3): Promise<Array<{ symbol: string; reason: string }>> {
    const candidates: Array<{ symbol: string; reason: string; sortKey: string }> = [];

    for (const watch of this.watchlist) {
      candidates.push({
        symbol: watch.symbol,
        reason: watch.lastResearchAt ? `watchlist stock ${watch.symbol} has not been reviewed since ${watch.lastResearchAt.slice(0, 10)}.` : `watchlist stock ${watch.symbol} has not been researched yet.`,
        sortKey: watch.lastResearchAt ?? watch.addedAt,
      });
    }
    for (const holding of this.holdings) {
      candidates.push({
        symbol: holding.symbol,
        reason: holding.lastResearchAt ? `holding ${holding.symbol} has not been revisited since ${holding.lastResearchAt.slice(0, 10)}.` : `holding ${holding.symbol} has no saved research yet.`,
        sortKey: holding.lastResearchAt ?? holding.addedAt,
      });
    }

    return candidates
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .slice(0, limit)
      .map(({ sortKey: _sortKey, ...candidate }) => candidate);
  }

  // Builds a stock-specific research brief using holdings, watchlist, and quote context.
  private buildResearchTopic(symbol: string, focus: string | undefined, quote: StockQuote | undefined): string {
    const holding = this.holdings.find((entry) => entry.symbol === symbol);
    const watch = this.watchlist.find((entry) => entry.symbol === symbol);

    return [
      `Research ${symbol} stock for a personal portfolio assistant.`,
      focus?.trim() ? `Primary focus: ${focus.trim()}` : 'Primary focus: business quality, valuation, recent developments, risks, and whether the current sector looks overheated or reasonably valued.',
      quote ? `Latest available EOD quote from Stooq: close ${quote.close.toFixed(2)}, open ${quote.open.toFixed(2)}, high ${quote.high.toFixed(2)}, low ${quote.low.toFixed(2)}, volume ${quote.volume}, as of ${quote.asOfIso}.` : 'Latest quote unavailable.',
      '',
      'Current portfolio context:',
      this.describePortfolioContext(),
      '',
      'Specific position context:',
      holding
        ? `Already held: ${holding.symbol}, shares ${holding.shares}, average cost ${holding.averageCost ?? 'unknown'}, sector ${holding.sector ?? 'unknown'}, thesis ${holding.thesis ?? 'none saved'}.`
        : watch
          ? `Watched, not currently held: ${watch.symbol}, sector ${watch.sector ?? 'unknown'}, thesis ${watch.thesis ?? 'none saved'}.`
          : 'Not yet saved in portfolio or watchlist.',
      '',
      'Portfolio analysis requirements: discuss portfolio fit, sector concentration, and whether adding more exposure could worsen overvaluation or concentration risk.',
    ].join('\n');
  }

  // Summarizes sector exposure and saved position context for research prompts.
  private describePortfolioContext(): string {
    if (this.holdings.length === 0 && this.watchlist.length === 0) {
      return 'No saved holdings or watchlist entries yet.';
    }

    const sectorExposure = new Map<string, { holdings: number; watchlist: number; shares: number }>();
    for (const holding of this.holdings) {
      const key = holding.sector?.trim() || 'unknown';
      const current = sectorExposure.get(key) ?? { holdings: 0, watchlist: 0, shares: 0 };
      current.holdings += 1;
      current.shares += holding.shares;
      sectorExposure.set(key, current);
    }
    for (const watch of this.watchlist) {
      const key = watch.sector?.trim() || 'unknown';
      const current = sectorExposure.get(key) ?? { holdings: 0, watchlist: 0, shares: 0 };
      current.watchlist += 1;
      sectorExposure.set(key, current);
    }

    const sectors = [...sectorExposure.entries()]
      .sort((a, b) => b[1].shares - a[1].shares || b[1].holdings - a[1].holdings)
      .map(([sector, values]) => `- ${sector}: ${values.holdings} holdings, ${values.watchlist} watchlist names, ${values.shares} total shares`)
      .join('\n');

    const holdings = this.holdings.length === 0 ? 'No holdings.' : this.holdings.map((holding) => this.formatHolding(holding)).join('\n');
    const watchlist = this.watchlist.length === 0 ? 'No watchlist entries.' : this.watchlist.map((entry) => this.formatWatch(entry)).join('\n');

    return ['Sector exposure:', sectors || '- none', '', 'Holdings:', holdings, '', 'Watchlist:', watchlist].join('\n');
  }

  // Caches a quote on both holdings and watchlist entries that match the symbol.
  private saveQuote(symbol: string, quote: StockQuote): void {
    const holding = this.holdings.find((entry) => entry.symbol === symbol);
    if (holding) {
      holding.lastQuote = quote;
      holding.updatedAt = new Date().toISOString();
    }

    const watch = this.watchlist.find((entry) => entry.symbol === symbol);
    if (watch) {
      watch.lastQuote = quote;
      watch.updatedAt = new Date().toISOString();
    }
  }

  // Formats one holding for list and reporting output.
  private formatHolding(holding: PortfolioHolding): string {
    const parts = [
      `- ${holding.symbol}: ${holding.shares} shares`,
      holding.averageCost !== undefined ? `avg cost ${holding.averageCost}` : undefined,
      holding.sector ? `sector ${holding.sector}` : undefined,
      holding.thesis ? `thesis ${holding.thesis}` : undefined,
      holding.lastQuote ? `cached close ${holding.lastQuote.close.toFixed(2)} on ${holding.lastQuote.asOfIso.slice(0, 10)}` : undefined,
      holding.lastResearchAt ? `last research ${holding.lastResearchAt.slice(0, 10)}` : undefined,
    ].filter((value): value is string => Boolean(value));
    return parts.join(', ');
  }

  // Formats one watchlist entry for list and reporting output.
  private formatWatch(entry: WatchStock): string {
    const parts = [
      `- ${entry.symbol}`,
      entry.sector ? `sector ${entry.sector}` : undefined,
      entry.thesis ? `thesis ${entry.thesis}` : undefined,
      entry.lastResearchNoteName ? `research ${entry.lastResearchNoteName}` : undefined,
      entry.lastQuote ? `cached close ${entry.lastQuote.close.toFixed(2)} on ${entry.lastQuote.asOfIso.slice(0, 10)}` : undefined,
    ].filter((value): value is string => Boolean(value));
    return parts.join(', ');
  }

  // Normalizes optional string fields before saving them durably.
  private cleanOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  // Packages the current portfolio state into a tool result payload.
  private makeResult(tool: PortfolioStoreResult['tool'], ok: boolean, summary: string, quote?: StockQuote): PortfolioStoreResult {
    return {
      tool,
      ok,
      summary,
      snapshot: {
        holdings: this.holdings.map((holding) => ({ ...holding, lastQuote: holding.lastQuote ? { ...holding.lastQuote } : undefined })),
        watchlist: this.watchlist.map((entry) => ({ ...entry, lastQuote: entry.lastQuote ? { ...entry.lastQuote } : undefined })),
      },
      quote,
    };
  }

  // Reuses the last mutation result so retries stay idempotent.
  private getMutationResult(tool: PortfolioStoreResult['tool'], updateKey: string | undefined): PortfolioStoreResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === `${tool}:${updateKey}`)?.result;
  }

  // Stores mutation results under a tool-specific idempotency key.
  private saveMutationResult(tool: PortfolioStoreResult['tool'], updateKey: string | undefined, result: PortfolioStoreResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: `${tool}:${updateKey}`, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }

  // Saves and returns a result in one place for the early-validation branches.
  private saveAndReturn(tool: PortfolioStoreResult['tool'], updateKey: string | undefined, result: PortfolioStoreResult): PortfolioStoreResult {
    this.saveMutationResult(tool, updateKey, result);
    return result;
  }
}
