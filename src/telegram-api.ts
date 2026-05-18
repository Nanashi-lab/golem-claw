import type { Secret } from '@golemcloud/golem-ts-sdk';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_CHUNK_SIZE = 3900;

export async function sendTelegramMessages(
  botToken: Secret<string>,
  chatId: string,
  text: string
): Promise<void> {
  const chunks = splitTelegramMessage(text);

  for (const chunk of chunks) {
    await sendTelegramMessage(botToken, chatId, chunk);
  }
}

export function formatErrorForTelegram(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Something went wrong: unknown error.';
  }

  const message = error.message
    .replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/re_[A-Za-z0-9_]+/g, 're_<redacted>')
    .replace(/key=[A-Za-z0-9_-]+/g, 'key=<redacted>')
    .slice(0, 500);

  return `Something went wrong: ${message}`;
}

async function sendTelegramMessage(
  botToken: Secret<string>,
  chatId: string,
  text: string
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken.get()}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }

  await response.json();
}

function splitTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += TELEGRAM_CHUNK_SIZE) {
    chunks.push(text.slice(index, index + TELEGRAM_CHUNK_SIZE));
  }
  return chunks;
}
