// Webhook transport is declared but unused while the hackathon deployment uses
// TelegramPollingAgent. Keep the agent type available so existing provision
// config does not reference a missing agent, but do not expose it in golem.yaml.

// Not part of the agents which will get accessed. This I think is the superior way to
// Do a telegram agents over polling constantly, but I could not deploy http api
// So decided to go with polling

import { BaseAgent, Config, agent, endpoint } from '@golemcloud/golem-ts-sdk';
import { TelegramChatAgent, type EchoResponse, type TelegramMessage } from './chat-agent';
import type { TelegramConfig } from './gemini';

type WebhookResponse = {
  accepted: boolean;
  updateId: string;
  chatId?: string;
  reply?: string;
  duplicate?: boolean;
  ignored?: boolean;
};

@agent({
  mount: '/telegram/{name}',
  mode: 'ephemeral'
})
export class TelegramWebhookAgent extends BaseAgent {
  constructor(readonly name: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  @endpoint({
    post: '/webhook',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secretToken' }
  })
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
      return {
        accepted: true,
        updateId: String(update_id),
        ignored: true,
      };
    }

    const chatId = String(incomingMessage.chat.id);
    const result: EchoResponse = await TelegramChatAgent.get(this.name, chatId).handleIncomingMessage(
      update_id,
      incomingMessage
    );

    return {
      accepted: true,
      ...result,
    };
  }
}
