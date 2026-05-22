// Runs background research jobs and saves the final note back into durable stores.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import { callGemini, type TelegramConfig } from '../gemini';
import { sendEmailViaResend } from '../services/email-api';
import { scrapeWebPage, searchWeb } from '../services/firecrawl-api';
import { formatErrorForTelegram, sendTelegramMessages } from '../telegram-api';
import { ConversationStore } from '../stores/conversation-store';
import { NoteStore } from '../stores/note-store';
import { ProfileStore } from '../stores/profile-store';
import { TaskStore } from '../stores/task-store';
import { PortfolioStore } from '../stores/portfolio-store';
import { currentDateKey } from '../time-utils';

type ResearchStatus = 'queued' | 'running' | 'complete' | 'failed';

export type ResearchJob = {
  id: string;
  topic: string;
  displayTopic?: string;
  researchBrief?: string;
  status: ResearchStatus;
  createdAt: string;
  updatedAt: string;
  noteName?: string;
  noteTitle?: string;
  emailOnComplete: boolean;
  emailTo?: string;
  completionTask?: string;
  emailSentId?: string;
  tags: string[];
  stockSymbol?: string;
  error?: string;
};

export type ResearchResult = {
  tool: 'startResearch' | 'listResearch';
  ok: boolean;
  summary: string;
  job?: ResearchJob;
  jobs?: ResearchJob[];
};

const RESEARCH_JOB_LIMIT = 20;
const SCRAPE_LIMIT = 3;
const SCRAPED_PAGE_CHARS = 3500;

@agent()
export class ResearchAgent extends BaseAgent {
  private jobs: ResearchJob[] = [];

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Queues a research job and returns the durable job metadata immediately.
  async startResearch(
    topic: string,
    emailOnComplete: string | undefined,
    emailTo: string | undefined,
    completionTask: string | undefined,
    researchBrief?: string,
    displayTopic?: string,
    tags: string[] = [],
    stockSymbol?: string
  ): Promise<ResearchResult> {
    const trimmed = topic.trim();
    if (trimmed.length === 0) {
      return {
        tool: 'startResearch',
        ok: false,
        summary: 'Please provide a topic to research.',
      };
    }

    const job = this.createJob(
      trimmed,
      this.isYes(emailOnComplete),
      emailTo?.trim(),
      completionTask?.trim(),
      researchBrief?.trim(),
      displayTopic?.trim(),
      tags,
      stockSymbol?.trim().toUpperCase()
    );
    this.jobs.push(job);
    if (this.jobs.length > RESEARCH_JOB_LIMIT) {
      this.jobs.shift();
    }

    return {
      tool: 'startResearch',
      ok: true,
      summary: `Started research job ${job.id}: ${this.visibleTopic(job)}. I will message you when it is complete${job.emailOnComplete ? ' and email the note' : ''}${job.completionTask ? ' and add the follow-up task' : ''}.`,
      job,
    };
  }

  // Lists recent research jobs and their current status.
  async listResearch(): Promise<ResearchResult> {
    if (this.jobs.length === 0) {
      return {
        tool: 'listResearch',
        ok: true,
        summary: 'No research jobs yet.',
        jobs: [],
      };
    }

    return {
      tool: 'listResearch',
      ok: true,
      summary: this.jobs.map((job) => `${job.id}: ${job.status} - ${this.visibleTopic(job)}${job.noteName ? ` -> ${job.noteName}` : ''}`).join('\n'),
      jobs: [...this.jobs],
    };
  }

