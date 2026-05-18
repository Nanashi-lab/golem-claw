import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import {
  callGemini,
  callGeminiAfterFunction,
  callGeminiWithFunctions,
  isGeminiQuotaError,
  type GeminiFunctionCall,
  type GeminiFunctionDeclaration,
  type TelegramConfig,
} from './gemini';
import { TodoAgent, type TodoResult } from './todo-agent';
import { NoteAgent, type NoteResult } from './note-agent';
import { WeatherAgent, type WeatherResult } from './weather-agent';
import { FirecrawlAgent, type FirecrawlResult } from './firecrawl-agent';
import { EmailAgent, type EmailResult } from './email-agent';
import { ResearchAgent, type ResearchResult } from './research-agent';
import { formatErrorForTelegram, sendTelegramMessages } from './telegram-api';

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

type MessageRecord = {
  role: 'user' | 'assistant';
  updateId: string;
  text: string;
  username?: string;
};

type DailyLog = {
  date: string;
  messages: MessageRecord[];
};

type ProcessedUpdate = {
  updateId: string;
  reply: string;
};

type Datetime = {
  seconds: bigint;
  nanoseconds: number;
};

type Goal = {
  id: string;
  goal: string;
  trackingPlan: string;
  status: 'active' | 'paused' | 'done';
  progress: string[];
  createdAt: string;
  updatedAt: string;
};

type GoalResult = {
  tool: 'addGoal' | 'listGoals' | 'logGoalProgress' | 'rememberFact';
  ok: boolean;
  summary: string;
  goals: Goal[];
  memory: string;
};

type UserInfoResult = {
  tool: 'addUserInfo';
  ok: boolean;
  summary: string;
};

type ToolName = 'addTodo' | 'deleteTodo' | 'listTodos' | 'setReminder' | 'listReminders' | 'saveNote' | 'listNotes' | 'readNote' | 'editNote' | 'deleteNote' | 'setCity' | 'getWeatherForCity' | 'webSearch' | 'webScrape' | 'addEmail' | 'listEmails' | 'sendEmail' | 'addUserInfo' | 'addGoal' | 'listGoals' | 'logGoalProgress' | 'rememberFact' | 'startResearch' | 'listResearch';

type ToolResult = TodoResult | NoteResult | WeatherResult | FirecrawlResult | EmailResult | UserInfoResult | GoalResult | ResearchResult | { tool: string; ok: false; summary: string };

export type EchoResponse = {
  updateId: string;
  chatId: string;
  reply: string;
  duplicate: boolean;
};

// This has been purposefully left low, for testing,
// and because of low limit threshold of free-tier gemini API

const HISTORY_LIMIT = 40;
const PROCESSED_UPDATE_LIMIT = 100;
const SUMMARY_TOKEN_THRESHOLD = 900;
const GOAL_LIMIT = 20;
const GOAL_PROGRESS_LIMIT = 20;
const DAILY_LOG_DAY_LIMIT = 14;
const DAILY_LOG_MESSAGE_LIMIT = 200;

