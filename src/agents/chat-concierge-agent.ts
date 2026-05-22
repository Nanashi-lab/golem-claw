// Handles Telegram chat turns, direct commands, and tool-backed replies.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import {
  callGeminiAfterFunction,
  callGeminiWithFunctions,
  isGeminiQuotaError,
  type GeminiFunctionCall,
  type TelegramConfig,
} from '../gemini';
import { CHAT_TOOL_DECLARATIONS, runChatToolCall, type ChatToolResult } from './chat-tools';
import { GoalCoachAgent } from './goal-coach-agent';
import { ResearchAgent } from './research-agent';
import { DigestAgent, type EveningDigestInput, type MorningDigestInput } from './digest-agent';
import { formatErrorForTelegram, sendTelegramMessages } from '../telegram-api';
import { ConversationStore, type ChatReportContext, type ConversationState } from '../stores/conversation-store';
import { GoalStore } from '../stores/goal-store';
import { NoteStore } from '../stores/note-store';
import { PortfolioStore } from '../stores/portfolio-store';
import { ProfileStore, type ProfileSnapshot } from '../stores/profile-store';
import { TaskStore } from '../stores/task-store';
import { formatGoals, formatProfileFacts, summarizeNotes, summarizeResearchJobs, summarizeStockSnapshot, summarizeTaskSnapshot } from '../reporting';
import { currentDateKey } from '../time-utils';
import { fetchWeatherForLocation, formatLocation, resolveCity } from '../services/weather-api';
import { sendEmailViaResend } from '../services/email-api';

export type TelegramChat = {
  id: number;
  type: string;
  username?: string;
  first_name?: string;
};

export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramMessage = {
  message_id: number;
  date?: number;
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
};

type ProcessedUpdate = {
  updateId: string;
  reply: string;
};

export type EchoResponse = {
  updateId: string;
  chatId: string;
  reply: string;
  duplicate: boolean;
};
const PROCESSED_UPDATE_LIMIT = 100;

