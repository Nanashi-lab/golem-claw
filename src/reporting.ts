// Formats durable store snapshots into compact strings for prompts and digests.
import type { ResearchJob } from './agents/research-agent';
import type { Goal } from './stores/goal-store';
import type { Note } from './stores/note-store';
import type { PortfolioSnapshot } from './stores/portfolio-store';
import type { ProfileSnapshot } from './stores/profile-store';
import { formatIsoInTimeZone } from './time-utils';
import type { Reminder, TaskSnapshot, TaskItem } from './stores/task-store';

// Formats saved profile fields and durable facts for prompt context.
export function formatProfileFacts(profile: ProfileSnapshot): string {
  const lines: string[] = [];

  if (profile.name) {
    lines.push(`Name: ${profile.name}`);
  }
  if (profile.username) {
    lines.push(`Telegram username: @${profile.username}`);
  }
  if (profile.timezone) {
    lines.push(`Timezone: ${profile.timezone}`);
  }
  if (profile.facts.length > 0) {
    lines.push('Saved profile facts:');
    lines.push(profile.facts.map((fact) => `- ${fact}`).join('\n'));
  }

  return lines.length > 0 ? lines.join('\n') : 'No saved profile facts.';
}

// Formats tracked goals with their plan and recent progress.
export function formatGoals(goals: Goal[]): string {
  if (goals.length === 0) {
    return 'No tracked goals yet.';
  }

  return goals.map((goal) => [
    `${goal.id}: ${goal.title} [${goal.status}]`,
    `Tracking: ${goal.trackingPlan}`,
    goal.progress.length > 0 ? `Recent progress: ${goal.progress.slice(-5).map((entry) => entry.note).join(' | ')}` : 'Recent progress: none',
  ].join('\n')).join('\n\n');
}

// Formats only open tasks and localizes due times when a timezone is available.
export function formatTaskItems(tasks: TaskItem[], timeZone?: string): string {
  const openTasks = tasks.filter((task) => task.status === 'open');
  if (openTasks.length === 0) {
    return 'No open tasks.';
  }

  return openTasks
    .map((task) => task.dueAtIso ? `- ${task.title} (due ${formatIsoInTimeZone(task.dueAtIso, timeZone)})` : `- ${task.title}`)
    .join('\n');
}

// Formats only active reminders and localizes reminder times when possible.
export function formatActiveReminders(reminders: Reminder[], timeZone?: string): string {
  const active = reminders.filter((reminder) => !reminder.fired);
  if (active.length === 0) {
    return 'No active reminders.';
  }

  return active
    .map((reminder) => `- ${reminder.item} at ${formatIsoInTimeZone(reminder.remindAtIso, timeZone)}`)
    .join('\n');
}

// Builds the task and reminder strings most prompt builders need together.
export function summarizeTaskSnapshot(snapshot: TaskSnapshot, timeZone?: string): { taskText: string; reminderText: string } {
  return {
    taskText: formatTaskItems(snapshot.tasks, timeZone),
    reminderText: formatActiveReminders(snapshot.reminders, timeZone),
  };
}

// Summarizes only the most recent notes to keep prompts compact.
export function summarizeNotes(notes: Note[]): string {
  if (notes.length === 0) {
    return 'No saved notes.';
  }

  return notes
    .slice(-8)
    .map((note) => `- ${note.name} (${note.kind}): ${note.title}`)
    .join('\n');
}

// Summarizes only the most recent research jobs to keep prompts compact.
export function summarizeResearchJobs(jobs: ResearchJob[]): string {
  if (jobs.length === 0) {
    return 'No research jobs yet.';
  }

  return jobs
    .slice(-8)
      .map((job) => `- ${job.id}: ${job.status} - ${job.topic}${job.noteName ? ` -> ${job.noteName}` : ''}`)
      .join('\n');
}

// Summarizes holdings and watchlist state for digests and stock prompts.
export function summarizeStockSnapshot(snapshot: PortfolioSnapshot): string {
  if (snapshot.holdings.length === 0 && snapshot.watchlist.length === 0) {
    return 'No saved portfolio holdings or watchlist stocks.';
  }

  const holdings = snapshot.holdings.length === 0
    ? 'No holdings.'
    : snapshot.holdings
      .map((holding) => [
        `- ${holding.symbol}: ${holding.shares} shares`,
        holding.averageCost !== undefined ? `avg cost ${holding.averageCost}` : undefined,
        holding.sector ? `sector ${holding.sector}` : undefined,
        holding.lastQuote ? `cached close ${holding.lastQuote.close.toFixed(2)} on ${holding.lastQuote.asOfIso.slice(0, 10)}` : undefined,
      ].filter((value): value is string => Boolean(value)).join(', '))
      .join('\n');

  const watchlist = snapshot.watchlist.length === 0
    ? 'No watchlist stocks.'
    : snapshot.watchlist
      .map((entry) => [
        `- ${entry.symbol}`,
        entry.sector ? `sector ${entry.sector}` : undefined,
        entry.thesis ? `thesis ${entry.thesis}` : undefined,
        entry.lastResearchNoteName ? `research ${entry.lastResearchNoteName}` : undefined,
      ].filter((value): value is string => Boolean(value)).join(', '))
      .join('\n');

  return [
    'Holdings:',
    holdings,
    '',
    'Watchlist:',
    watchlist,
  ].join('\n');
}
