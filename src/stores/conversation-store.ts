// Stores the durable chat transcript, compact working context, and rolling summary.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import { callGemini, type TelegramConfig } from '../gemini';

export type TranscriptRecord = {
  role: 'user' | 'assistant';
  origin: 'chat' | 'system';
  source: string;
  updateId?: string;
  text: string;
  username?: string;
  timestampIso: string;
  dateKey: string;
};

export type WorkingMessage = {
  role: 'user' | 'assistant';
  text: string;
};

export type ChatReportContext = {
  summary: string;
  todayLog: string;
  previousLog: string;
};

export type ConversationState = {
  lastUserMessageAtIso?: string;
  transcriptCount: number;
  summary: string;
};

export type PromptContext = {
  summary: string;
  workingHistory: WorkingMessage[];
};

const WORKING_HISTORY_LIMIT = 40;
const SUMMARY_TOKEN_THRESHOLD = 900;

@agent()
export class ConversationStore extends BaseAgent {
  private transcript: TranscriptRecord[] = [];
  private workingHistory: WorkingMessage[] = [];
  private summary = '';
  private lastUserMessageAtIso?: string;

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Records a user/assistant exchange and optionally keeps it in the short LLM context.
  async recordChatExchange(
    userText: string,
    assistantText: string,
    username: string | undefined,
    updateId: string | undefined,
    assistantSource: string,
    dateKey: string,
    userTimestampIso: string,
    assistantTimestampIso: string,
    includeInWorkingContext: boolean
  ): Promise<void> {
    this.lastUserMessageAtIso = userTimestampIso;
    this.transcript.push({
      role: 'user',
      origin: 'chat',
      source: 'telegram',
      updateId,
      text: userText,
      username,
      timestampIso: userTimestampIso,
      dateKey,
    });
    this.transcript.push({
      role: 'assistant',
      origin: 'chat',
      source: assistantSource,
      updateId,
      text: assistantText,
      timestampIso: assistantTimestampIso,
      dateKey,
    });

    if (!includeInWorkingContext) {
      return;
    }

    this.workingHistory.push({ role: 'user', text: userText }, { role: 'assistant', text: assistantText });
    if (this.workingHistory.length > WORKING_HISTORY_LIMIT) {
      this.workingHistory.splice(0, this.workingHistory.length - WORKING_HISTORY_LIMIT);
    }
    await this.compactConversationIfNeeded();
  }

  // Records an automated assistant message so reports and summaries stay aware of it.
  async recordAutomatedAssistantMessage(source: string, text: string, dateKey: string, timestampIso: string, includeInWorkingContext: boolean): Promise<void> {
    this.transcript.push({
      role: 'assistant',
      origin: 'system',
      source,
      text,
      timestampIso,
      dateKey,
    });

    if (!includeInWorkingContext) {
      return;
    }

    this.workingHistory.push({ role: 'assistant', text });
    if (this.workingHistory.length > WORKING_HISTORY_LIMIT) {
      this.workingHistory.splice(0, this.workingHistory.length - WORKING_HISTORY_LIMIT);
    }
    await this.compactConversationIfNeeded();
  }

  // Returns the compact context used to build the next assistant prompt.
  async getPromptContext(): Promise<PromptContext> {
    return {
      summary: this.summary,
      workingHistory: this.workingHistory.map((entry) => ({ ...entry })),
    };
  }

  // Returns lightweight conversation metadata for automation decisions.
  async getConversationState(): Promise<ConversationState> {
    return {
      lastUserMessageAtIso: this.lastUserMessageAtIso,
      transcriptCount: this.transcript.length,
      summary: this.summary,
    };
  }

  // Builds report-friendly slices without exposing the full transcript internals.
  async getReportContext(dateKey: string): Promise<ChatReportContext> {
    return {
      summary: this.summary,
      todayLog: this.formatTranscriptForDay(dateKey),
      previousLog: this.formatPreviousTranscript(dateKey),
    };
  }

  // Summarizes older working history once the short context gets too large.
  private async compactConversationIfNeeded(): Promise<void> {
    const historyText = this.workingHistory.map((entry) => `${entry.role}: ${entry.text}`).join('\n');
    const historyTokens = this.roughTokenCount(historyText);
    if (historyTokens >= SUMMARY_TOKEN_THRESHOLD && await this.updateSummary(historyText)) {
      this.workingHistory = this.workingHistory.slice(-6);
    }
  }

  // Keeps a compact summary so the prompt can preserve durable context cheaply.
  private async updateSummary(historyText: string): Promise<boolean> {
    try {
      const summary = await callGemini(
        this.config.value.geminiApiKey,
        [
          'Update the working conversation summary for this Telegram concierge assistant.',
          'Keep stable context, decisions, user preferences, and unresolved threads.',
          'Preserve the existing summary unless new messages supersede it.',
          'Keep it compact.',
          '',
          'Existing summary:',
          this.summary || 'None.',
          '',
          'Messages to absorb:',
          historyText,
        ].join('\n')
      );
      this.summary = summary.slice(0, 4000);
      return true;
    } catch {
      // Summary maintenance must never block the user-facing path.
      return false;
    }
  }

  // Formats a single local day of transcript for digest generation.
  private formatTranscriptForDay(dateKey: string): string {
    const dayRecords = this.transcript.filter((entry) => entry.dateKey === dateKey);
    if (dayRecords.length === 0) {
      return 'No messages logged for this day.';
    }

    return this.truncate(
      dayRecords.map((entry) => `${entry.role}${entry.origin === 'system' ? ` [${entry.source}]` : entry.username ? ` (${entry.username})` : ''}: ${entry.text}`).join('\n'),
      12000
    );
  }

  // Reuses the latest earlier day as historical context for digests.
  private formatPreviousTranscript(dateKey: string): string {
    const previousDate = [...new Set(this.transcript.map((entry) => entry.dateKey).filter((entryDate) => entryDate < dateKey))]
      .sort((a, b) => b.localeCompare(a))[0];
    if (!previousDate) {
      return 'No previous day log available.';
    }

    const previousRecords = this.transcript.filter((entry) => entry.dateKey === previousDate);
    return `${previousDate}\n${this.truncate(previousRecords.map((entry) => `${entry.role}: ${entry.text}`).join('\n'), 5000)}`;
  }

  // Caps large transcript sections before they get fed back into prompts.
  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }

    return `${text.slice(0, maxChars)}\n\n[truncated]`;
  }

  // Uses a simple character heuristic because exact tokenization is unnecessary here.
  private roughTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