@agent()
export class ChatConciergeAgent extends BaseAgent {
  private processedUpdates: ProcessedUpdate[] = [];

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Processes one Telegram update, dedupes it, and persists the final exchange.
  async handleIncomingMessage(updateId: number, message: TelegramMessage): Promise<EchoResponse> {
    const updateKey = String(updateId);
    const text = message.text?.trim();
    const isCommand = text?.startsWith('/') === true;
    const username = message.from?.username ?? message.chat.username;

    try {
      await ProfileStore.get(this.botName, this.chatId).recordTelegramIdentity(username, message.from?.first_name ?? message.chat.first_name);
    } catch (error) {
      console.warn(`[ChatConciergeAgent ${this.chatId}] Failed to update profile identity: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    const priorResult = this.processedUpdates.find((entry) => entry.updateId === updateKey);
    if (priorResult) {
      return {
        updateId: updateKey,
        chatId: this.chatId,
        reply: priorResult.reply,
        duplicate: true,
      };
    }

    let reply: string;
    try {
      reply = text && text.length > 0 ? await this.generateAssistantReply(updateKey, text) : 'I can only respond to text messages right now.';
    } catch (error) {
      reply = formatErrorForTelegram(error);
    }

    try {
      await sendTelegramMessages(this.config.value.botToken, this.chatId, reply);
    } catch (error) {
      reply = formatErrorForTelegram(error);
    }

    this.processedUpdates.push({ updateId: updateKey, reply });
    if (this.processedUpdates.length > PROCESSED_UPDATE_LIMIT) {
      this.processedUpdates.shift();
    }

    if (text && text.length > 0) {
      const profile = await ProfileStore.get(this.botName, this.chatId).getProfileSnapshot();
      const timestampIso = new Date().toISOString();
      const dateKey = currentDateKey(profile.timezone);
      await ConversationStore.get(this.botName, this.chatId).recordChatExchange(
        text,
        reply,
        username,
        updateKey,
        isCommand ? 'command' : 'chat',
        dateKey,
        timestampIso,
        new Date().toISOString(),
        !isCommand
      );
    }

    return {
      updateId: updateKey,
      chatId: this.chatId,
      reply,
      duplicate: false,
    };
  }

  // Sends an automated message and records it in the durable conversation log.
  async deliverAutomatedMessage(source: string, text: string, includeInWorkingContext: boolean): Promise<void> {
    await sendTelegramMessages(this.config.value.botToken, this.chatId, text);
    await this.recordAutomatedMessage(source, text, includeInWorkingContext);
  }

  // Records system-originated assistant output without sending it.
  async recordAutomatedMessage(source: string, text: string, includeInWorkingContext: boolean): Promise<void> {
    const profile = await ProfileStore.get(this.botName, this.chatId).getProfileSnapshot();
    const dateKey = currentDateKey(profile.timezone);
    const timestampIso = new Date().toISOString();
    await ConversationStore.get(this.botName, this.chatId).recordAutomatedAssistantMessage(source, text, dateKey, timestampIso, includeInWorkingContext);
  }

  // Exposes lightweight chat state for automation checks.
  async getConversationState(): Promise<ConversationState> {
    return ConversationStore.get(this.botName, this.chatId).getConversationState();
  }

  // Exposes digest-friendly transcript slices for report generation.
  async getReportContext(dateKey: string): Promise<ChatReportContext> {
    return ConversationStore.get(this.botName, this.chatId).getReportContext(dateKey);
  }

  // Runs command shortcuts first, then falls back to Gemini with one tool call.
  private async generateAssistantReply(updateKey: string, messageText: string): Promise<string> {
    const profile = await ProfileStore.get(this.botName, this.chatId).getProfileSnapshot();
    const commandReply = await this.handleCommand(messageText, updateKey, profile);
    if (commandReply) {
      return commandReply;
    }

    const prompt = await this.createAssistantPrompt(messageText, profile);
    let response: string | GeminiFunctionCall;

    try {
      response = await callGeminiWithFunctions(this.config.value.geminiApiKey, prompt, CHAT_TOOL_DECLARATIONS);
    } catch (error) {
      if (isGeminiQuotaError(error)) {
        return 'The AI provider quota is temporarily exhausted. Please try again later.';
      }
      throw error;
    }

    if (typeof response === 'string') {
      return response.trim().length > 0 ? response.trim() : 'I could not think of a reply.';
    }

    const toolResult = await runChatToolCall({ botName: this.botName, chatId: this.chatId, config: this.config }, response, updateKey);

    try {
      return await this.generateChatReply(prompt, response, toolResult);
    } catch (error) {
      if (isGeminiQuotaError(error)) {
        return toolResult.summary;
      }
      throw error;
    }
  }

  // Builds the chat prompt from durable profile data plus the compact conversation context.
  private async createAssistantPrompt(messageText: string, profile: ProfileSnapshot): Promise<string> {
    const promptContext = await ConversationStore.get(this.botName, this.chatId).getPromptContext();
    const historyLines = promptContext.workingHistory.length === 0
      ? 'No earlier messages.'
      : promptContext.workingHistory.map((entry) => `${entry.role}: ${entry.text}`).join('\n');

    return [
      'You are a Telegram concierge assistant with durable stores, specialist background agents, and optional tools.',
      'You are talking in Telegram, so keep replies concise and useful.',
      'Read the conversation and either answer directly or call exactly one provided function.',
      'You can help with tasks, reminders, notes, research, goals, weather, portfolio tracking, and email.',
      'Use manageTasks for tasks. Monthly recurrence means one task per month due at the end of that month.',
      'Use manageReminders when the user asks for reminders. For the set action, always provide an absolute ISO timestamp. Use the current time below to resolve relative times.',
      'Use manageNotes to save, read, edit, delete, or search notes and research notes.',
      'Use manageProfile when the user gives profile information such as email, city, name, timezone, or durable preferences. Use remember_fact only for durable facts or preferences that add future value.',
      'Use manageGoals when the user declares a goal or wants to log progress against one.',
      'Use getWeather for current weather. If no city is saved, ask the user to save one.',
      'Use managePortfolio for holdings, watchlist items, quotes, and stock research.',
      'Use manageResearch for general research that should produce a saved note.',
      'Use manageWeb only when fresh web information is needed and research is not the better fit.',
      'If the user asks what you can do, reply directly rather than calling a tool.',
      `Current time: ${new Date().toISOString()}`,
      '',
      'Saved profile facts:',
      formatProfileFacts(profile),
      '',
      'Long-term memory:',
      profile.memory || 'No long-term memory yet.',
      '',
      'Conversation summary:',
      promptContext.summary || 'No summary yet.',
      '',
      'Recent working history:',
      historyLines,
      '',
      `Latest user message: ${messageText}`,
    ].join('\n');
  }

  // Handles slash commands that bypass the normal LLM tool flow.
  private async handleCommand(messageText: string, updateKey: string, profile: ProfileSnapshot): Promise<string | undefined> {
    if (!messageText.startsWith('/')) {
      return undefined;
    }

    const [rawCommand = '', ...rest] = messageText.split(/\s+/);
    const command = (rawCommand.split('@')[0] ?? '').toLowerCase();
    const args = rest.join(' ').trim();

    switch (command) {
      case '/start':
      case '/help':
        return [
          'I can help with tasks, notes, reminders, weather, web research, goals, portfolio tracking, and scheduled morning or evening digests.',
          'You can ask normally for any action. Slash commands are quick shortcuts for browsing or status.',
          '',
          'Commands:',
          '/notes - list saved notes',
          '/note <name> - read a note',
          '/tasks or /todos - list open tasks',
          '/reminders - list active reminders',
          '/weather - current weather for saved city',
          '/emails - list saved emails',
          '/email <address> - save default email',
          '/goals - list tracked goals',
          '/goal <goal> - add a tracked goal',
          '/portfolio - list portfolio holdings',
          '/holding <symbol> <shares> [avgCost] [sector] - add or update a holding',
          '/watchlist - list watched stocks',
          '/watch <symbol> [why it matters] - add or update a watchlist stock',
          '/stock <symbol> - get an end-of-day quote',
          '/stock_research <symbol> [focus] - start stock research with portfolio context',
          '/morning - preview today\'s morning digest',
          '/daily - preview today\'s evening digest',
          '/research <topic> - start a background research note',
          '/research_jobs - list recent research jobs',
          '/help - show this help',
          '',
          'Set your timezone with plain language like "my timezone is Asia/Kolkata" so digests and recurring monthly tasks run on time.',
        ].join('\n');
      case '/research': {
        const result = await ResearchAgent.get(this.botName, this.chatId).startResearch(args, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
        if (result.ok && result.job) {
          ResearchAgent.get(this.botName, this.chatId).runResearch.trigger(result.job.id);
        }
        return result.summary;
      }
      case '/research_jobs':
        return (await ResearchAgent.get(this.botName, this.chatId).listResearch()).summary;
      case '/notes':
        return (await NoteStore.get(this.botName, this.chatId).listNotes()).summary;
      case '/note':
        return (await NoteStore.get(this.botName, this.chatId).readNote(args)).summary;
      case '/tasks':
      case '/todos':
        return (await TaskStore.get(this.botName, this.chatId).listTasks()).summary;
      case '/reminders':
        return (await TaskStore.get(this.botName, this.chatId).listReminders()).summary;
      case '/weather':
        return this.lookupWeather('');
      case '/emails':
        return (await ProfileStore.get(this.botName, this.chatId).listEmails()).summary;
      case '/email':
        return (await ProfileStore.get(this.botName, this.chatId).addEmail(args, 'primary', updateKey)).summary;
      case '/goals':
        return (await GoalStore.get(this.botName, this.chatId).listGoals()).summary;
      case '/goal': {
        const trackingPlan = await GoalCoachAgent.get(this.botName, this.chatId).createTrackingPlan(args);
        return (await GoalStore.get(this.botName, this.chatId).addGoal(args, trackingPlan, updateKey)).summary;
      }
      case '/portfolio':
        return (await PortfolioStore.get(this.botName, this.chatId).listPortfolio()).summary;
      case '/holding': {
        const [symbol = '', sharesText = '', third = '', ...restArgs] = args.split(/\s+/).filter((part) => part.length > 0);
        const shares = Number(sharesText);
        const thirdNumber = third ? Number(third) : Number.NaN;
        const averageCost = third && Number.isFinite(thirdNumber) ? thirdNumber : undefined;
        const sector = third && !Number.isFinite(thirdNumber) ? [third, ...restArgs].join(' ') : restArgs.join(' ');
        return (await PortfolioStore.get(this.botName, this.chatId).addPortfolioHolding(symbol, shares, averageCost, sector || undefined, undefined, updateKey)).summary;
      }
      case '/watchlist':
        return (await PortfolioStore.get(this.botName, this.chatId).listWatchStocks()).summary;
      case '/watch': {
        const [symbol = '', ...watchRest] = args.split(/\s+/).filter((part) => part.length > 0);
        return (await PortfolioStore.get(this.botName, this.chatId).addWatchStock(symbol, watchRest.join(' '), undefined, updateKey)).summary;
      }
      case '/stock':
        return (await PortfolioStore.get(this.botName, this.chatId).getStockQuote(args)).summary;
      case '/stock_research': {
        const [symbol = '', ...focusRest] = args.split(/\s+/).filter((part) => part.length > 0);
        const brief = await PortfolioStore.get(this.botName, this.chatId).buildResearchBrief(symbol, focusRest.join(' '));
        if (!brief) {
          return 'Please provide a stock symbol to research.';
        }
        const result = await ResearchAgent.get(this.botName, this.chatId).startResearch(
          brief.topic,
          '',
          '',
          `Review stock research for ${symbol.toUpperCase()}`,
          brief.researchBrief,
          brief.displayTopic,
          ['stock', symbol.toLowerCase()],
          symbol.toUpperCase()
        );
        if (result.ok && result.job) {
          ResearchAgent.get(this.botName, this.chatId).runResearch.trigger(result.job.id);
        }
        return result.summary;
      }
      case '/morning':
        return this.buildMorningDigestPreview(profile);
      case '/daily':
      case '/evening':
        return this.buildEveningDigestPreview(profile, true);
      default:
        return `Unknown command: ${command}. Try /help.`;
    }
  }

  // Turns a tool result back into a plain Telegram reply.
  private async generateChatReply(prompt: string, functionCall: GeminiFunctionCall, toolResult: ChatToolResult): Promise<string> {
    const reply = await callGeminiAfterFunction(
      this.config.value.geminiApiKey,
      `${prompt}\n\nA function has already been executed. Use its result faithfully and reply with plain text only.`,
      functionCall,
      toolResult as Record<string, unknown>,
      CHAT_TOOL_DECLARATIONS
    );
    return reply.trim().length > 0 ? reply.trim() : 'I could not think of a reply.';
  }

  // Looks up weather using an explicit city or the saved default location.
  private async lookupWeather(city: string): Promise<string> {
    const profileStore = ProfileStore.get(this.botName, this.chatId);
    const location = city.trim().length > 0 ? await resolveCity(this.config.value.weatherApiKey, city) : await profileStore.getCity();
    if (!location) {
      return city.trim().length === 0 ? 'No default city is set yet. Please save a city first.' : `I could not find a city matching ${city}.`;
    }

    const weather = await fetchWeatherForLocation(this.config.value.weatherApiKey, location);
    if (!weather) {
      return `OpenWeather returned incomplete weather data for ${formatLocation(location)}.`;
    }

    return `${formatLocation(location)} is ${weather.description} at ${weather.temperatureC}C, feels like ${weather.feelsLikeC}C, humidity ${weather.humidity}%, wind ${weather.windSpeedMs} m/s.`;
  }

  // Builds a morning digest preview using the same path as automation.
  private async buildMorningDigestPreview(profile: ProfileSnapshot): Promise<string> {
    const dateKey = currentDateKey(profile.timezone);
    const input = await this.buildMorningDigestInput(dateKey, profile);
    return DigestAgent.get(this.botName, this.chatId).formatMorningDigest(input);
  }

  // Builds the evening digest and optionally sends the preview by email.
  private async buildEveningDigestPreview(profile: ProfileSnapshot, sendEmail: boolean): Promise<string> {
    const dateKey = currentDateKey(profile.timezone);
    const input = await this.buildEveningDigestInput(dateKey, profile);
    const report = await DigestAgent.get(this.botName, this.chatId).formatEveningDigest(input);
    if (!sendEmail) {
      return report;
    }

    const defaultEmail = await ProfileStore.get(this.botName, this.chatId).getDefaultEmail();
    if (!defaultEmail) {
      return report;
    }

    await sendEmailViaResend(
      this.config.value.resendApiKey,
      this.config.value.resendFromEmail,
      defaultEmail,
      `Daily check-in ${dateKey}`,
      report,
      `daily-manual-${this.botName}-${this.chatId}-${Date.now()}`
    );
    return `${report}\n\nEmailed daily check-in to ${defaultEmail}.`;
  }

  // Collects the inputs needed for the morning digest writer.
  private async buildMorningDigestInput(dateKey: string, profile: ProfileSnapshot): Promise<MorningDigestInput> {
    const taskSnapshot = await TaskStore.get(this.botName, this.chatId).getSnapshot();
    const notes = await NoteStore.get(this.botName, this.chatId).getNotes();
    const researchJobs = await ResearchAgent.get(this.botName, this.chatId).getJobs();
    const portfolio = await PortfolioStore.get(this.botName, this.chatId).getSnapshot();
    const goals = await GoalStore.get(this.botName, this.chatId).getGoals();
    const reportContext = await ConversationStore.get(this.botName, this.chatId).getReportContext(dateKey);
    const { taskText, reminderText } = summarizeTaskSnapshot(taskSnapshot, profile.timezone);

    return {
      dateKey,
      timezone: profile.timezone,
      profileFacts: formatProfileFacts(profile),
      memory: profile.memory,
      goals: formatGoals(goals),
      stocks: summarizeStockSnapshot(portfolio),
      tasks: taskText,
      reminders: reminderText,
      notesSummary: summarizeNotes(notes),
      researchSummary: summarizeResearchJobs(researchJobs),
      previousLog: reportContext.previousLog,
    };
  }

  // Collects the inputs needed for the evening digest writer.
  private async buildEveningDigestInput(dateKey: string, profile: ProfileSnapshot): Promise<EveningDigestInput> {
    const taskSnapshot = await TaskStore.get(this.botName, this.chatId).getSnapshot();
    const notes = await NoteStore.get(this.botName, this.chatId).getNotes();
    const researchJobs = await ResearchAgent.get(this.botName, this.chatId).getJobs();
    const portfolio = await PortfolioStore.get(this.botName, this.chatId).getSnapshot();
    const goals = await GoalStore.get(this.botName, this.chatId).getGoals();
    const reportContext = await ConversationStore.get(this.botName, this.chatId).getReportContext(dateKey);
    const { taskText, reminderText } = summarizeTaskSnapshot(taskSnapshot, profile.timezone);

    return {
      dateKey,
      timezone: profile.timezone,
      profileFacts: formatProfileFacts(profile),
      memory: profile.memory,
      goals: formatGoals(goals),
      stocks: summarizeStockSnapshot(portfolio),
      conversationSummary: reportContext.summary,
      tasks: taskText,
      reminders: reminderText,
      notesSummary: summarizeNotes(notes),
      researchSummary: summarizeResearchJobs(researchJobs),
      todayLog: reportContext.todayLog,
      previousLog: reportContext.previousLog,
    };
  }
}
