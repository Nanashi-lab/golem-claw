// Exposes the stable Telegram webhook endpoint and forwards updates into the concierge.
import { BaseAgent, Config, agent, endpoint } from '@golemcloud/golem-ts-sdk';
import { ChatConciergeAgent, type EchoResponse, type TelegramMessage } from './chat-concierge-agent';
import type { TelegramConfig } from '../gemini';
import { Orchestrator } from './orchestrator';

type WebhookResponse = {
  accepted: boolean;
  updateId: string;
  chatId?: string;
  reply?: string;
  duplicate?: boolean;
  ignored?: boolean;
};

@agent({ mount: '/telegram/{name}', mode: 'ephemeral' })
export class TelegramWebhookAgent extends BaseAgent {
  constructor(readonly name: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Validates the webhook secret, handles the update, and refreshes schedules.
  @endpoint({ post: '/webhook', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secretToken' } })
  async webhook(
    secretToken: string | undefined,
    update_id: number,
    message?: TelegramMessage,
    edited_message?: TelegramMessage
  ): Promise<WebhookResponse> {
    const expectedSecret = this.config.value.webhookSecret.get();
    if (secretToken !== expectedSecret) {
      throw new Error('Invalid Telegram webhook secret');
    }

    const incomingMessage = message ?? edited_message;
    if (!incomingMessage) {
      return { accepted: true, updateId: String(update_id), ignored: true };
    }

    const chatId = String(incomingMessage.chat.id);
    const result: EchoResponse = await ChatConciergeAgent.get(this.name, chatId).handleIncomingMessage(update_id, incomingMessage);

    try {
      await Orchestrator.get(this.name, chatId).syncSchedules('telegram-update');
    } catch (error) {
      console.warn(`[TelegramWebhookAgent ${this.name}] Orchestrator sync failed for chat ${chatId}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    return {
      accepted: true,
      ...result,
    };
  }
}
