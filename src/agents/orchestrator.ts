// Schedules digests and lightweight automation using hard rules instead of LLM planning.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import type { TelegramConfig } from '../gemini';
import { ChatConciergeAgent } from './chat-concierge-agent';
import { DigestAgent, type EveningDigestInput, type MorningDigestInput } from './digest-agent';
import { GoalCoachAgent } from './goal-coach-agent';
import { PortfolioAnalystAgent } from './portfolio-analyst-agent';
import { sendEmailViaResend } from '../services/email-api';
import { ConversationStore } from '../stores/conversation-store';
import { GoalStore } from '../stores/goal-store';
import { NoteStore } from '../stores/note-store';
import { PortfolioStore } from '../stores/portfolio-store';
import { ProfileStore } from '../stores/profile-store';
import { TaskStore } from '../stores/task-store';
import { ResearchAgent } from './research-agent';
import { formatGoals, formatProfileFacts, summarizeNotes, summarizeResearchJobs, summarizeStockSnapshot, summarizeTaskSnapshot } from '../reporting';
import { currentDateKey, getLocalTimeParts } from '../time-utils';

type Datetime = {
  seconds: bigint;
  nanoseconds: number;
};

type ScheduledRun = {
  iso: string;
  dateKey: string;
  scheduleAt: Datetime;
};

const MORNING_HOUR = 9;
const EVENING_HOUR = 21;
const AUTOMATION_HOUR = 13;
const SCHEDULE_LEAD_MINUTES = 5;
const SEARCH_WINDOW_MINUTES = 72 * 60;
const INACTIVITY_HOURS = 24;
const GOAL_STALE_DAYS = 3;

@agent()
export class Orchestrator extends BaseAgent {
  private morningScheduledForIso = '';
  private eveningScheduledForIso = '';
  private automationScheduledForIso = '';
  private morningLastSentDate = '';
  private eveningLastSentDate = '';
  private lastInactivityNudgeDate = '';
  private lastPortfolioNudgeDate = '';

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Keeps the next local morning, evening, and automation runs scheduled.
  async syncSchedules(reason: string): Promise<void> {
    console.info(`[Orchestrator ${this.chatId}] Syncing schedules: ${reason}`);
    const profileStore = ProfileStore.get(this.botName, this.chatId);
    if (!(await profileStore.isAutomationEnabled())) {
      return;
    }

    const timezone = await profileStore.getTimezone();
    if (!timezone) {
      console.info(`[Orchestrator ${this.chatId}] No timezone saved yet; skipping recurring schedules`);
      return;
    }

    const morning = this.nextLocalRunTime(timezone, MORNING_HOUR, 0);
    if (this.morningScheduledForIso !== morning.iso) {
      this.morningScheduledForIso = morning.iso;
      Orchestrator.get(this.botName, this.chatId).runMorningDigest.schedule(morning.scheduleAt, morning.iso, morning.dateKey);
    }

    const evening = this.nextLocalRunTime(timezone, EVENING_HOUR, 0);
    if (this.eveningScheduledForIso !== evening.iso) {
      this.eveningScheduledForIso = evening.iso;
      Orchestrator.get(this.botName, this.chatId).runEveningDigest.schedule(evening.scheduleAt, evening.iso, evening.dateKey);
    }

    const automation = this.nextLocalRunTime(timezone, AUTOMATION_HOUR, 0);
    if (this.automationScheduledForIso !== automation.iso) {
      this.automationScheduledForIso = automation.iso;
      Orchestrator.get(this.botName, this.chatId).runAutomationSweep.schedule(automation.scheduleAt, automation.iso, automation.dateKey);
    }
  }

  // Sends the morning digest once for the intended local day.
  async runMorningDigest(expectedIso: string, dateKey: string): Promise<void> {
    if (this.morningScheduledForIso !== expectedIso || this.morningLastSentDate === dateKey) {
      await this.syncSchedules('morning-skip');
      return;
    }

    const input = await this.buildMorningInput(dateKey);
    const message = await DigestAgent.get(this.botName, this.chatId).formatMorningDigest(input);
    await ChatConciergeAgent.get(this.botName, this.chatId).deliverAutomatedMessage('digest-morning', message, false);
    this.morningLastSentDate = dateKey;
    await this.syncSchedules('morning-sent');
  }

  // Sends the evening digest and optionally emails the same report.
  async runEveningDigest(expectedIso: string, dateKey: string): Promise<void> {
    if (this.eveningScheduledForIso !== expectedIso || this.eveningLastSentDate === dateKey) {
      await this.syncSchedules('evening-skip');
      return;
    }

    const input = await this.buildEveningInput(dateKey);
    const message = await DigestAgent.get(this.botName, this.chatId).formatEveningDigest(input);
    await ChatConciergeAgent.get(this.botName, this.chatId).deliverAutomatedMessage('digest-evening', message, false);
    this.eveningLastSentDate = dateKey;

    const defaultEmail = await ProfileStore.get(this.botName, this.chatId).getDefaultEmail();
    if (defaultEmail) {
      await sendEmailViaResend(
        this.config.value.resendApiKey,
        this.config.value.resendFromEmail,
        defaultEmail,
        `Daily check-in ${dateKey}`,
        message,
        `daily-${this.botName}-${this.chatId}-${dateKey}`
      );
    }

    await this.syncSchedules('evening-sent');
  }

