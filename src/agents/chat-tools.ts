// Defines the Gemini-visible tool surface and dispatches each tool call into stores or services.
import type { Config } from '@golemcloud/golem-ts-sdk';
import type { GeminiFunctionCall, GeminiFunctionDeclaration, TelegramConfig } from '../gemini';
import { sendEmailViaResend } from '../services/email-api';
import { scrapeWebPage, searchWeb } from '../services/firecrawl-api';
import { fetchWeatherForLocation, formatLocation, resolveCity } from '../services/weather-api';
import { GoalCoachAgent } from './goal-coach-agent';
import { ResearchAgent } from './research-agent';
import { GoalStore } from '../stores/goal-store';
import { NoteStore } from '../stores/note-store';
import { PortfolioStore } from '../stores/portfolio-store';
import { ProfileStore } from '../stores/profile-store';
import { TaskStore } from '../stores/task-store';

export type ChatToolResult = {
  tool: string;
  summary: string;
  ok?: boolean;
  [key: string]: unknown;
};

type ChatToolContext = {
  botName: string;
  chatId: string;
  config: Config<TelegramConfig>;
};

export const CHAT_TOOL_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: 'manageTasks',
    description: 'Manage the durable task list. Use this to add, complete, delete, or list tasks. Monthly recurrence means one task is created each month and due at the end of that month.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'One of: add, complete, delete, list.' },
        item: { type: 'STRING', description: 'Task text or matching task identifier.' },
        recurrence: { type: 'STRING', description: 'Optional recurrence. Use monthly for a once-a-month task due at the end of the month.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manageReminders',
    description: 'Manage active reminders. Use this to set or list reminders.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'One of: set, list.' },
        item: { type: 'STRING', description: 'Reminder text for the set action.' },
        remindAtIso: { type: 'STRING', description: 'Future ISO-8601 timestamp with timezone for the set action.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manageNotes',
    description: 'Manage durable notes and research notes, including searching by text or tag.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'One of: save, list, read, edit, delete, search.' },
        name: { type: 'STRING', description: 'Note name for read, edit, or delete.' },
        text: { type: 'STRING', description: 'Note text for save or replacement text for edit.' },
        newName: { type: 'STRING', description: 'Optional new readable note name for edit.' },
        title: { type: 'STRING', description: 'Optional new display title for edit.' },
        tags: { type: 'STRING', description: 'Optional comma-separated tags for save, edit, or search.' },
        query: { type: 'STRING', description: 'Text query for the search action.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manageProfile',
    description: 'Save user profile info or durable preferences and facts.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'One of: save_personal_info, remember_fact, list_emails.' },
        email: { type: 'STRING', description: 'Optional email address to save as default.' },
        city: { type: 'STRING', description: 'Optional default city for weather.' },
        name: { type: 'STRING', description: 'Optional display name.' },
        timezone: { type: 'STRING', description: 'Optional IANA timezone such as Asia/Kolkata.' },
        preferences: { type: 'STRING', description: 'Optional durable preferences or profile facts.' },
        fact: { type: 'STRING', description: 'Durable fact or preference to remember.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manageGoals',
    description: 'Manage tracked goals and progress.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'One of: add, list, log_progress.' },
        goal: { type: 'STRING', description: 'Goal text or goal identifier.' },
        trackingPlan: { type: 'STRING', description: 'Optional tracking plan for the add action.' },
        progress: { type: 'STRING', description: 'Progress note or measurement for the log_progress action.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'getWeather',
    description: 'Get current weather. If city is omitted, use the saved default city.',
    parameters: {
      type: 'OBJECT',
      properties: {
        city: { type: 'STRING', description: 'Optional city name. Leave empty to use the saved default city.' },
      },
    },
  },
  {
    name: 'manageResearch',
    description: 'Start or list background research jobs.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'One of: start, list.' },
        topic: { type: 'STRING', description: 'Topic or question to research for the start action.' },
        emailOnComplete: { type: 'STRING', description: 'Set to yes if the final note should be emailed on completion.' },
        emailTo: { type: 'STRING', description: 'Optional email recipient for the final note.' },
        completionTask: { type: 'STRING', description: 'Optional task to add when research completes.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'managePortfolio',
    description: 'Manage the stock portfolio, watchlist, quotes, and stock research.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'One of: add_holding, list_portfolio, add_watch, list_watch, get_quote, start_stock_research.' },
        symbol: { type: 'STRING', description: 'Ticker symbol such as AAPL, NVDA, TSLA, or VOO.' },
        shares: { type: 'STRING', description: 'Number of shares for add_holding.' },
        averageCost: { type: 'STRING', description: 'Optional average cost per share for add_holding.' },
        sector: { type: 'STRING', description: 'Optional sector such as technology or semiconductors.' },
        thesis: { type: 'STRING', description: 'Optional short reason for holding or watching the stock.' },
        focus: { type: 'STRING', description: 'Optional stock research angle such as valuation, earnings, or portfolio fit.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manageWeb',
    description: 'Search the live web or scrape a known web page.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'One of: search, scrape.' },
        query: { type: 'STRING', description: 'Search query for the search action.' },
        url: { type: 'STRING', description: 'http or https URL for the scrape action.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'sendEmail',
    description: 'Send an email. If to is omitted, use the saved default email.',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING', description: 'Optional recipient email. Leave empty to use the saved default email.' },
        subject: { type: 'STRING', description: 'Email subject.' },
        text: { type: 'STRING', description: 'Plain text email body.' },
      },
      required: ['subject', 'text'],
    },
  },
];

export async function runChatToolCall(context: ChatToolContext, functionCall: GeminiFunctionCall, updateKey: string): Promise<ChatToolResult> {
  const tool = functionCall.name;
  const args = functionCall.args;

  switch (tool) {
    case 'manageTasks':
      return runTaskAction(context, args, updateKey);
    case 'manageReminders':
      return runReminderAction(context, args, updateKey);
    case 'manageNotes':
      return runNoteAction(context, args, updateKey);
    case 'manageProfile':
      return runProfileAction(context, args, updateKey);
    case 'manageGoals':
      return runGoalAction(context, args, updateKey);
    case 'getWeather':
      return runWeatherAction(context, args);
    case 'manageResearch':
      return runResearchAction(context, args, updateKey);
    case 'managePortfolio':
      return runPortfolioAction(context, args, updateKey);
    case 'manageWeb':
      return runWebAction(context, args);
    case 'sendEmail':
      return runEmailAction(context, args);
    default:
      return { tool, ok: false, summary: `I do not know how to run the tool ${tool}.` };
  }
}

// Handles task CRUD plus monthly recurrence creation.
async function runTaskAction(context: ChatToolContext, args: Record<string, unknown>, updateKey: string): Promise<ChatToolResult> {
  const taskStore = TaskStore.get(context.botName, context.chatId);
  const action = normalizeAction(args.action);
  const profile = await ProfileStore.get(context.botName, context.chatId).getProfileSnapshot();

  switch (action) {
    case 'add':
      return taskStore.addTask(stringArg(args.item), normalizeRecurrence(args.recurrence), profile.timezone, updateKey);
    case 'complete':
      return taskStore.completeTask(stringArg(args.item), updateKey);
    case 'delete':
      return taskStore.deleteTask(stringArg(args.item), updateKey);
    case 'list':
      return taskStore.listTasks();
    default:
      return invalidAction('manageTasks', action, 'add, complete, delete, list');
  }
}

// Handles reminder scheduling and active reminder listing.
async function runReminderAction(context: ChatToolContext, args: Record<string, unknown>, updateKey: string): Promise<ChatToolResult> {
  const taskStore = TaskStore.get(context.botName, context.chatId);
  const action = normalizeAction(args.action);

  switch (action) {
    case 'set':
      return taskStore.setReminder(stringArg(args.item), stringArg(args.remindAtIso), updateKey);
    case 'list':
      return taskStore.listReminders();
    default:
      return invalidAction('manageReminders', action, 'set, list');
  }
}

// Handles note save, read, edit, delete, and search flows.
async function runNoteAction(context: ChatToolContext, args: Record<string, unknown>, updateKey: string): Promise<ChatToolResult> {
  const noteStore = NoteStore.get(context.botName, context.chatId);
  const action = normalizeAction(args.action);
  const tags = parseTags(args.tags);

  switch (action) {
    case 'save':
      return noteStore.saveNote(stringArg(args.text), tags, updateKey);
    case 'list':
      return noteStore.listNotes();
    case 'read':
      return noteStore.readNote(stringArg(args.name));
    case 'edit':
      return noteStore.editNote(stringArg(args.name), optionalStringArg(args.text), optionalStringArg(args.newName), optionalStringArg(args.title), tags, updateKey);
    case 'delete':
      return noteStore.deleteNote(stringArg(args.name), updateKey);
    case 'search':
      return noteStore.searchNotes(stringArg(args.query), tags[0]);
    default:
      return invalidAction('manageNotes', action, 'save, list, read, edit, delete, search');
  }
}

// Handles profile persistence for names, facts, cities, timezones, and emails.
async function runProfileAction(context: ChatToolContext, args: Record<string, unknown>, updateKey: string): Promise<ChatToolResult> {
  const profileStore = ProfileStore.get(context.botName, context.chatId);
  const action = normalizeAction(args.action);

  switch (action) {
    case 'save_personal_info': {
      const summaries: string[] = [];
      let ok = false;

      if (stringArg(args.email).trim().length > 0) {
        const result = await profileStore.addEmail(stringArg(args.email), 'primary', updateKey);
        summaries.push(result.summary);
        ok = ok || result.ok;
      }
      if (stringArg(args.city).trim().length > 0) {
        const result = await profileStore.setCity(stringArg(args.city), updateKey);
        summaries.push(result.summary);
        ok = ok || result.ok;
      }
      if (stringArg(args.name).trim().length > 0 || stringArg(args.timezone).trim().length > 0 || stringArg(args.preferences).trim().length > 0) {
        const result = await profileStore.saveProfile(stringArg(args.name), stringArg(args.timezone), stringArg(args.preferences), updateKey);
        summaries.push(result.summary);
        ok = ok || result.ok;
      }
      if (summaries.length === 0) {
        return { tool: 'manageProfile', ok: false, summary: 'Please provide email, city, name, timezone, or preferences to save.' };
      }
      return { tool: 'manageProfile', ok, summary: summaries.join('\n') };
    }
    case 'remember_fact':
      return profileStore.rememberFact(stringArg(args.fact), updateKey);
    case 'list_emails':
      return profileStore.listEmails();
    default:
      return invalidAction('manageProfile', action, 'save_personal_info, remember_fact, list_emails');
  }
}

// Handles goal creation, listing, and progress logging.
async function runGoalAction(context: ChatToolContext, args: Record<string, unknown>, updateKey: string): Promise<ChatToolResult> {
  const goalStore = GoalStore.get(context.botName, context.chatId);
  const action = normalizeAction(args.action);

  switch (action) {
    case 'add': {
      const goal = stringArg(args.goal);
      const trackingPlan = stringArg(args.trackingPlan).trim() || await GoalCoachAgent.get(context.botName, context.chatId).createTrackingPlan(goal);
      return goalStore.addGoal(goal, trackingPlan, updateKey);
    }
    case 'list':
      return goalStore.listGoals();
    case 'log_progress':
      return goalStore.logGoalProgress(stringArg(args.goal), stringArg(args.progress), updateKey);
    default:
      return invalidAction('manageGoals', action, 'add, list, log_progress');
  }
}

// Resolves either an explicit city or the saved default city before weather lookup.
async function runWeatherAction(context: ChatToolContext, args: Record<string, unknown>): Promise<ChatToolResult> {
  const profileStore = ProfileStore.get(context.botName, context.chatId);
  const cityArg = stringArg(args.city).trim();
  const location = cityArg.length > 0
    ? await resolveCity(context.config.value.weatherApiKey, cityArg)
    : await profileStore.getCity();

  if (!location) {
    return {
      tool: 'getWeather',
      ok: false,
      summary: cityArg.length === 0 ? 'No default city is set yet. Please save a city first.' : `I could not find a city matching ${cityArg}.`,
    };
  }

  const weather = await fetchWeatherForLocation(context.config.value.weatherApiKey, location);
  if (!weather) {
    return {
      tool: 'getWeather',
      ok: false,
      summary: `OpenWeather returned incomplete weather data for ${formatLocation(location)}.`,
    };
  }

  return {
    tool: 'getWeather',
    ok: true,
    summary: `${formatLocation(location)} is ${weather.description} at ${weather.temperatureC}C, feels like ${weather.feelsLikeC}C, humidity ${weather.humidity}%, wind ${weather.windSpeedMs} m/s.`,
    location,
    weather,
  };
}

// Starts background research jobs or lists their current status.
async function runResearchAction(context: ChatToolContext, args: Record<string, unknown>, updateKey: string): Promise<ChatToolResult> {
  const researchAgent = ResearchAgent.get(context.botName, context.chatId);
  const action = normalizeAction(args.action);

  switch (action) {
    case 'start': {
      const result = await researchAgent.startResearch(
        stringArg(args.topic),
        optionalStringArg(args.emailOnComplete),
        optionalStringArg(args.emailTo),
        optionalStringArg(args.completionTask),
        undefined,
        undefined,
        undefined,
        undefined
      );
      if (result.ok && result.job) {
        researchAgent.runResearch.trigger(result.job.id);
      }
      return result;
    }
    case 'list':
      return researchAgent.listResearch();
    default:
      return invalidAction('manageResearch', action, 'start, list');
  }
}

// Handles holdings, watchlist, quotes, and stock-specific research kickoff.
async function runPortfolioAction(context: ChatToolContext, args: Record<string, unknown>, updateKey: string): Promise<ChatToolResult> {
  const portfolioStore = PortfolioStore.get(context.botName, context.chatId);
  const action = normalizeAction(args.action);

  switch (action) {
    case 'add_holding':
      return portfolioStore.addPortfolioHolding(stringArg(args.symbol), numberArg(args.shares), optionalNumberArg(args.averageCost), optionalStringArg(args.sector), optionalStringArg(args.thesis), updateKey);
    case 'list_portfolio':
      return portfolioStore.listPortfolio();
    case 'add_watch':
      return portfolioStore.addWatchStock(stringArg(args.symbol), optionalStringArg(args.thesis), optionalStringArg(args.sector), updateKey);
    case 'list_watch':
      return portfolioStore.listWatchStocks();
    case 'get_quote':
      return portfolioStore.getStockQuote(stringArg(args.symbol));
    case 'start_stock_research': {
      const symbol = stringArg(args.symbol);
      const brief = await portfolioStore.buildResearchBrief(symbol, optionalStringArg(args.focus));
      if (!brief) {
        return { tool: 'managePortfolio', ok: false, summary: 'Please provide a stock symbol to research.' };
      }
      const result = await ResearchAgent.get(context.botName, context.chatId).startResearch(
        brief.topic,
        '',
        '',
        `Review stock research for ${symbol.trim().toUpperCase()}`,
        brief.researchBrief,
        brief.displayTopic,
        ['stock', symbol.trim().toLowerCase()],
        symbol.trim().toUpperCase()
      );
      if (result.ok && result.job) {
        ResearchAgent.get(context.botName, context.chatId).runResearch.trigger(result.job.id);
      }
      return result;
    }
    default:
      return invalidAction('managePortfolio', action, 'add_holding, list_portfolio, add_watch, list_watch, get_quote, start_stock_research');
  }
}

// Provides raw live web search or page scraping when research is too heavy.
async function runWebAction(context: ChatToolContext, args: Record<string, unknown>): Promise<ChatToolResult> {
  const action = normalizeAction(args.action);
  switch (action) {
    case 'search': {
      const result = await searchWeb(context.config.value.firecrawlApiKey, stringArg(args.query));
      return { tool: 'manageWeb', ...result };
    }
    case 'scrape': {
      const result = await scrapeWebPage(context.config.value.firecrawlApiKey, stringArg(args.url));
      return { tool: 'manageWeb', ...result };
    }
    default:
      return invalidAction('manageWeb', action, 'search, scrape');
  }
}

// Sends an email directly or falls back to the saved default recipient.
async function runEmailAction(context: ChatToolContext, args: Record<string, unknown>): Promise<ChatToolResult> {
  const profileStore = ProfileStore.get(context.botName, context.chatId);
  const to = optionalStringArg(args.to) ?? await profileStore.getDefaultEmail();
  const subject = stringArg(args.subject).trim();
  const text = stringArg(args.text).trim();
  if (!to) {
    return { tool: 'sendEmail', ok: false, summary: 'No recipient found. Save an email first or provide one explicitly.' };
  }
  if (!subject) {
    return { tool: 'sendEmail', ok: false, summary: 'Please provide an email subject.' };
  }
  if (!text) {
    return { tool: 'sendEmail', ok: false, summary: 'Please provide email body text.' };
  }

  const sentId = await sendEmailViaResend(context.config.value.resendApiKey, context.config.value.resendFromEmail, to, subject, text);
  return { tool: 'sendEmail', ok: true, summary: `Email sent to ${to}: ${subject}.`, sentId };
}

// Normalizes action names to a lowercase command token.
function normalizeAction(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Restricts recurrence handling to the one supported mode for now.
function normalizeRecurrence(value: unknown): 'monthly' | undefined {
  const normalized = normalizeAction(value);
  return normalized === 'monthly' ? 'monthly' : undefined;
}

// Returns an empty string when Gemini omits an argument entirely.
function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// Returns undefined for blank optional strings to simplify downstream branching.
function optionalStringArg(value: unknown): string | undefined {
  const trimmed = stringArg(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Converts Gemini string arguments into numbers for numeric store fields.
function numberArg(value: unknown): number {
  return typeof value === 'string' ? Number(value) : Number(value);
}

// Leaves missing numeric arguments unset instead of forcing NaN into stores.
function optionalNumberArg(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return numberArg(value);
}

// Splits comma-separated tag input into normalized durable tags.
function parseTags(value: unknown): string[] {
  return stringArg(value)
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
}

// Produces a consistent unsupported-action response across all chat tools.
function invalidAction(tool: string, action: string, supportedActions: string): ChatToolResult {
  return {
    tool,
    ok: false,
    summary: action.length > 0
      ? `Unsupported ${tool} action: ${action}. Supported actions: ${supportedActions}.`
      : `Missing action for ${tool}. Supported actions: ${supportedActions}.`,
  };
}
