// Stores durable tasks, reminders, and monthly recurring task templates.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import type { TelegramConfig } from '../gemini';
import { currentDateKey, currentMonthKey, endOfMonthDueIso } from '../time-utils';
import { sendTelegramMessages } from '../telegram-api';
import { ConversationStore } from './conversation-store';
import { ProfileStore } from './profile-store';

type Datetime = {
  seconds: bigint;
  nanoseconds: number;
};

export type TaskTemplate = {
  id: string;
  title: string;
  recurrence: 'monthly';
  active: boolean;
  createdAtIso: string;
  updatedAtIso: string;
};

export type TaskItem = {
  id: string;
  templateId?: string;
  title: string;
  dueAtIso?: string;
  status: 'open' | 'completed' | 'cancelled';
  createdAtIso: string;
  completedAtIso?: string;
  periodKey?: string;
};

export type Reminder = {
  id: string;
  item: string;
  remindAtIso: string;
  createdAtIso: string;
  fired: boolean;
  taskId?: string;
};

export type TaskSnapshot = {
  tasks: TaskItem[];
  reminders: Reminder[];
};

export type TaskStoreResult = {
  tool:
    | 'addTask'
    | 'deleteTask'
    | 'completeTask'
    | 'listTasks'
    | 'setReminder'
    | 'listReminders'
    | 'materializeMonthlyTasks';
  summary: string;
  tasks: TaskItem[];
  reminders: Reminder[];
  templates: TaskTemplate[];
};

type MutationResult = {
  key: string;
  result: TaskStoreResult;
};

const MUTATION_RESULT_LIMIT = 100;

@agent()
export class TaskStore extends BaseAgent {
  private templates: TaskTemplate[] = [];
  private tasks: TaskItem[] = [];
  private reminders: Reminder[] = [];
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Adds a one-off task or registers a monthly template and current instance.
  async addTask(title: string, recurrence: 'monthly' | undefined, timeZone: string | undefined, updateKey?: string): Promise<TaskStoreResult> {
    const existing = this.getMutationResult('addTask', updateKey);
    if (existing) {
      return existing;
    }

    const normalized = title.trim();
    if (normalized.length === 0) {
      const empty = this.makeResult('addTask', 'I could not add an empty task.');
      this.saveMutationResult('addTask', updateKey, empty);
      return empty;
    }

    if (recurrence === 'monthly') {
      if (!timeZone) {
        const missingTz = this.makeResult('addTask', 'Please save your timezone before creating a monthly recurring task.');
        this.saveMutationResult('addTask', updateKey, missingTz);
        return missingTz;
      }

      const template = this.getOrCreateMonthlyTemplate(normalized);
      const created = this.materializeTemplateForCurrentMonth(template, timeZone);
      const result = this.makeResult(
        'addTask',
        created
          ? `Added monthly recurring task: ${normalized}. A task for this month is now open and due at the end of the month.`
          : `Monthly recurring task already exists: ${normalized}. The current month's task is already open.`
      );
      this.saveMutationResult('addTask', updateKey, result);
      return result;
    }

    const existingTask = this.findOpenTask(normalized);
    const result = existingTask
      ? this.makeResult('addTask', `Task already exists: ${existingTask.title}.`)
      : this.makeResult('addTask', `Added task: ${this.createTask(normalized).title}.`);
    this.saveMutationResult('addTask', updateKey, result);
    return result;
  }

  // Cancels an open task matched by id or fuzzy title text.
  async deleteTask(query: string, updateKey?: string): Promise<TaskStoreResult> {
    const existing = this.getMutationResult('deleteTask', updateKey);
    if (existing) {
      return existing;
    }

    const task = this.findOpenTask(query);
    let result: TaskStoreResult;
    if (!task) {
      result = this.makeResult('deleteTask', `I could not find a task matching: ${query}.`);
    } else {
      task.status = 'cancelled';
      result = this.makeResult('deleteTask', `Deleted task: ${task.title}.`);
    }

    this.saveMutationResult('deleteTask', updateKey, result);
    return result;
  }

