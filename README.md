# Golem Claw

Telegram-first Golem showcase assistant with durable per-chat state, background research, daily digests, lightweight automation, and a cleaner multi-layer architecture.

## Showcase

![Golem Claw showcase 1](screenshots/1.png)

![Golem Claw showcase 2](screenshots/2.jpeg)

## What It Does

Golem Claw is a Telegram concierge that keeps durable state per `chat.id` and combines:

- a single user-facing chat agent
- durable stores for tasks, notes, goals, profile, portfolio, and conversation history
- specialist background agents for research, digests, goal coaching, and portfolio nudges
- service modules for weather, email, web research, and stock quotes
- a non-LLM orchestrator for recurring automation

## Features

- Telegram webhook ingress over Golem HTTP API
- Durable per-chat identity keyed by Telegram `chat.id`
- Full transcript storage separated from compact LLM working context
- Gemini-powered natural-language tool routing using generated JSON tool calls
- Tasks with reminders and monthly recurring task templates
- Durable notes and research notes with tags and sources
- Durable profile memory including timezone, city, email, facts, and automation preference
- Durable goals with progress logs and stale-goal follow-up metadata
- Durable portfolio holdings, watchlist, cached quotes, and linked research notes
- Background research jobs with Firecrawl search/scrape and saved note output
- Morning and evening digest generation
- Rule-based automation for digests, inactivity nudges, stale-goal follow-ups, portfolio nudges, and monthly task materialization
- Weather lookups via OpenWeather
- Email delivery via Resend
- Stock end-of-day quotes via Stooq

## Current Architecture

### Front Door

- `TelegramWebhookAgent(name)` receives webhook calls at `/telegram/{name}/webhook`
- `ChatConciergeAgent(botName, chatId)` is the only user-facing conversational agent

### Durable Stores

- `ConversationStore(botName, chatId)` stores:
  - full transcript
  - compact working history
  - rolling conversation summary
  - last user activity timestamp
- `ProfileStore(botName, chatId)` stores:
  - name
  - username
  - timezone
  - city
  - emails
  - durable facts
  - long-term memory
  - automation enabled flag
- `TaskStore(botName, chatId)` stores:
  - open tasks
  - reminders
  - monthly recurring templates
- `GoalStore(botName, chatId)` stores:
  - goals
  - progress entries
  - `lastProgressAt`
  - `lastNudgedAt`
- `NoteStore(botName, chatId)` stores:
  - plain notes
  - research notes
  - tags
  - source URLs
- `PortfolioStore(botName, chatId)` stores:
  - holdings
  - watchlist
  - cached quotes
  - research linkage

### Specialist Agents

- `ResearchAgent(botName, chatId)` runs background research and saves final notes
- `DigestAgent(botName, chatId)` writes morning and evening digests
- `GoalCoachAgent(botName, chatId)` generates tracking plans and stale-goal prompts
- `PortfolioAnalystAgent(botName, chatId)` generates lightweight portfolio nudges
- `Orchestrator(botName, chatId)` coordinates automation without using an LLM

### Service Modules

- `src/services/firecrawl-api.ts` for live web search and scraping
- `src/services/weather-api.ts` for city resolution and weather
- `src/services/email-api.ts` for email sends
- `src/services/market-data.ts` for stock quotes

## Supported Behavior

### Tasks

- add, list, complete, and delete tasks
- create reminders
- monthly recurring tasks
- monthly tasks create one instance per month and are due at month end in the saved timezone

### Notes And Research

- save, list, read, edit, delete, and search notes
- ability to add your own notes, or have chat conceirge add notes
- background research jobs create tagged research notes
- stock research links the saved note back into the portfolio store

### Profile And Memory

- save name, timezone, city, and email
- remember durable user facts and preferences
- preserve day-boundary logic using the saved timezone

### Goals

- add goals
- log progress
- generate tracking plans
- generate stale-goal follow-up prompts

### Portfolio