const TOOL_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: 'addTodo',
    description: 'Add a todo item to the user durable todo list.',
    parameters: {
      type: 'OBJECT',
      properties: { item: { type: 'STRING', description: 'The todo item to add.' } },
      required: ['item'],
    },
  },
  {
    name: 'deleteTodo',
    description: 'Delete a todo item from the user durable todo list.',
    parameters: {
      type: 'OBJECT',
      properties: { item: { type: 'STRING', description: 'The todo item to delete.' } },
      required: ['item'],
    },
  },
  {
    name: 'listTodos',
    description: 'List the user durable todo items.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'setReminder',
    description: 'Set a future reminder for a todo. The reminder will message the user on Telegram at the specified time without using the LLM.',
    parameters: {
      type: 'OBJECT',
      properties: {
        item: { type: 'STRING', description: 'The todo or reminder text.' },
        remindAtIso: { type: 'STRING', description: 'The future reminder time as an ISO-8601 timestamp with timezone.' },
      },
      required: ['item', 'remindAtIso'],
    },
  },
  {
    name: 'listReminders',
    description: 'List active todo reminders that have not fired yet.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'saveNote',
    description: 'Save a durable note for the user.',
    parameters: {
      type: 'OBJECT',
      properties: { text: { type: 'STRING', description: 'The note text to save.' } },
      required: ['text'],
    },
  },
  {
    name: 'listNotes',
    description: 'List the user durable saved notes and research notes by readable note name.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'readNote',
    description: 'Read a saved note or research note by its readable note name.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING', description: 'The note name, for example research-firecrawl-v2-scrape-endpoint.' } },
      required: ['name'],
    },
  },
  {
    name: 'editNote',
    description: 'Edit a saved note or research note. Can replace full text and/or update metadata such as readable name and title.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'The note name to edit.' },
        text: { type: 'STRING', description: 'Optional replacement note text. Omit or leave empty to keep existing text.' },
        newName: { type: 'STRING', description: 'Optional new readable note name. Omit or leave empty to keep existing name.' },
        title: { type: 'STRING', description: 'Optional new display title. Omit or leave empty to keep existing title.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'deleteNote',
    description: 'Delete a saved note or research note by name.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING', description: 'The note name to delete.' } },
      required: ['name'],
    },
  },
  {
    name: 'setCity',
    description: 'Set and validate the user default city for weather lookups.',
    parameters: {
      type: 'OBJECT',
      properties: { city: { type: 'STRING', description: 'The city name to save.' } },
      required: ['city'],
    },
  },
  {
    name: 'getWeatherForCity',
    description: 'Get current weather. If city is provided, use that city. If city is omitted or empty, use the saved default city. If no default city is set, ask the user to set one.',
    parameters: {
      type: 'OBJECT',
      properties: { city: { type: 'STRING', description: 'Optional city name to check. Leave empty to use saved default city.' } },
    },
  },
  {
    name: 'webSearch',
    description: 'Search the live web with Firecrawl. Use this for current events, unknown facts, or finding pages. Returns search result titles, URLs, and descriptions only.',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: 'The web search query.' } },
      required: ['query'],
    },
  },
  {
    name: 'webScrape',
    description: 'Scrape a single web page with Firecrawl and return readable markdown. Use after a URL is known or when the user asks to read/summarize a page.',
    parameters: {
      type: 'OBJECT',
      properties: { url: { type: 'STRING', description: 'The http or https URL to scrape.' } },
      required: ['url'],
    },
  },
  {
    name: 'addEmail',
    description: 'Save or update the user default email address for email delivery.',
    parameters: {
      type: 'OBJECT',
      properties: {
        email: { type: 'STRING', description: 'The email address to save.' },
        label: { type: 'STRING', description: 'Optional label such as primary, work, personal.' },
      },
      required: ['email'],
    },
  },
  {
    name: 'listEmails',
    description: 'List saved email addresses and the default recipient.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'sendEmail',
    description: 'Send an email with Resend. Use the saved default email when to is omitted or empty.',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING', description: 'Optional recipient email. Leave empty to use saved default.' },
        subject: { type: 'STRING', description: 'Email subject.' },
        text: { type: 'STRING', description: 'Plain text email body.' },
      },
      required: ['subject', 'text'],
    },
  },
  {
    name: 'addUserInfo',
    description: 'Save basic user profile info in one step. Use this when the user provides email, city, name, timezone, or durable preferences without needing separate tools.',
    parameters: {
      type: 'OBJECT',
      properties: {
        email: { type: 'STRING', description: 'Optional email address to save as default.' },
        city: { type: 'STRING', description: 'Optional default city for weather.' },
        name: { type: 'STRING', description: 'Optional user display name.' },
        timezone: { type: 'STRING', description: 'Optional timezone or locale preference.' },
        preferences: { type: 'STRING', description: 'Optional durable preferences or important profile facts.' },
      },
    },
  },
  {
    name: 'addGoal',
    description: 'Add a durable goal and tracking plan. If the user says a broad goal like "I want to be healthy", infer useful signals such as weight, exercise, sleep, meals, mood, and energy.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal: { type: 'STRING', description: 'The goal the user wants to track.' },
        trackingPlan: { type: 'STRING', description: 'Concrete signals/check-ins the assistant should track for this goal.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'listGoals',
    description: 'List active durable goals and their tracking plans.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'logGoalProgress',
    description: 'Log progress or a measurement against a saved goal, such as weight, exercise, sleep, or completion notes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal: { type: 'STRING', description: 'Goal id, title, or matching phrase.' },
        progress: { type: 'STRING', description: 'Progress note or measurement to save.' },
      },
      required: ['goal', 'progress'],
    },
  },
  {
    name: 'rememberFact',
    description: 'Save an important long-term memory fact, preference, constraint, or user context that will matter in future chats. Do not use for one-off chit-chat.',
    parameters: {
      type: 'OBJECT',
      properties: { fact: { type: 'STRING', description: 'The durable fact or preference to remember.' } },
      required: ['fact'],
    },
  },
  {
    name: 'startResearch',
    description: 'Start a background research job. The research agent searches the web, scrapes pages sequentially, writes a research note, and sends Telegram when complete. It can also email the note and add a completion todo.',
    parameters: {
      type: 'OBJECT',
      properties: {
        topic: { type: 'STRING', description: 'The topic or question to research.' },
        emailOnComplete: { type: 'STRING', description: 'Set to yes if the final research note should be emailed when complete.' },
        emailTo: { type: 'STRING', description: 'Optional email recipient. Leave empty to use saved default email.' },
        completionTodo: { type: 'STRING', description: 'Optional todo to add when research completes, for example "Review Thailand itinerary research".' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'listResearch',
    description: 'List recent background research jobs and their note IDs when complete.',
    parameters: { type: 'OBJECT', properties: {} },
  },
];

@agent()
export class TelegramChatAgent extends BaseAgent {
  private history: MessageRecord[] = [];
  private dailyLogs: DailyLog[] = [];
  private processedUpdates: ProcessedUpdate[] = [];
  private summary = '';
  private memory = '';
  private goals: Goal[] = [];
  private dailyDigestScheduledForIso = '';
  private dailyDigestLastSentDate = '';
  private username?: string;

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  async handleIncomingMessage(update_id: number, message: TelegramMessage): Promise<EchoResponse> {
    const updateKey = String(update_id);
    const text = message.text?.trim();
    const isCommand = text?.startsWith('/') === true;
    const username = message.from?.username ?? message.chat.username;
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
      reply = text && text.length > 0
        ? await this.generateAssistantReply(updateKey, text)
        : 'I can only respond to text messages right now.';
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

    if (username) {
      this.username = username;
    }

    if (text && text.length > 0) {
      const userRecord: MessageRecord = {
        role: 'user',
        updateId: updateKey,
        text,
        username: username ?? this.username,
      };
      const assistantRecord: MessageRecord = {
        role: 'assistant',
        updateId: updateKey,
        text: reply,
        username: this.username,
      };

      this.appendDailyLog(userRecord, assistantRecord);

      if (!isCommand) {
        this.history.push(userRecord, assistantRecord);
        if (this.history.length > HISTORY_LIMIT) {
          this.history.splice(0, this.history.length - HISTORY_LIMIT);
        }

        await this.compactConversationIfNeeded();
      }
    }

    this.ensureDailyDigestScheduled();

    return {
      updateId: updateKey,
      chatId: this.chatId,
      reply,
      duplicate: false,
    };
  }

  async getHistory(): Promise<MessageRecord[]> {
    return this.history;
  }

  async getDailyLogs(): Promise<DailyLog[]> {
    return this.dailyLogs.map((log) => ({
      date: log.date,
      messages: log.messages.map((message) => ({ ...message })),
    }));
  }

  private async generateAssistantReply(updateKey: string, messageText: string): Promise<string> {
    const commandReply = await this.handleCommand(messageText, updateKey);
    if (commandReply) {
      return commandReply;
    }

    const prompt = this.createAssistantPrompt(messageText);
    let response: string | GeminiFunctionCall;

    try {
      response = await callGeminiWithFunctions(
        this.config.value.geminiApiKey,
        prompt,
        TOOL_DECLARATIONS
      );
    } catch (error) {
      if (isGeminiQuotaError(error)) {
        return 'The AI provider quota is temporarily exhausted. Please try again later.';
      }

      throw error;
    }

    if (typeof response === 'string') {
      return response.trim().length > 0 ? response.trim() : 'I could not think of a reply.';
    }

    const toolResult = await this.runToolCall(response, updateKey);

    try {
      return await this.generateChatReply(prompt, response, toolResult);
    } catch (error) {
      if (isGeminiQuotaError(error)) {
        return toolResult.summary;
      }

      throw error;
    }
  }

  private createAssistantPrompt(messageText: string): string {
    const historyLines = this.history.length === 0
      ? 'No earlier messages.'
      : this.history.map((entry) => `${entry.role === 'user' ? 'user' : 'assistant'}: ${entry.text}`).join('\n');

    return [
      'You are a chat assistant with durable conversation history and optional tools.',
      'You are talking in Telegram, so keep replies concise and useful.',
      'Read the conversation and either answer directly or call exactly one provided function.',
      'If the user is starting the chat or asks what you can do, reply directly and mention todos, notes, reminders, saved city weather, weather for any city, email, goals, web search, page scraping, and background research.',
      'If the user asks for a reminder, call setReminder with an absolute ISO timestamp. Use the current time below to resolve relative times.',
      'Use listNotes to browse saved notes and research notes, readNote to read one, editNote to replace text or update title/name, and deleteNote to remove one.',
      'Use getWeatherForCity for weather. Pass a city if the user names one; otherwise pass an empty city to use the saved default. If no default is set, ask the user to set one.',
      'Use addUserInfo when the user gives profile information such as email, city, name, timezone, or durable preferences. Use addEmail/listEmails/sendEmail for direct email management and sending.',
      'Use addGoal when the user declares a goal or says they want to track/improve something. Infer a useful tracking plan for broad goals. Use logGoalProgress for measurements or updates. Use rememberFact only for durable facts/preferences that add future value.',
      'Use webSearch for questions that need fresh/live web information. Use webScrape for a specific URL. Do not call both at the same time; you can call only one tool per reply.',
      'If the user asks you to research a topic, investigate a topic deeply, or produce a research note, call startResearch. If they ask to email the final result, set emailOnComplete to yes. If they ask for a follow-up todo, set completionTodo.',
      'Use history when the user refers to earlier messages.',
      `Current time: ${new Date().toISOString()}`,
      '',
      'Long-term memory:',
      this.memory || 'No long-term memory yet.',
      '',
      'Tracked goals:',
      this.formatGoalsForPrompt(),
      '',
      'Conversation summary:',
      this.summary || 'No summary yet.',
      '',
      'Conversation history:',
      historyLines,
      '',
      `Latest user message: ${messageText}`,
    ].join('\n');
  }

  private async runToolCall(functionCall: GeminiFunctionCall, updateKey: string): Promise<ToolResult> {
    const todoAgent = TodoAgent.get(this.botName, this.chatId);
    const noteAgent = NoteAgent.get(this.botName, this.chatId);
    const weatherAgent = WeatherAgent.get(this.botName, this.chatId);
    const firecrawlAgent = FirecrawlAgent.get(this.botName);
    const emailAgent = EmailAgent.get(this.botName, this.chatId);
    const researchAgent = ResearchAgent.get(this.botName, this.chatId);
    const tool = functionCall.name as ToolName;
    const args = functionCall.args;

    switch (tool) {
      case 'addTodo': {
        const item = typeof args.item === 'string' ? args.item : '';
        return todoAgent.addTodo(item, updateKey);
      }
      case 'deleteTodo': {
        const item = typeof args.item === 'string' ? args.item : '';
        return todoAgent.deleteTodo(item, updateKey);
      }
      case 'listTodos':
        return todoAgent.listTodos();
      case 'setReminder': {
        const item = typeof args.item === 'string' ? args.item : '';
        const remindAtIso = typeof args.remindAtIso === 'string' ? args.remindAtIso : '';
        return todoAgent.setReminder(item, remindAtIso, updateKey);
      }
      case 'listReminders':
        return todoAgent.listReminders();
      case 'saveNote': {
        const text = typeof args.text === 'string' ? args.text : '';
        return noteAgent.saveNote(text, updateKey);
      }
      case 'listNotes':
        return noteAgent.listNotes();
      case 'readNote': {
        const name = typeof args.name === 'string' ? args.name : '';
        return noteAgent.readNote(name);
      }
      case 'editNote': {
        const name = typeof args.name === 'string' ? args.name : '';
        const text = typeof args.text === 'string' ? args.text : undefined;
        const newName = typeof args.newName === 'string' ? args.newName : '';
        const title = typeof args.title === 'string' ? args.title : '';
        return noteAgent.editNote(name, text, newName, title, updateKey);
      }
      case 'deleteNote': {
        const name = typeof args.name === 'string' ? args.name : '';
        return noteAgent.deleteNote(name, updateKey);
      }
      case 'setCity': {
        const city = typeof args.city === 'string' ? args.city : '';
        return weatherAgent.setCity(city, updateKey);
      }
      case 'getWeatherForCity': {
        const city = typeof args.city === 'string' ? args.city : '';
        return weatherAgent.getWeatherForCity(city);
      }
      case 'webSearch': {
        const query = typeof args.query === 'string' ? args.query : '';
        return firecrawlAgent.webSearch(query);
      }
      case 'webScrape': {
        const url = typeof args.url === 'string' ? args.url : '';
        return firecrawlAgent.webScrape(url);
      }
      case 'addEmail': {
        const email = typeof args.email === 'string' ? args.email : '';
        const label = typeof args.label === 'string' ? args.label : undefined;
        return emailAgent.addEmail(email, label, updateKey);
      }
      case 'listEmails':
        return emailAgent.listEmails();
      case 'sendEmail': {
        const to = typeof args.to === 'string' ? args.to : undefined;
        const subject = typeof args.subject === 'string' ? args.subject : '';
        const text = typeof args.text === 'string' ? args.text : '';
        return emailAgent.sendEmail(to, subject, text, updateKey);
      }
      case 'addUserInfo': {
        const email = typeof args.email === 'string' ? args.email : '';
        const city = typeof args.city === 'string' ? args.city : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const timezone = typeof args.timezone === 'string' ? args.timezone : '';
        const preferences = typeof args.preferences === 'string' ? args.preferences : '';
        return this.addUserInfo(email, city, name, timezone, preferences, updateKey);
      }
      case 'addGoal': {
        const goal = typeof args.goal === 'string' ? args.goal : '';
        const trackingPlan = typeof args.trackingPlan === 'string' ? args.trackingPlan : '';
        return this.addGoal(goal, trackingPlan, updateKey);
      }
      case 'listGoals':
        return this.listGoals();
      case 'logGoalProgress': {
        const goal = typeof args.goal === 'string' ? args.goal : '';
        const progress = typeof args.progress === 'string' ? args.progress : '';
        return this.logGoalProgress(goal, progress);
      }
      case 'rememberFact': {
        const fact = typeof args.fact === 'string' ? args.fact : '';
        return this.rememberFact(fact);
      }
      case 'startResearch': {
        const topic = typeof args.topic === 'string' ? args.topic : '';
        const emailOnComplete = typeof args.emailOnComplete === 'string' ? args.emailOnComplete : '';
        const emailTo = typeof args.emailTo === 'string' ? args.emailTo : '';
        const completionTodo = typeof args.completionTodo === 'string' ? args.completionTodo : '';
        const result = await researchAgent.startResearch(topic, emailOnComplete, emailTo, completionTodo);
        if (result.ok && result.job) {
          researchAgent.runResearch.trigger(result.job.id);
        }
        return result;
      }
      case 'listResearch':
        return researchAgent.listResearch();
      default:
        return {
          tool: functionCall.name,
          ok: false,
          summary: `I do not know how to run the tool ${functionCall.name}.`,
        };
    }
  }

  private async handleCommand(messageText: string, updateKey: string): Promise<string | undefined> {
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
          'I can help with todos, notes, reminders, weather, web search, page scraping, and background research.',
          'You can ask normally for any action. Slash commands are only quick shortcuts for browsing/status.',
          '',
          'Commands:',
          '/notes - list saved notes',
          '/note <name> - read a note',
          '/todos - list todos',
          '/reminders - list active reminders',
          '/weather - current weather for saved city',
          '/emails - list saved emails',
          '/email <address> - save default email',
          '/goals - list tracked goals',
          '/goal <goal> - add a tracked goal',
          '/daily - send today\'s digest now',
          '/research <topic> - start a background research note',
          '/research_jobs - list recent research jobs',
          '/help - show this help',
          '',
          'Ask in plain language to add/edit/delete notes or todos, set reminders, set city, search the web, or scrape pages.',
        ].join('\n');
      case '/research': {
        const result = await ResearchAgent.get(this.botName, this.chatId).startResearch(args, '', '', '');
        if (result.ok && result.job) {
          ResearchAgent.get(this.botName, this.chatId).runResearch.trigger(result.job.id);
        }
        return result.summary;
      }
      case '/research_jobs': {
        const result = await ResearchAgent.get(this.botName, this.chatId).listResearch();
        return result.summary;
      }
      case '/notes': {
        const result = await NoteAgent.get(this.botName, this.chatId).listNotes();
        return result.summary;
      }
      case '/note': {
        const result = await NoteAgent.get(this.botName, this.chatId).readNote(args);
        return result.summary;
      }
      case '/todos': {
        const result = await TodoAgent.get(this.botName, this.chatId).listTodos();
        return result.summary;
      }
      case '/reminders': {
        const result = await TodoAgent.get(this.botName, this.chatId).listReminders();
        return result.summary;
      }
      case '/weather': {
        const result = await WeatherAgent.get(this.botName, this.chatId).getWeatherForCity('');
        return result.summary;
      }
      case '/emails': {
        const result = await EmailAgent.get(this.botName, this.chatId).listEmails();
        return result.summary;
      }
      case '/email': {
        const result = await EmailAgent.get(this.botName, this.chatId).addEmail(args, 'primary', updateKey);
        return result.summary;
      }
      case '/goals': {
        const result = this.listGoals();
        return result.summary;
      }
      case '/goal': {
        const trackingPlan = await this.inferTrackingPlan(args);
        const result = await this.addGoal(args, trackingPlan, updateKey);
        return result.summary;
      }
      case '/daily':
        return this.sendDailyDigestNow();
      default:
        return `Unknown command: ${command}. Try /help.`;
    }
  }

  private async generateChatReply(
    prompt: string,
    functionCall: GeminiFunctionCall,
    toolResult: ToolResult
  ): Promise<string> {
    const reply = await callGeminiAfterFunction(
      this.config.value.geminiApiKey,
      `${prompt}\n\nA function has already been executed. Use its result faithfully and reply with plain text only.`,
      functionCall,
      toolResult as unknown as Record<string, unknown>,
      TOOL_DECLARATIONS
    );
    return reply.trim().length > 0 ? reply.trim() : 'I could not think of a reply.';
  }

  private async compactConversationIfNeeded(): Promise<void> {
    const historyText = this.history.map((entry) => `${entry.role}: ${entry.text}`).join('\n');
    const historyTokens = this.roughTokenCount(historyText);

    if (historyTokens >= SUMMARY_TOKEN_THRESHOLD) {
      await this.updateSummary(historyText);
      this.history = this.history.slice(-6);
    }
  }

  private appendDailyLog(userRecord: MessageRecord, assistantRecord: MessageRecord): void {
    const date = new Date().toISOString().slice(0, 10);
    let log = this.dailyLogs.find((entry) => entry.date === date);
    if (!log) {
      log = { date, messages: [] };
      this.dailyLogs.push(log);
      this.dailyLogs.sort((a, b) => a.date.localeCompare(b.date));
      if (this.dailyLogs.length > DAILY_LOG_DAY_LIMIT) {
        this.dailyLogs.splice(0, this.dailyLogs.length - DAILY_LOG_DAY_LIMIT);
      }
    }

    log.messages.push(userRecord, assistantRecord);
    if (log.messages.length > DAILY_LOG_MESSAGE_LIMIT) {
      log.messages.splice(0, log.messages.length - DAILY_LOG_MESSAGE_LIMIT);
    }
  }

  private async updateSummary(historyText: string): Promise<void> {
    try {
      const summary = await callGemini(
        this.config.value.geminiApiKey,
        [
          'Update the durable conversation summary for this Telegram assistant.',
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
    } catch {
      // Memory maintenance must never break the user-facing chat path.
    }
  }

  private async updateMemoryFromFact(fact: string): Promise<void> {
    try {
      const memory = await callGemini(
        this.config.value.geminiApiKey,
        [
          'Update long-term memory for this Telegram assistant from one explicit durable fact.',
          'Only keep facts likely to matter in future chats: user preferences, important personal facts, standing projects, goals, and recurring constraints.',
          'Merge with existing memory and remove contradictions. Do not add generic filler.',
          'Keep it as concise bullet points.',
          '',
          'Existing memory:',
          this.memory || 'None.',
          '',
          'Tracked goals:',
          this.formatGoalsForPrompt(),
          '',
          'New durable fact:',
          fact,
        ].join('\n')
      );
      this.memory = memory.slice(0, 4000);
    } catch {
      // Memory maintenance must never break the user-facing chat path.
    }
  }

  private async addUserInfo(
    email: string,
    city: string,
    name: string,
    timezone: string,
    preferences: string,
    updateKey: string
  ): Promise<UserInfoResult> {
    const summaries: string[] = [];
    const facts: string[] = [];

    if (email.trim().length > 0) {
      const result = await EmailAgent.get(this.botName, this.chatId).addEmail(email, 'primary', updateKey);
      summaries.push(result.summary);
      if (result.ok) {
        facts.push(`User email: ${email.trim().toLowerCase()}.`);
      }
    }

    if (city.trim().length > 0) {
      const result = await WeatherAgent.get(this.botName, this.chatId).setCity(city, updateKey);
      summaries.push(result.summary);
      if (result.ok) {
        facts.push(`User default city: ${result.location?.name ?? city.trim()}.`);
      }
    }

    if (name.trim().length > 0) {
      facts.push(`User name: ${name.trim()}.`);
    }
    if (timezone.trim().length > 0) {
      facts.push(`User timezone/locale preference: ${timezone.trim()}.`);
    }
    if (preferences.trim().length > 0) {
      facts.push(`User preference/profile info: ${preferences.trim()}.`);
    }

    if (facts.length > 0) {
      await this.updateMemoryFromFact(facts.join(' '));
    }

    if (summaries.length === 0 && facts.length === 0) {
      return {
        tool: 'addUserInfo',
        ok: false,
        summary: 'Please provide email, city, name, timezone, or preferences to save.',
      };
    }

    return {
      tool: 'addUserInfo',
      ok: true,
      summary: [...summaries, facts.length > 0 ? 'Saved profile details to memory.' : ''].filter((line) => line.length > 0).join('\n'),
    };
  }

  private async addGoal(goal: string, trackingPlan: string, updateKey?: string): Promise<GoalResult> {
    const trimmedGoal = goal.trim();
    const trimmedPlan = trackingPlan.trim() || 'Check in on concrete progress, blockers, habits, and measurable signals relevant to this goal.';

    if (trimmedGoal.length === 0) {
      return this.makeGoalResult('addGoal', 'Please provide a goal to track.', false);
    }

    const existing = this.goals.find((entry) => entry.goal.toLowerCase() === trimmedGoal.toLowerCase());
    if (existing) {
      existing.trackingPlan = trimmedPlan;
      existing.updatedAt = new Date().toISOString();
      await this.updateMemoryFromFact(`User goal: ${existing.goal}. Tracking plan: ${existing.trackingPlan}.`);
      return this.makeGoalResult('addGoal', `Updated goal ${existing.id}: ${existing.goal}.`, true);
    }

    const now = new Date().toISOString();
    const goalEntry: Goal = {
      id: this.uniqueGoalId(`goal-${this.slugify(trimmedGoal)}`),
      goal: trimmedGoal,
      trackingPlan: trimmedPlan,
      status: 'active',
      progress: [],
      createdAt: now,
      updatedAt: now,
    };
    this.goals.push(goalEntry);
    if (this.goals.length > GOAL_LIMIT) {
      this.goals.shift();
    }

    await this.updateMemoryFromFact(`User goal: ${goalEntry.goal}. Tracking plan: ${goalEntry.trackingPlan}.`);
    return this.makeGoalResult('addGoal', `Tracking goal ${goalEntry.id}: ${goalEntry.goal}\nPlan: ${goalEntry.trackingPlan}`, true);
  }

  private listGoals(): GoalResult {
    if (this.goals.length === 0) {
      return this.makeGoalResult('listGoals', 'No goals are being tracked yet.', true);
    }

    return this.makeGoalResult(
      'listGoals',
      `Tracked goals:\n${this.goals.map((goal) => `- ${goal.id}: ${goal.goal}\n  Plan: ${goal.trackingPlan}`).join('\n')}`,
      true
    );
  }

  private async logGoalProgress(goal: string, progress: string): Promise<GoalResult> {
    const goalEntry = this.findGoal(goal);
    const trimmedProgress = progress.trim();

    if (!goalEntry) {
      return this.makeGoalResult('logGoalProgress', `I could not find a goal matching: ${goal}.`, false);
    }
    if (trimmedProgress.length === 0) {
      return this.makeGoalResult('logGoalProgress', 'Please provide progress to log.', false);
    }

    goalEntry.progress.push(`${new Date().toISOString()}: ${trimmedProgress}`);
    if (goalEntry.progress.length > GOAL_PROGRESS_LIMIT) {
      goalEntry.progress.shift();
    }
    goalEntry.updatedAt = new Date().toISOString();
    await this.updateMemoryFromFact(`Progress on ${goalEntry.goal}: ${trimmedProgress}`);
    return this.makeGoalResult('logGoalProgress', `Logged progress for ${goalEntry.goal}: ${trimmedProgress}`, true);
  }

  private async rememberFact(fact: string): Promise<GoalResult> {
    const trimmed = fact.trim();
    if (trimmed.length === 0) {
      return this.makeGoalResult('rememberFact', 'Please provide something important to remember.', false);
    }

    await this.updateMemoryFromFact(trimmed);
    return this.makeGoalResult('rememberFact', 'I saved that to long-term memory.', true);
  }

  private makeGoalResult(tool: GoalResult['tool'], summary: string, ok: boolean): GoalResult {
    return {
      tool,
      ok,
      summary,
      goals: this.goals.map((goal) => ({ ...goal, progress: [...goal.progress] })),
      memory: this.memory,
    };
  }

  private async inferTrackingPlan(goal: string): Promise<string> {
    if (goal.trim().length === 0) {
      return '';
    }

    try {
      return (await callGemini(
        this.config.value.geminiApiKey,
        [
          'Create a concise tracking plan for this user goal.',
          'Include 3-5 concrete signals the assistant should ask about or track.',
          'Reply as one short sentence or semicolon-separated phrase, no markdown.',
          '',
          `Goal: ${goal}`,
        ].join('\n')
      )).slice(0, 800);
    } catch {
      return 'Check in on concrete progress, blockers, habits, and measurable signals relevant to this goal.';
    }
  }

  async sendDailyDigest(dateKey: string): Promise<void> {
    if (this.dailyDigestLastSentDate === dateKey) {
      this.ensureDailyDigestScheduled();
      return;
    }

    const digest = await this.createDailyDigest(dateKey);
    this.dailyDigestLastSentDate = dateKey;
    await sendTelegramMessages(this.config.value.botToken, this.chatId, digest);

    const emailAgent = EmailAgent.get(this.botName, this.chatId);
    const defaultEmail = await emailAgent.getDefaultEmail();
    if (defaultEmail) {
      await emailAgent.sendStoredEmail(`Daily check-in ${dateKey}`, digest, `daily-${this.botName}-${this.chatId}-${dateKey}`);
    }

    this.ensureDailyDigestScheduled();
  }

  private async sendDailyDigestNow(): Promise<string> {
    const dateKey = new Date().toISOString().slice(0, 10);
    const digest = await this.createDailyDigest(dateKey);

    const emailAgent = EmailAgent.get(this.botName, this.chatId);
    const defaultEmail = await emailAgent.getDefaultEmail();
    if (defaultEmail) {
      const emailResult = await emailAgent.sendStoredEmail(`Daily check-in ${dateKey}`, digest, `daily-manual-${this.botName}-${this.chatId}-${Date.now()}`);
      return `${digest}\n\n${emailResult.summary}`;
    }

    return digest;
  }

  private async createDailyDigest(dateKey: string): Promise<string> {
    const todos = await TodoAgent.get(this.botName, this.chatId).getTodos();
    const notes = await NoteAgent.get(this.botName, this.chatId).listNotes();
    const research = await ResearchAgent.get(this.botName, this.chatId).listResearch();
    const todayLog = this.formatDailyLog(dateKey);
    const previousLog = this.formatPreviousDailyLog(dateKey);

    try {
      return (await callGemini(
        this.config.value.geminiApiKey,
        [
          'Write a concise end-of-day Telegram check-in for the user.',
          'Use durable memory, tracked goals, conversation summary, todos, notes, research jobs, and the full daily chat log.',
          'Include: what mattered today, open loops, goal prompts, and 1-3 specific questions the user can answer tomorrow or now.',
          'If research finished, mention the note name and any useful follow-up. If notes/todos changed, mention them concretely.',
          'Be useful, not generic. Keep it under 1200 characters.',
          '',
          `Date: ${dateKey}`,
          '',
          'Memory:',
          this.memory || 'None.',
          '',
          'Goals:',
          this.formatGoalsForPrompt(),
          '',
          'Summary:',
          this.summary || 'None.',
          '',
          'Todos:',
          todos.length === 0 ? 'None.' : todos.map((todo) => `- ${todo}`).join('\n'),
          '',
          'Notes:',
          notes.summary,
          '',
          'Research jobs:',
          research.summary,
          '',
          'Today full chat log:',
          todayLog,
          '',
          'Previous available day chat log:',
          previousLog,
        ].join('\n')
      )).trim();
    } catch {
      const goalText = this.goals.length === 0 ? 'No tracked goals yet.' : this.goals.map((goal) => `- ${goal.goal}: ${goal.trackingPlan}`).join('\n');
      const todoText = todos.length === 0 ? 'No open todos.' : todos.map((todo) => `- ${todo}`).join('\n');
      return [`Daily check-in ${dateKey}`, '', 'Goals:', goalText, '', 'Todos:', todoText, '', 'What should I help you move forward tomorrow?'].join('\n');
    }
  }

  private formatDailyLog(dateKey: string): string {
    const log = this.dailyLogs.find((entry) => entry.date === dateKey);
    if (!log || log.messages.length === 0) {
      return 'No messages logged for this day.';
    }

    return this.truncate(
      log.messages.map((entry) => `${entry.role}${entry.username ? ` (${entry.username})` : ''}: ${entry.text}`).join('\n'),
      12000
    );
  }

  private formatPreviousDailyLog(dateKey: string): string {
    const previous = [...this.dailyLogs]
      .filter((entry) => entry.date < dateKey)
      .sort((a, b) => b.date.localeCompare(a.date))[0];

    if (!previous) {
      return 'No previous day log available.';
    }

    return `${previous.date}\n${this.truncate(previous.messages.map((entry) => `${entry.role}: ${entry.text}`).join('\n'), 5000)}`;
  }

  private ensureDailyDigestScheduled(): void {
    const next = this.nextDailyDigestTime();
    if (this.dailyDigestScheduledForIso === next.iso) {
      return;
    }

    this.dailyDigestScheduledForIso = next.iso;
    TelegramChatAgent.get(this.botName, this.chatId).sendDailyDigest.schedule(next.scheduleAt, next.dateKey);
  }

  private nextDailyDigestTime(): { iso: string; dateKey: string; scheduleAt: Datetime } {
    const now = new Date();
    const target = new Date(now.getTime());
    target.setHours(21, 0, 0, 0);
    if (target.getTime() <= now.getTime() + 5 * 60 * 1000) {
      target.setDate(target.getDate() + 1);
    }

    return {
      iso: target.toISOString(),
      dateKey: target.toISOString().slice(0, 10),
      scheduleAt: {
        seconds: BigInt(Math.floor(target.getTime() / 1000)),
        nanoseconds: 0,
      },
    };
  }

  private formatGoalsForPrompt(): string {
    if (this.goals.length === 0) {
      return 'No tracked goals yet.';
    }

    return this.goals.map((goal) => [
      `${goal.id}: ${goal.goal} [${goal.status}]`,
      `Tracking: ${goal.trackingPlan}`,
      goal.progress.length > 0 ? `Recent progress: ${goal.progress.slice(-5).join(' | ')}` : 'Recent progress: none',
    ].join('\n')).join('\n\n');
  }

  private findGoal(goal: string): Goal | undefined {
    const normalized = goal.trim().toLowerCase();
    return this.goals.find((entry) =>
      entry.id.toLowerCase() === normalized
      || entry.goal.toLowerCase() === normalized
      || entry.goal.toLowerCase().includes(normalized)
    );
  }

  private uniqueGoalId(baseId: string): string {
    let candidate = baseId;
    let suffix = 2;

    while (this.goals.some((goal) => goal.id === candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private slugify(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'goal';
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }

    return `${text.slice(0, maxChars)}\n\n[truncated]`;
  }

  private roughTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