  // Marks an open task complete and records the completion time.
  async completeTask(query: string, updateKey?: string): Promise<TaskStoreResult> {
    const existing = this.getMutationResult('completeTask', updateKey);
    if (existing) {
      return existing;
    }

    const task = this.findOpenTask(query);
    let result: TaskStoreResult;
    if (!task) {
      result = this.makeResult('completeTask', `I could not find a task matching: ${query}.`);
    } else {
      task.status = 'completed';
      task.completedAtIso = new Date().toISOString();
      result = this.makeResult('completeTask', `Completed task: ${task.title}.`);
    }

    this.saveMutationResult('completeTask', updateKey, result);
    return result;
  }

  // Lists open task instances in a compact Telegram-friendly format.
  async listTasks(): Promise<TaskStoreResult> {
    const openTasks = this.tasks.filter((task) => task.status === 'open');
    if (openTasks.length === 0) {
      return this.makeResult('listTasks', 'Your task list is empty.');
    }

    return this.makeResult('listTasks', `Current tasks:\n${openTasks.map((task) => this.formatTask(task)).join('\n')}`);
  }

  // Persists and schedules a future reminder for a task or free-form item.
  async setReminder(item: string, remindAtIso: string, updateKey?: string, taskId?: string): Promise<TaskStoreResult> {
    const existing = this.getMutationResult('setReminder', updateKey);
    if (existing) {
      return existing;
    }

    const normalized = item.trim();
    const remindAt = new Date(remindAtIso);
    let result: TaskStoreResult;

    if (normalized.length === 0) {
      result = this.makeResult('setReminder', 'I could not set a reminder for an empty task.');
    } else if (Number.isNaN(remindAt.getTime())) {
      result = this.makeResult('setReminder', `I could not understand the reminder time: ${remindAtIso}.`);
    } else if (remindAt.getTime() <= Date.now()) {
      result = this.makeResult('setReminder', 'Please choose a future time for the reminder.');
    } else {
      const reminder: Reminder = {
        id: `${Date.now()}-${this.reminders.length + 1}`,
        item: normalized,
        remindAtIso: remindAt.toISOString(),
        createdAtIso: new Date().toISOString(),
        fired: false,
        taskId,
      };
      this.reminders.push(reminder);

      const scheduleAt: Datetime = {
        seconds: BigInt(Math.floor(remindAt.getTime() / 1000)),
        nanoseconds: 0,
      };
      TaskStore.get(this.botName, this.chatId).fireReminder.schedule(scheduleAt, reminder.id);
      result = this.makeResult('setReminder', `Reminder set for ${normalized} at ${reminder.remindAtIso}.`);
    }

    this.saveMutationResult('setReminder', updateKey, result);
    return result;
  }

  // Lists active reminders that have not fired yet.
  async listReminders(): Promise<TaskStoreResult> {
    const active = this.reminders.filter((reminder) => !reminder.fired);
    if (active.length === 0) {
      return this.makeResult('listReminders', 'You do not have any active reminders.');
    }

    return this.makeResult('listReminders', `Active reminders:\n${active.map((reminder) => `- ${reminder.item} at ${reminder.remindAtIso}`).join('\n')}`);
  }

  // Creates the current month's instances for every active monthly template.
  async materializeMonthlyTasks(timeZone: string, updateKey?: string): Promise<TaskStoreResult> {
    const existing = this.getMutationResult('materializeMonthlyTasks', updateKey);
    if (existing) {
      return existing;
    }

    const createdTitles = this.templates
      .filter((template) => template.active)
      .filter((template) => this.materializeTemplateForCurrentMonth(template, timeZone))
      .map((template) => template.title);

    const result = createdTitles.length === 0
      ? this.makeResult('materializeMonthlyTasks', 'No new monthly tasks were due to be created.')
      : this.makeResult('materializeMonthlyTasks', `Created monthly task instances for: ${createdTitles.join(', ')}.`);
    this.saveMutationResult('materializeMonthlyTasks', updateKey, result);
    return result;
  }

