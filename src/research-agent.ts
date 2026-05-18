import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import { callGemini, type TelegramConfig } from './gemini';
import { FirecrawlAgent } from './firecrawl-agent';
import { NoteAgent } from './note-agent';
import { TodoAgent } from './todo-agent';
import { EmailAgent } from './email-agent';
import { formatErrorForTelegram, sendTelegramMessages } from './telegram-api';

type ResearchStatus = 'queued' | 'running' | 'complete' | 'failed';

type ResearchJob = {
  id: string;
  topic: string;
  status: ResearchStatus;
  createdAt: string;
  updatedAt: string;
  noteName?: string;
  noteTitle?: string;
  emailOnComplete: boolean;
  emailTo?: string;
  completionTodo?: string;
  emailSentId?: string;
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

  async startResearch(
    topic: string,
    emailOnComplete: string | undefined,
    emailTo: string | undefined,
    completionTodo: string | undefined
  ): Promise<ResearchResult> {
    const trimmed = topic.trim();
    if (trimmed.length === 0) {
      return {
        tool: 'startResearch',
        ok: false,
        summary: 'Please provide a topic to research.',
      };
    }

    const job = this.createJob(trimmed, this.isYes(emailOnComplete), emailTo?.trim(), completionTodo?.trim());
    this.jobs.push(job);
    if (this.jobs.length > RESEARCH_JOB_LIMIT) {
      this.jobs.shift();
    }

    return {
      tool: 'startResearch',
      ok: true,
      summary: `Started research job ${job.id}: ${job.topic}. I will message you when it is complete${job.emailOnComplete ? ' and email the note' : ''}${job.completionTodo ? ' and add the follow-up todo' : ''}.`,
      job,
    };
  }

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
      summary: this.jobs.map((job) => `${job.id}: ${job.status} - ${job.topic}${job.noteName ? ` -> ${job.noteName}` : ''}`).join('\n'),
      jobs: [...this.jobs],
    };
  }

  async runResearch(jobId: string): Promise<void> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job || job.status !== 'queued') {
      return;
    }

    job.status = 'running';
    job.updatedAt = new Date().toISOString();

    try {
      const firecrawl = FirecrawlAgent.get(this.botName);
      const search = await firecrawl.webSearch(job.topic);
      const urls = (search.results ?? []).slice(0, SCRAPE_LIMIT).map((result) => result.url);
      const pages: string[] = [];

      for (const url of urls) {
        const scraped = await firecrawl.webScrape(url);
        if (scraped.ok && scraped.page) {
          pages.push([
            `Title: ${scraped.page.title ?? scraped.page.url}`,
            `URL: ${scraped.page.url}`,
            '',
            this.truncate(scraped.page.markdown, SCRAPED_PAGE_CHARS),
          ].join('\n'));
        }
      }

      const noteTitle = `Research: ${job.topic}`;
      const noteText = await this.writeResearchNote(job.topic, search.summary, pages);
      const noteResult = await NoteAgent.get(this.botName, this.chatId).saveResearchNote(noteTitle, noteText, job.id);
      const savedNote = noteResult.note ?? noteResult.notes[noteResult.notes.length - 1];

      job.status = 'complete';
      job.noteName = savedNote?.name;
      job.noteTitle = savedNote?.title ?? noteTitle;
      job.updatedAt = new Date().toISOString();

      const followUps: string[] = [];
      if (job.completionTodo) {
        const todoText = `${job.completionTodo}${job.noteName ? ` (${job.noteName})` : ''}`;
        await TodoAgent.get(this.botName, this.chatId).addTodo(todoText, job.id);
        followUps.push(`Added todo: ${todoText}`);
      }

      if (job.emailOnComplete) {
        const emailBody = [
          `Research complete: ${job.topic}`,
          '',
          `Saved note: ${job.noteName ?? '(unknown)'} - ${job.noteTitle}`,
          '',
          noteText,
        ].join('\n');
        const emailResult = await EmailAgent.get(this.botName, this.chatId).sendEmail(
          job.emailTo,
          `Research: ${job.topic}`,
          emailBody,
          `research-email-${job.id}`
        );
        if (emailResult.ok) {
          job.emailSentId = emailResult.sentId;
        }
        followUps.push(emailResult.summary);
      }

      await sendTelegramMessages(
        this.config.value.botToken,
        this.chatId,
        [
          `Research complete: ${job.topic}`,
          `Saved as note ${job.noteName ?? '(unknown)'}: ${job.noteTitle}`,
          `Read it with /note ${job.noteName ?? ''}`,
          ...followUps,
        ].join('\n')
      );
    } catch (error) {
      job.status = 'failed';
      job.error = formatErrorForTelegram(error);
      job.updatedAt = new Date().toISOString();
      await sendTelegramMessages(
        this.config.value.botToken,
        this.chatId,
        `Research failed for ${job.topic}: ${job.error}`
      );
    }
  }

  private async writeResearchNote(topic: string, searchSummary: string, pages: string[]): Promise<string> {
    const sourceText = pages.length === 0 ? 'No pages could be scraped.' : pages.join('\n\n---\n\n');
    return callGemini(
      this.config.value.geminiApiKey,
      [
        'Write a concise research note from the scraped source material.',
        'Use markdown. Include: summary, key points, caveats, and sources with URLs.',
        'Do not invent facts that are not present in the source material.',
        '',
        `Topic: ${topic}`,
        `Search summary: ${searchSummary}`,
        '',
        'Sources:',
        sourceText,
      ].join('\n')
    );
  }

  private createJob(topic: string, emailOnComplete: boolean, emailTo: string | undefined, completionTodo: string | undefined): ResearchJob {
    const now = new Date().toISOString();
    const baseId = `research-${this.slugify(topic)}`;
    return {
      id: this.uniqueJobId(baseId),
      topic,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      emailOnComplete,
      emailTo,
      completionTodo,
    };
  }

  private isYes(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase() ?? '';
    return normalized === 'yes' || normalized === 'true' || normalized === '1' || normalized === 'email';
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)}\n\n[truncated]`;
  }

  private uniqueJobId(baseId: string): string {
    let candidate = baseId;
    let suffix = 2;

    while (this.jobs.some((job) => job.id === candidate)) {
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
      .slice(0, 80) || 'research';
  }
}