  // Runs the non-LLM automation sweep for nudges and recurring task upkeep.
  async runAutomationSweep(expectedIso: string, dateKey: string): Promise<void> {
    if (this.automationScheduledForIso !== expectedIso) {
      await this.syncSchedules('automation-stale');
      return;
    }

    const profileStore = ProfileStore.get(this.botName, this.chatId);
    if (!(await profileStore.isAutomationEnabled())) {
      return;
    }

    const timezone = await profileStore.getTimezone();
    if (!timezone) {
      return;
    }

    await TaskStore.get(this.botName, this.chatId).materializeMonthlyTasks(timezone, `automation-materialize-${dateKey}`);
    await this.maybeSendInactivityNudge(dateKey);
    await this.maybeSendGoalFollowUp();
    await this.maybeSendPortfolioNudge(dateKey);
    await this.syncSchedules('automation-complete');
  }

  // Sends at most one inactivity nudge per day after a quiet period.
  private async maybeSendInactivityNudge(dateKey: string): Promise<void> {
    if (this.lastInactivityNudgeDate === dateKey) {
      return;
    }

    const state = await ConversationStore.get(this.botName, this.chatId).getConversationState();
    if (!state.lastUserMessageAtIso) {
      return;
    }

    const lastUserMs = new Date(state.lastUserMessageAtIso).getTime();
    if (Number.isNaN(lastUserMs) || Date.now() - lastUserMs < INACTIVITY_HOURS * 60 * 60 * 1000) {
      return;
    }

    await ChatConciergeAgent.get(this.botName, this.chatId).deliverAutomatedMessage(
      'inactivity-nudge',
      'Haven’t heard from you in a bit. If you want, I can help you sort today’s priorities, check your goals, or review your open tasks.',
      false
    );
    this.lastInactivityNudgeDate = dateKey;
  }

  // Asks the goal coach for one follow-up when a goal has gone stale.
  private async maybeSendGoalFollowUp(): Promise<void> {
    const staleGoals = await GoalStore.get(this.botName, this.chatId).getStaleGoals(GOAL_STALE_DAYS);
    if (staleGoals.length === 0) {
      return;
    }

    const goal = staleGoals.find((candidate) => !candidate.lastNudgedAt || Date.now() - new Date(candidate.lastNudgedAt).getTime() >= GOAL_STALE_DAYS * 24 * 60 * 60 * 1000);
    if (!goal) {
      return;
    }

    const prompt = await GoalCoachAgent.get(this.botName, this.chatId).composeStaleGoalPrompt(goal);
    await ChatConciergeAgent.get(this.botName, this.chatId).deliverAutomatedMessage('goal-followup', prompt, false);
    await GoalStore.get(this.botName, this.chatId).markGoalNudged(goal.id, new Date().toISOString(), `goal-nudge-${goal.id}-${Date.now()}`);
  }

  // Sends one lightweight portfolio follow-up when review candidates exist.
  private async maybeSendPortfolioNudge(dateKey: string): Promise<void> {
    if (this.lastPortfolioNudgeDate === dateKey) {
      return;
    }

    const portfolioStore = PortfolioStore.get(this.botName, this.chatId);
    const snapshot = await portfolioStore.getSnapshot();
    const candidates = await portfolioStore.getReviewCandidates(2);
    const nudge = await PortfolioAnalystAgent.get(this.botName, this.chatId).composeDailyNudge(snapshot, candidates);
    if (!nudge.shouldMessage || !nudge.message) {
      return;
    }

    await ChatConciergeAgent.get(this.botName, this.chatId).deliverAutomatedMessage('portfolio-nudge', nudge.message, false);
    this.lastPortfolioNudgeDate = dateKey;
  }

  // Collects durable state and transcript context for the morning digest.
  private async buildMorningInput(dateKey: string): Promise<MorningDigestInput> {
    const profile = await ProfileStore.get(this.botName, this.chatId).getProfileSnapshot();
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

  // Collects durable state and transcript context for the evening digest.
  private async buildEveningInput(dateKey: string): Promise<EveningDigestInput> {
    const profile = await ProfileStore.get(this.botName, this.chatId).getProfileSnapshot();
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

  // Searches forward minute-by-minute to find the next matching local wall-clock time.
  private nextLocalRunTime(timeZone: string, hour: number, minute: number): ScheduledRun {
    const startMs = this.roundUpToMinute(Date.now() + SCHEDULE_LEAD_MINUTES * 60 * 1000);

    for (let offset = 0; offset < SEARCH_WINDOW_MINUTES; offset += 1) {
      const candidateMs = startMs + offset * 60 * 1000;
      const parts = getLocalTimeParts(new Date(candidateMs), timeZone);
      if (parts.hour === hour && parts.minute === minute) {
        return {
          iso: new Date(candidateMs).toISOString(),
          dateKey: `${parts.year}-${parts.month}-${parts.day}`,
          scheduleAt: { seconds: BigInt(Math.floor(candidateMs / 1000)), nanoseconds: 0 },
        };
      }
    }

    throw new Error(`Could not compute next scheduled run for timezone ${timeZone}`);
  }

  // Aligns schedule timestamps so delayed runs do not happen inside the current minute.
  private roundUpToMinute(timestampMs: number): number {
    return Math.ceil(timestampMs / 60000) * 60000;
  }
}