  // Delivers the reminder immediately and records it in the transcript.
  async fireReminder(reminderId: string): Promise<void> {
    const reminder = this.reminders.find((entry) => entry.id === reminderId);
    if (!reminder || reminder.fired) {
      return;
    }

    reminder.fired = true;
    const text = `Reminder: ${reminder.item}`;
    await sendTelegramMessages(this.config.value.botToken, this.chatId, text);
    const timezone = await ProfileStore.get(this.botName, this.chatId).getTimezone();
    const timestampIso = new Date().toISOString();
    const dateKey = currentDateKey(timezone);
    await ConversationStore.get(this.botName, this.chatId).recordAutomatedAssistantMessage('reminder', text, dateKey, timestampIso, false);
  }

  // Returns a copy so digest/report code cannot mutate store state.
  async getSnapshot(): Promise<TaskSnapshot> {
    return {
      tasks: this.tasks.map((task) => ({ ...task })),
      reminders: this.reminders.map((reminder) => ({ ...reminder })),
    };
  }

  // Reuses a matching template instead of duplicating monthly recurrence definitions.
  private getOrCreateMonthlyTemplate(title: string): TaskTemplate {
    const existing = this.templates.find((template) => template.title.toLowerCase() === title.toLowerCase() && template.recurrence === 'monthly' && template.active);
    if (existing) {
      existing.updatedAtIso = new Date().toISOString();
      return existing;
    }

    const now = new Date().toISOString();
    const template: TaskTemplate = {
      id: `template-${this.slugify(title)}`,
      title,
      recurrence: 'monthly',
      active: true,
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.templates.push(template);
    return template;
  }

  // Creates only one task instance per template per local month.
  private materializeTemplateForCurrentMonth(template: TaskTemplate, timeZone: string): boolean {
    const periodKey = currentMonthKey(timeZone);
    const existing = this.tasks.find((task) => task.templateId === template.id && task.periodKey === periodKey);
    if (existing) {
      return false;
    }

    this.tasks.push({
      id: `task-${Date.now()}-${this.tasks.length + 1}`,
      templateId: template.id,
      title: template.title,
      dueAtIso: endOfMonthDueIso(timeZone),
      status: 'open',
      createdAtIso: new Date().toISOString(),
      periodKey,
    });
    return true;
  }

  // Creates a plain one-off task item.
  private createTask(title: string): TaskItem {
    const task: TaskItem = {
      id: `task-${Date.now()}-${this.tasks.length + 1}`,
      title,
      status: 'open',
      createdAtIso: new Date().toISOString(),
    };
    this.tasks.push(task);
    return task;
  }

  // Formats one task for list output.
  private formatTask(task: TaskItem): string {
    return task.dueAtIso ? `- ${task.title} (due ${task.dueAtIso})` : `- ${task.title}`;
  }

  // Matches by exact id, exact title, or partial title for chat convenience.
  private findOpenTask(query: string): TaskItem | undefined {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return undefined;
    }

    return this.tasks.find((task) => task.status === 'open' && (
      task.id.toLowerCase() === normalized
      || task.title.toLowerCase() === normalized
      || task.title.toLowerCase().includes(normalized)
    ));
  }

  // Builds readable stable ids from free-form task text.
  private slugify(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'task';
  }

  // Packages the current durable state into a single tool result.
  private makeResult(tool: TaskStoreResult['tool'], summary: string): TaskStoreResult {
    return {
      tool,
      summary,
      tasks: this.tasks.map((task) => ({ ...task })),
      reminders: this.reminders.map((reminder) => ({ ...reminder })),
      templates: this.templates.map((template) => ({ ...template })),
    };
  }

  // Reuses the last mutation result so retries stay idempotent.
  private getMutationResult(tool: TaskStoreResult['tool'], updateKey: string | undefined): TaskStoreResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === `${tool}:${updateKey}`)?.result;
  }

  // Stores mutation results under a tool-specific idempotency key.
  private saveMutationResult(tool: TaskStoreResult['tool'], updateKey: string | undefined, result: TaskStoreResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: `${tool}:${updateKey}`, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }
}