  // Fetches sources, writes the final note, and notifies the user when done.
  async runResearch(jobId: string): Promise<void> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job || job.status !== 'queued') {
      return;
    }

    job.status = 'running';
    job.updatedAt = new Date().toISOString();

    try {
      const search = await searchWeb(this.config.value.firecrawlApiKey, job.topic);
      const urls = (search.results ?? []).slice(0, SCRAPE_LIMIT).map((result) => result.url);
      const pages: string[] = [];
      const sources: string[] = [];

      for (const url of urls) {
        const scraped = await scrapeWebPage(this.config.value.firecrawlApiKey, url);
        if (scraped.ok && scraped.page) {
          sources.push(scraped.page.url);
          pages.push([
            `Title: ${scraped.page.title ?? scraped.page.url}`,
            `URL: ${scraped.page.url}`,
            '',
            this.truncate(scraped.page.markdown, SCRAPED_PAGE_CHARS),
          ].join('\n'));
        }
      }

      const visibleTopic = this.visibleTopic(job);
      const noteTitle = `Research: ${visibleTopic}`;
      const noteText = await this.writeResearchNote(visibleTopic, job.researchBrief ?? visibleTopic, search.summary, pages);
      const noteResult = await NoteStore.get(this.botName, this.chatId).saveResearchNote(noteTitle, noteText, job.id, job.tags, sources);
      const savedNote = noteResult.note ?? noteResult.notes[noteResult.notes.length - 1];

      job.status = 'complete';
      job.noteName = savedNote?.name;
      job.noteTitle = savedNote?.title ?? noteTitle;
      job.updatedAt = new Date().toISOString();

      const followUps: string[] = [];
      if (job.completionTask) {
        const taskText = `${job.completionTask}${job.noteName ? ` (${job.noteName})` : ''}`;
        await TaskStore.get(this.botName, this.chatId).addTask(taskText, undefined, undefined, job.id);
        followUps.push(`Added task: ${taskText}`);
      }

      if (job.stockSymbol && job.noteName) {
        await PortfolioStore.get(this.botName, this.chatId).markResearchSaved(job.stockSymbol, job.noteName, job.updatedAt, `portfolio-research-${job.id}`);
      }

      if (job.emailOnComplete) {
        const recipient = job.emailTo || await ProfileStore.get(this.botName, this.chatId).getDefaultEmail();
        if (recipient) {
          const emailBody = [
            `Research complete: ${visibleTopic}`,
            '',
            `Saved note: ${job.noteName ?? '(unknown)'} - ${job.noteTitle}`,
            '',
            noteText,
          ].join('\n');
          job.emailSentId = await sendEmailViaResend(
            this.config.value.resendApiKey,
            this.config.value.resendFromEmail,
            recipient,
            `Research: ${visibleTopic}`,
            emailBody,
            `research-email-${job.id}`
          );
          followUps.push(`Emailed research note to ${recipient}.`);
        } else {
          followUps.push('Email requested, but no default recipient is saved.');
        }
      }

      await this.sendResearchMessage([
        `Research complete: ${visibleTopic}`,
        `Saved as note ${job.noteName ?? '(unknown)'}: ${job.noteTitle}`,
        `Read it with /note ${job.noteName ?? ''}`,
        ...followUps,
      ].join('\n'));
    } catch (error) {
      job.status = 'failed';
      job.error = formatErrorForTelegram(error);
      job.updatedAt = new Date().toISOString();
      await this.sendResearchMessage(`Research failed for ${this.visibleTopic(job)}: ${job.error}`);
    }
  }

  // Returns a copy so callers cannot mutate in-memory job state.
  async getJobs(): Promise<ResearchJob[]> {
    return this.jobs.map((job) => ({ ...job, tags: [...job.tags] }));
  }

  // Uses Gemini to turn scraped material into a concise saved note.
  private async writeResearchNote(topic: string, researchBrief: string, searchSummary: string, pages: string[]): Promise<string> {
    const sourceText = pages.length === 0 ? 'No pages could be scraped.' : pages.join('\n\n---\n\n');
    return callGemini(
      this.config.value.geminiApiKey,
      [
        'Write a concise research note from the scraped source material.',
        'Use markdown. Include: summary, key points, caveats, and sources with URLs.',
        'Do not invent facts that are not present in the source material.',
        '',
        `Topic: ${topic}`,
        `Research brief: ${researchBrief}`,
        `Search summary: ${searchSummary}`,
        '',
        'Sources:',
        sourceText,
      ].join('\n')
    );
  }

  // Sends a research update and records it in the durable transcript.
  private async sendResearchMessage(text: string): Promise<void> {
    await sendTelegramMessages(this.config.value.botToken, this.chatId, text);
    const timezone = await ProfileStore.get(this.botName, this.chatId).getTimezone();
    const timestampIso = new Date().toISOString();
    const dateKey = currentDateKey(timezone);
    await ConversationStore.get(this.botName, this.chatId).recordAutomatedAssistantMessage('research', text, dateKey, timestampIso, false);
  }

  // Creates a stable job id and normalizes optional metadata up front.
  private createJob(
    topic: string,
    emailOnComplete: boolean,
    emailTo: string | undefined,
    completionTask: string | undefined,
    researchBrief: string | undefined,
    displayTopic: string | undefined,
    tags: string[],
    stockSymbol: string | undefined
  ): ResearchJob {
    const now = new Date().toISOString();
    const baseId = `research-${this.slugify(displayTopic || topic)}`;
    return {
      id: this.uniqueJobId(baseId),
      topic,
      displayTopic: displayTopic || undefined,
      researchBrief: researchBrief || undefined,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      emailOnComplete,
      emailTo,
      completionTask,
      tags: [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))],
      stockSymbol,
    };
  }

  // Interprets common truthy chat strings for the email flag.
  private isYes(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase() ?? '';
    return normalized === 'yes' || normalized === 'true' || normalized === '1' || normalized === 'email';
  }

  // Keeps scraped source text within a bounded prompt size.
  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }

    return `${text.slice(0, maxChars)}\n\n[truncated]`;
  }

  // Chooses the most user-friendly topic label for messages and note titles.
  private visibleTopic(job: ResearchJob): string {
    return job.displayTopic?.trim() || job.topic;
  }

  // Avoids id collisions when similar research requests arrive repeatedly.
  private uniqueJobId(baseId: string): string {
    let candidate = baseId;
    let suffix = 2;

    while (this.jobs.some((job) => job.id === candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  // Generates readable stable ids from free-form topics.
  private slugify(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'research';
  }
}
