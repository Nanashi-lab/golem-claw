import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import type { TelegramConfig } from './gemini';
import { sendTelegramMessages } from './telegram-api';

type Datetime = {
  seconds: bigint;
  nanoseconds: number;
};

export type Reminder = {
  id: string;
  item: string;
  remindAtIso: string;
  createdAtIso: string;
  fired: boolean;
};

export type TodoResult = {
  tool: 'addTodo' | 'deleteTodo' | 'listTodos' | 'setReminder' | 'listReminders';
  summary: string;
  items: string[];
  reminders: Reminder[];
};

type MutationResult = {
  key: string;
  result: TodoResult;
};

const MUTATION_RESULT_LIMIT = 100;

@agent()
export class TodoAgent extends BaseAgent {
  private items: string[] = [];
  private reminders: Reminder[] = [];
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  async addTodo(item: string, updateKey?: string): Promise<TodoResult> {
    const existing = this.getMutationResult('addTodo', updateKey);
    if (existing) {
      return existing;
    }

    const normalized = item.trim();
    let result: TodoResult;

    if (normalized.length === 0) {
      result = this.makeResult('addTodo', 'I could not add an empty todo.');
    } else if (!this.items.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
      this.items.push(normalized);
      result = this.makeResult('addTodo', `Added todo: ${normalized}.`);
    } else {
      result = this.makeResult('addTodo', `Todo already exists: ${normalized}.`);
    }

    this.saveMutationResult('addTodo', updateKey, result);
    return result;
  }

  async deleteTodo(item: string, updateKey?: string): Promise<TodoResult> {
    const existing = this.getMutationResult('deleteTodo', updateKey);
    if (existing) {
      return existing;
    }

    const normalized = item.trim().toLowerCase();
    const index = this.items.findIndex((entry) => entry.toLowerCase() === normalized);
    let result: TodoResult;

    if (index === -1) {
      result = this.makeResult('deleteTodo', `I could not find a todo matching: ${item}.`);
    } else {
      const [deleted] = this.items.splice(index, 1);
      result = this.makeResult('deleteTodo', `Deleted todo: ${deleted}.`);
    }

    this.saveMutationResult('deleteTodo', updateKey, result);
    return result;
  }

  async listTodos(): Promise<TodoResult> {
    if (this.items.length === 0) {
      return this.makeResult('listTodos', 'Your todo list is empty.');
    }

    return this.makeResult('listTodos', `Current todos: ${this.items.join(', ')}.`);
  }

  async setReminder(item: string, remindAtIso: string, updateKey?: string): Promise<TodoResult> {
    const existing = this.getMutationResult('setReminder', updateKey);
    if (existing) {
      return existing;
    }

    const normalized = item.trim();
    const remindAt = new Date(remindAtIso);
    let result: TodoResult;

    if (normalized.length === 0) {
      result = this.makeResult('setReminder', 'I could not set a reminder for an empty todo.');
    } else if (Number.isNaN(remindAt.getTime())) {
      result = this.makeResult('setReminder', `I could not understand the reminder time: ${remindAtIso}.`);
    } else if (remindAt.getTime() <= Date.now()) {
      result = this.makeResult('setReminder', 'Please choose a future time for the reminder.');
    } else {
      if (!this.items.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
        this.items.push(normalized);
      }

      const reminder: Reminder = {
        id: `${Date.now()}-${this.reminders.length + 1}`,
        item: normalized,
        remindAtIso: remindAt.toISOString(),
        createdAtIso: new Date().toISOString(),
        fired: false,
      };
      this.reminders.push(reminder);

      const scheduleAt: Datetime = {
        seconds: BigInt(Math.floor(remindAt.getTime() / 1000)),
        nanoseconds: 0,
      };
      TodoAgent.get(this.botName, this.chatId).fireReminder.schedule(scheduleAt, reminder.id);

      result = this.makeResult('setReminder', `Reminder set for ${normalized} at ${reminder.remindAtIso}.`);
    }

    this.saveMutationResult('setReminder', updateKey, result);
    return result;
  }

  async listReminders(): Promise<TodoResult> {
    const active = this.reminders.filter((reminder) => !reminder.fired);
    if (active.length === 0) {
      return this.makeResult('listReminders', 'You do not have any active reminders.');
    }

    return this.makeResult(
      'listReminders',
      `Active reminders: ${active.map((reminder) => `${reminder.item} at ${reminder.remindAtIso}`).join(', ')}.`
    );
  }

  async fireReminder(reminderId: string): Promise<void> {
    const reminder = this.reminders.find((entry) => entry.id === reminderId);
    if (!reminder || reminder.fired) {
      return;
    }

    reminder.fired = true;
    await sendTelegramMessages(
      this.config.value.botToken,
      this.chatId,
      `Reminder: ${reminder.item}`
    );
  }

  async getTodos(): Promise<string[]> {
    return this.items;
  }

  private makeResult(tool: TodoResult['tool'], summary: string): TodoResult {
    return {
      tool,
      summary,
      items: [...this.items],
      reminders: this.reminders.map((reminder) => ({ ...reminder })),
    };
  }

  private getMutationResult(tool: TodoResult['tool'], updateKey: string | undefined): TodoResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === `${tool}:${updateKey}`)?.result;
  }

  private saveMutationResult(tool: TodoResult['tool'], updateKey: string | undefined, result: TodoResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: `${tool}:${updateKey}`, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }
}
