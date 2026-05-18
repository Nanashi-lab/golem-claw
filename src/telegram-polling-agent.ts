import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import { TelegramChatAgent, type TelegramMessage } from './chat-agent';
import type { TelegramConfig } from './gemini';
import { formatErrorForTelegram } from './telegram-api';

type Datetime = {
  seconds: bigint;
  nanoseconds: number;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type TelegramGetUpdatesResponse = {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
};

type PollingStatus = {
  botName: string;
  enabled: boolean;
  offset?: number;
  processedUpdates: number;
  consecutiveFailures: number;
  lastPollAtIso: string;
  lastError: string;
  scheduledForIso: string;
};

// Higher polling time just because it is a test run
const POLL_INTERVAL_SECONDS = 60n;
const GET_UPDATES_LIMIT = 20;

@agent()
export class TelegramPollingAgent extends BaseAgent {
  private enabled = false;
  private offset?: number;
  private processedUpdates = 0;
  private consecutiveFailures = 0;
  private lastPollAtIso = '';
  private lastError = '';
  private scheduledForIso = '';

  constructor(readonly botName: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  async start(): Promise<PollingStatus> {
    if (!this.enabled) {
      this.enabled = true;
      this.lastError = '';
      this.scheduleNext(0n);
    }

    return this.status();
  }

  async stop(): Promise<PollingStatus> {
    this.enabled = false;
    this.scheduledForIso = '';
    return this.status();
  }

  async status(): Promise<PollingStatus> {
    return {
      botName: this.botName,
      enabled: this.enabled,
      offset: this.offset,
      processedUpdates: this.processedUpdates,
      consecutiveFailures: this.consecutiveFailures,
      lastPollAtIso: this.lastPollAtIso,
      lastError: this.lastError,
      scheduledForIso: this.scheduledForIso,
    };
  }

  async poll(): Promise<PollingStatus> {
    if (!this.enabled) {
      return this.status();
    }

    try {
      const updates = await this.getUpdates();
      for (const update of updates) {
        const message = update.message ?? update.edited_message;
        if (message) {
          await TelegramChatAgent.get(this.botName, String(message.chat.id)).handleIncomingMessage(
            update.update_id,
            message
          );
        }

        this.offset = update.update_id + 1;
        this.processedUpdates += 1;
      }

      this.consecutiveFailures = 0;
      this.lastError = '';
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = formatErrorForTelegram(error);
    }

    this.lastPollAtIso = new Date().toISOString();
    this.scheduleNext(POLL_INTERVAL_SECONDS);
    return this.status();
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({
      limit: String(GET_UPDATES_LIMIT),
      timeout: '0',
      allowed_updates: JSON.stringify(['message', 'edited_message']),
    });

    if (this.offset !== undefined) {
      params.set('offset', String(this.offset));
    }

    const response = await fetch(`https://api.telegram.org/bot${this.config.value.botToken.get()}/getUpdates?${params.toString()}`);
    const body = await response.text();

    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: ${response.status} ${body}`);
    }

    const parsed = JSON.parse(body) as TelegramGetUpdatesResponse;
    if (!parsed.ok) {
      throw new Error(`Telegram getUpdates failed: ${parsed.description ?? 'unknown error'}`);
    }

    return parsed.result ?? [];
  }

  private scheduleNext(delaySeconds: bigint): void {
    if (!this.enabled) {
      return;
    }

    const scheduledAtMs = Date.now() + Number(delaySeconds) * 1000;
    this.scheduledForIso = new Date(scheduledAtMs).toISOString();
    TelegramPollingAgent.get(this.botName).poll.schedule({
      seconds: BigInt(Math.floor(scheduledAtMs / 1000)),
      nanoseconds: 0,
    } satisfies Datetime);
  }
}
