// Uses Gemini for lightweight portfolio follow-ups without owning the portfolio itself.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import { callGemini, type TelegramConfig } from '../gemini';
import type { PortfolioSnapshot } from '../stores/portfolio-store';

export type PortfolioNudge = {
  shouldMessage: boolean;
  message?: string;
};

@agent()
export class PortfolioAnalystAgent extends BaseAgent {
  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Writes one small portfolio nudge when there is something worth revisiting.
  async composeDailyNudge(snapshot: PortfolioSnapshot, candidates: Array<{ symbol: string; reason: string }>): Promise<PortfolioNudge> {
    if (snapshot.holdings.length === 0 && snapshot.watchlist.length === 0) {
      return { shouldMessage: false };
    }

    if (candidates.length === 0) {
      return { shouldMessage: false };
    }

    try {
      const reply = (await callGemini(
        this.config.value.geminiApiKey,
        [
          'Write one concise Telegram stock portfolio nudge for the user.',
          'Focus on exactly one useful follow-up. Keep it under 400 characters.',
          'Do not overstate urgency. Do not use markdown bullets.',
          '',
          'Holdings:',
          snapshot.holdings.length === 0 ? 'None.' : snapshot.holdings.map((holding) => `${holding.symbol}: ${holding.shares} shares, sector ${holding.sector ?? 'unknown'}, thesis ${holding.thesis ?? 'none'}.`).join('\n'),
          '',
          'Watchlist:',
          snapshot.watchlist.length === 0 ? 'None.' : snapshot.watchlist.map((entry) => `${entry.symbol}, sector ${entry.sector ?? 'unknown'}, thesis ${entry.thesis ?? 'none'}.`).join('\n'),
          '',
          'Candidate follow-ups:',
          candidates.map((candidate) => `- ${candidate.symbol}: ${candidate.reason}`).join('\n'),
        ].join('\n')
      )).trim();

      if (reply.length === 0) {
        return { shouldMessage: false };
      }

      return {
        shouldMessage: true,
        message: reply,
      };
    } catch {
      return {
        shouldMessage: true,
        message: `Portfolio nudge: ${candidates[0]?.reason ?? 'one of your watched names is due for a quick review.'}`,
      };
    }
  }
}
