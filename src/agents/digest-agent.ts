// Turns durable state and transcript context into morning and evening digest text.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import { callGemini, type TelegramConfig } from '../gemini';

export type MorningDigestInput = {
  dateKey: string;
  timezone?: string;
  profileFacts: string;
  memory: string;
  goals: string;
  stocks: string;
  tasks: string;
  reminders: string;
  notesSummary: string;
  researchSummary: string;
  previousLog: string;
};

export type EveningDigestInput = {
  dateKey: string;
  timezone?: string;
  profileFacts: string;
  memory: string;
  goals: string;
  stocks: string;
  conversationSummary: string;
  tasks: string;
  reminders: string;
  notesSummary: string;
  researchSummary: string;
  todayLog: string;
  previousLog: string;
};

@agent()
export class DigestAgent extends BaseAgent {
  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Writes a concise morning kickoff with today-focused planning prompts.
  async formatMorningDigest(input: MorningDigestInput): Promise<string> {
    try {
      return (await callGemini(
        this.config.value.geminiApiKey,
        [
          'Write a concise Telegram morning kickoff for the user.',
          'Include: what matters today, key things to do, likely plans to focus on, and wishes or desired outcomes to keep in mind.',
          'Mention concrete tasks and reminders when available.',
          'Ask 2-4 specific planning questions the user can answer now.',
          'Be useful, not generic. Keep it under 1000 characters.',
          '',
          `Date: ${input.dateKey}`,
          `Timezone: ${input.timezone ?? 'unknown'}`,
          '',
          'Profile facts:',
          input.profileFacts,
          '',
          'Long-term memory:',
          input.memory || 'None.',
          '',
          'Goals:',
          input.goals,
          '',
          'Stocks and portfolio:',
          input.stocks,
          '',
          'Tasks:',
          input.tasks,
          '',
          'Reminders:',
          input.reminders,
          '',
          'Notes:',
          input.notesSummary,
          '',
          'Research notes and jobs:',
          input.researchSummary,
          '',
          'Previous available day transcript:',
          input.previousLog,
        ].join('\n')
      )).trim();
    } catch {
      return [`Morning kickoff ${input.dateKey}`, '', 'Tasks:', input.tasks, '', 'Reminders:', input.reminders, '', 'Goals:', input.goals, '', 'Stocks:', input.stocks].join('\n');
    }
  }

  // Writes a concise evening check-in using the full daily transcript and summary.
  async formatEveningDigest(input: EveningDigestInput): Promise<string> {
    try {
      return (await callGemini(
        this.config.value.geminiApiKey,
        [
          'Write a concise end-of-day Telegram check-in for the user.',
          'Use durable memory, goals, conversation summary, tasks, reminders, notes, research items, and the full daily transcript.',
          'Include: what mattered today, open loops, goal prompts, and 1-3 specific questions for tomorrow or tonight.',
          'If research finished, mention the note name and any useful follow-up. If notes or tasks changed, mention them concretely.',
          'Be useful, not generic. Keep it under 1200 characters.',
          '',
          `Date: ${input.dateKey}`,
          `Timezone: ${input.timezone ?? 'unknown'}`,
          '',
          'Profile facts:',
          input.profileFacts,
          '',
          'Memory:',
          input.memory || 'None.',
          '',
          'Goals:',
          input.goals,
          '',
          'Stocks and portfolio:',
          input.stocks,
          '',
          'Conversation summary:',
          input.conversationSummary || 'None.',
          '',
          'Tasks:',
          input.tasks,
          '',
          'Reminders:',
          input.reminders,
          '',
          'Notes:',
          input.notesSummary,
          '',
          'Research notes and jobs:',
          input.researchSummary,
          '',
          'Today full transcript:',
          input.todayLog,
          '',
          'Previous available day transcript:',
          input.previousLog,
        ].join('\n')
      )).trim();
    } catch {
      return [`Daily check-in ${input.dateKey}`, '', 'Goals:', input.goals, '', 'Stocks:', input.stocks, '', 'Tasks:', input.tasks, '', 'Reminders:', input.reminders].join('\n');
    }
  }
}
