import { BaseAgent, agent, endpoint } from '@golemcloud/golem-ts-sdk';

type TelegramChat = {
  id: number;
  type: string;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: TelegramChat;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type EchoResponse = {
  updateId: number;
  chatId?: number;
  reply: string;
};

@agent({
  mount: '/telegram/{name}'
})
class TelegramEchoAgent extends BaseAgent {
  constructor(readonly name: string) {
    super();
  }

  @endpoint({ post: '/webhook' })
  async webhook(update: TelegramUpdate): Promise<EchoResponse> {
    const chatId = update.message?.chat.id;
    const text = update.message?.text?.trim();

    return {
      updateId: update.update_id,
      chatId,
      reply: text && text.length > 0 ? text : 'No text message found.',
    };
  }
}
