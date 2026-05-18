# Golem Claw

Telegram-first Golem showcase assistant with durable per-chat state.

## Features

- Telegram polling ingress with durable offset tracking.
- Durable `TelegramChatAgent` per Telegram `chat.id`.
- Durable todos, reminders, notes, weather city, email addresses, goals, research jobs, memory, and daily digest state.
- Gemini-powered natural-language tool routing using generated JSON tool calls.
- Firecrawl web search/scrape for web and background research.
- Resend email delivery for direct sends, daily digests, and research completion.

## Architecture

- `TelegramPollingAgent(botName)` polls Telegram `getUpdates` every 60 seconds.
- `TelegramChatAgent(botName, chatId)` owns per-chat orchestration and durable chat state.
- `TodoAgent(botName, chatId)` stores todos and scheduled reminders.
- `NoteAgent(botName, chatId)` stores notes and research notes.
- `WeatherAgent(botName, chatId)` stores default city and fetches current weather.
- `EmailAgent(botName, chatId)` stores recipients and sends via Resend.
- `FirecrawlAgent(botName)` serializes Firecrawl calls per bot.
- `ResearchAgent(botName, chatId)` runs background research, saves notes, and sends follow-ups.

## Telegram Polling

This app currently uses polling instead of webhooks, so it does not require a public HTTP API domain.
The poller stores Telegram's update offset durably and routes every update by incoming `message.chat.id`:

```ts
TelegramChatAgent.get(botName, String(message.chat.id))
```

Before starting polling, disable any Telegram webhook. Pending updates can be dropped because this is still pre-deployment state:

```sh
curl "https://api.telegram.org/bot$BOT_TOKEN/deleteWebhook?drop_pending_updates=true"
```

## Deploy To Golem Cloud

This manifest sets `cloud` as the default environment. To authenticate and deploy:

```sh
/home/chinu/code/golem-x86_64-unknown-linux-gnu -C account get
/home/chinu/code/golem-x86_64-unknown-linux-gnu deploy --yes
```

For a clean hackathon demo redeploy:

```sh
/home/chinu/code/golem-x86_64-unknown-linux-gnu deploy --yes --reset
```

To explicitly select cloud:

```sh
/home/chinu/code/golem-x86_64-unknown-linux-gnu -C deploy --yes
```

## Start The Poller

After deploying, start one poller instance for the bot name `claw`:

```sh
/home/chinu/code/golem-x86_64-unknown-linux-gnu -C agent invoke --trigger 'TelegramPollingAgent("claw")' start
```

Check status:

```sh
/home/chinu/code/golem-x86_64-unknown-linux-gnu -C agent invoke 'TelegramPollingAgent("claw")' status
```

Stop polling:

```sh
/home/chinu/code/golem-x86_64-unknown-linux-gnu -C agent invoke 'TelegramPollingAgent("claw")' stop
```

Webhook code is still present in `src/telegram-transport.ts`, but commented out for now.

## Local Testing

Deploy locally with:

```sh
/home/chinu/code/golem-x86_64-unknown-linux-gnu -L deploy --yes --reset
```

Start the local poller with:

```sh
/home/chinu/code/golem-x86_64-unknown-linux-gnu -L agent invoke --trigger 'TelegramPollingAgent("claw")' start
```

## Notes

- Secrets are currently present in `golem.yaml` for fast hackathon testing.
- Before a public demo, replace the Resend sender with a verified domain sender.
- Gemini native function responses are disabled; tool calls use generated JSON because the selected model requires `thought_signature` for native tool response turns.