- add and update holdings
- preserve existing holding metadata on partial updates
- maintain a watchlist
- fetch cached end-of-day quotes
- generate stock research jobs with portfolio context

### Automation

When automation is enabled and a timezone is saved, `Orchestrator` schedules:

- morning digest at `09:00` local time
- automation sweep at `13:00` local time
- evening digest at `21:00` local time

The automation sweep handles:

- monthly task materialization
- inactivity nudges
- stale-goal follow-ups
- lightweight portfolio nudges

## Telegram Webhook

Telegram calls the webhook agent, which routes each update by incoming `message.chat.id`:

```ts
ChatConciergeAgent.get(botName, String(message.chat.id))
```

HTTP API domains:

- Local base URL: `http://golem-claw.localhost:9006`
- Local webhook URL for bot `claw`: `http://golem-claw.localhost:9006/telegram/claw/webhook`
- Local OpenAPI: `http://golem-claw.localhost:9006/openapi.yaml`

Current Cloud-based setup:

- Cloud base URL: `https://nanash-lab2.apps.golem.cloud`
- Cloud webhook URL for bot `claw`: `https://nanash-lab2.apps.golem.cloud/telegram/claw/webhook`
- Cloud OpenAPI: `https://nanash-lab2.apps.golem.cloud/openapi.yaml`

Set the Telegram webhook with the configured secret token:

```sh
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=https://nanash-lab2.apps.golem.cloud/telegram/claw/webhook&secret_token=$WEBHOOK_SECRET"
```

## Project Structure

```text
src/
  agents/
    chat-concierge-agent.ts
    digest-agent.ts
    goal-coach-agent.ts
    orchestrator.ts
    portfolio-analyst-agent.ts
    research-agent.ts
    telegram-webhook-agent.ts
    chat-tools.ts
  stores/
    conversation-store.ts
    goal-store.ts
    note-store.ts
    portfolio-store.ts
    profile-store.ts
    task-store.ts
  services/
    email-api.ts
    firecrawl-api.ts
    market-data.ts
    weather-api.ts
  gemini.ts
  reporting.ts
  telegram-api.ts
  time-utils.ts
  main.ts
```

## Deploying

### Local

Local is the default environment in `golem.yaml`.

Clean local redeploy:

```sh
golem -L deploy --yes --reset
```

Update existing local agents in place:

```sh
golem -L deploy --yes --update-agents automatic
```

Inspect the local OpenAPI spec:

```sh
curl http://golem-claw.localhost:9006/openapi.yaml
```

### Cloud

Deploy to cloud:

```sh
golem -C deploy --yes
```

Clean cloud redeploy:

```sh
golem -C deploy --yes --reset
```

## Direct Agent Testing

Examples:

```sh
golem -L agent invoke 'TaskStore("claw", "8156168316")' listTasks --no-stream
golem -L agent invoke 'ProfileStore("claw", "8156168316")' getProfileSnapshot --no-stream
golem -L agent invoke 'ConversationStore("claw", "8156168316")' getConversationState --no-stream
golem -L agent invoke 'Orchestrator("claw", "8156168316")' syncSchedules '"manual-test"' --no-stream
```

## Supported "/" commands

We support a wide variety of slash commands, that can be used to directly access the stores, without the need of chat agent.

- `/help`
- `/goals`
- `/portfolio`
- `/weather`
- `/tasks`
- `/notes`
- `/note <name>`
- `/morning`
- `/daily`
- `/watch`
- `/watchlist`
- `/stock`
- `/stock_research`
- `/research`
- `/research_jobs`
- `/reminders`


## Notes

- `chat.id` is the durable identity key throughout the system
- Most automation messages route through `ChatConciergeAgent`, while reminders send directly for reliability and are still recorded in `ConversationStore`
- The saved timezone should be treated as the source of truth for user-facing day boundaries, regardless of server timezone
- Before a public demo, move secrets out of `golem.yaml` and replace the Resend sender with a verified domain sender
