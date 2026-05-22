// Stores durable user identity, memory, timezone, city, email, and automation preferences.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import { callGemini, type TelegramConfig } from '../gemini';
import { isValidTimeZone } from '../time-utils';
import { formatLocation, resolveCity, type SavedLocation } from '../services/weather-api';

export type SavedEmail = {
  email: string;
  label: string;
  default: boolean;
  createdAt: string;
};

export type ProfileSnapshot = {
  name?: string;
  username?: string;
  timezone?: string;
  city?: SavedLocation;
  emails: SavedEmail[];
  facts: string[];
  memory: string;
  automationEnabled: boolean;
};

export type ProfileStoreResult = {
  tool:
    | 'saveProfile'
    | 'rememberFact'
    | 'addEmail'
    | 'listEmails'
    | 'setCity'
    | 'toggleAutomation';
  ok: boolean;
  summary: string;
  profile: ProfileSnapshot;
};

type MutationResult = {
  key: string;
  result: ProfileStoreResult;
};

const FACT_LIMIT = 30;
const MUTATION_RESULT_LIMIT = 100;

@agent()
export class ProfileStore extends BaseAgent {
  private name?: string;
  private username?: string;
  private timezone?: string;
  private city?: SavedLocation;
  private emails: SavedEmail[] = [];
  private facts: string[] = [];
  private memory = '';
  private automationEnabled = true;
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Captures Telegram identity hints without treating them as explicit durable preferences.
  async recordTelegramIdentity(username: string | undefined, firstName: string | undefined): Promise<void> {
    let changed = false;

    if (username && username !== this.username) {
      this.username = username;
      changed = true;
    }
    if (firstName && !this.name) {
      this.name = firstName.trim();
      changed = true;
    }

    if (changed) {
      console.info(`[ProfileStore ${this.chatId}] Updated Telegram identity`);
    }
  }

  // Saves explicit profile fields and folds them into long-term memory.
  async saveProfile(name: string, timezone: string, preferences: string, updateKey?: string): Promise<ProfileStoreResult> {
    const existing = this.getMutationResult('saveProfile', updateKey);
    if (existing) {
      return existing;
    }

    const trimmedName = name.trim();
    const trimmedTimezone = timezone.trim();
    const trimmedPreferences = preferences.trim();
    const factUpdates: string[] = [];
    const summaries: string[] = [];

    if (trimmedTimezone && !isValidTimeZone(trimmedTimezone)) {
      const invalid = this.makeResult('saveProfile', `Timezone looks invalid: ${trimmedTimezone}. Please use an IANA timezone like Asia/Kolkata.`, false);
      this.saveMutationResult('saveProfile', updateKey, invalid);
      return invalid;
    }

    if (trimmedName) {
      this.name = trimmedName;
      factUpdates.push(`User name: ${trimmedName}.`);
      summaries.push(`Saved name: ${trimmedName}.`);
    }

    if (trimmedTimezone) {
      this.timezone = trimmedTimezone;
      factUpdates.push(`User timezone: ${trimmedTimezone}.`);
      summaries.push(`Saved timezone: ${trimmedTimezone}.`);
    }

    if (trimmedPreferences) {
      this.pushFact(trimmedPreferences);
      factUpdates.push(`User preferences: ${trimmedPreferences}.`);
      summaries.push('Saved durable preferences.');
    }

    if (factUpdates.length === 0) {
      const empty = this.makeResult('saveProfile', 'Please provide a name, timezone, or preferences to save.', false);
      this.saveMutationResult('saveProfile', updateKey, empty);
      return empty;
    }

    await this.updateMemoryFromFact(factUpdates.join(' '));
    const result = this.makeResult('saveProfile', summaries.join('\n'), true);
    this.saveMutationResult('saveProfile', updateKey, result);
    return result;
  }

  // Stores one durable user fact and updates the compact memory summary.
  async rememberFact(fact: string, updateKey?: string): Promise<ProfileStoreResult> {
    const existing = this.getMutationResult('rememberFact', updateKey);
    if (existing) {
      return existing;
    }

    const trimmed = fact.trim();
    if (!trimmed) {
      const empty = this.makeResult('rememberFact', 'Please provide something important to remember.', false);
      this.saveMutationResult('rememberFact', updateKey, empty);
      return empty;
    }

    this.pushFact(trimmed);
    await this.updateMemoryFromFact(trimmed);
    const result = this.makeResult('rememberFact', 'I saved that to long-term memory.', true);
    this.saveMutationResult('rememberFact', updateKey, result);
    return result;
  }

  // Adds or updates the default email destination.
  async addEmail(email: string, label: string | undefined, updateKey?: string): Promise<ProfileStoreResult> {
    const existing = this.getMutationResult('addEmail', updateKey);
    if (existing) {
      return existing;
    }

    const normalized = email.trim().toLowerCase();
    const displayLabel = label?.trim() || 'primary';
    let result: ProfileStoreResult;

    if (!this.isValidEmail(normalized)) {
      result = this.makeResult('addEmail', `Please provide a valid email address. I got: ${email}`, false);
    } else {
      const existingEmail = this.emails.find((entry) => entry.email === normalized);
      if (existingEmail) {
        existingEmail.label = displayLabel;
        existingEmail.default = true;
        this.emails.forEach((entry) => {
          if (entry.email !== normalized) {
            entry.default = false;
          }
        });
        result = this.makeResult('addEmail', `Updated default email: ${normalized}.`, true);
      } else {
        this.emails.push({
          email: normalized,
          label: displayLabel,
          default: true,
          createdAt: new Date().toISOString(),
        });
        this.emails.forEach((entry) => {
          entry.default = entry.email === normalized;
        });
        result = this.makeResult('addEmail', `Saved default email: ${normalized}.`, true);
      }
    }

    this.saveMutationResult('addEmail', updateKey, result);
    return result;
  }

  // Lists saved email addresses and the current default.
  async listEmails(): Promise<ProfileStoreResult> {
    if (this.emails.length === 0) {
      return this.makeResult('listEmails', 'No email addresses are saved yet.', true);
    }

    return this.makeResult(
      'listEmails',
      `Saved emails:\n${this.emails.map((entry) => `- ${entry.email} (${entry.label})${entry.default ? ' [default]' : ''}`).join('\n')}`,
      true
    );
  }

  // Resolves and stores the default city used for weather lookups.
  async setCity(city: string, updateKey?: string): Promise<ProfileStoreResult> {
    const existing = this.getMutationResult('setCity', updateKey);
    if (existing) {
      return existing;
    }

    const resolved = await resolveCity(this.config.value.weatherApiKey, city);
    let result: ProfileStoreResult;

    if (!resolved) {
      result = this.makeResult('setCity', `I could not find a city matching ${city}.`, false);
    } else {
      this.city = resolved;
      await this.updateMemoryFromFact(`User default city: ${formatLocation(resolved)}.`);
      result = this.makeResult('setCity', `Saved city as ${formatLocation(resolved)}.`, true);
    }

    this.saveMutationResult('setCity', updateKey, result);
    return result;
  }

  // Enables or pauses rule-based automation for this chat.
  async toggleAutomation(enabled: boolean, updateKey?: string): Promise<ProfileStoreResult> {
    const existing = this.getMutationResult('toggleAutomation', updateKey);
    if (existing) {
      return existing;
    }

    this.automationEnabled = enabled;
    const result = this.makeResult('toggleAutomation', enabled ? 'Automation remains enabled.' : 'Automation has been paused.', true);
    this.saveMutationResult('toggleAutomation', updateKey, result);
    return result;
  }

  // Returns a read-only snapshot for prompts, reports, and orchestration.
  async getProfileSnapshot(): Promise<ProfileSnapshot> {
    return this.snapshot();
  }

  // Returns the saved timezone if one has been set.
  async getTimezone(): Promise<string | undefined> {
    return this.timezone;
  }

  // Returns the saved city if one has been set.
  async getCity(): Promise<SavedLocation | undefined> {
    return this.city ? { ...this.city } : undefined;
  }

  // Returns the default email, falling back to the first saved address.
  async getDefaultEmail(): Promise<string | undefined> {
    return this.emails.find((entry) => entry.default)?.email ?? this.emails[0]?.email;
  }

  // Returns whether automation is currently enabled for this chat.
  async isAutomationEnabled(): Promise<boolean> {
    return this.automationEnabled;
  }

  // Builds a defensive copy of all durable profile fields.
  private snapshot(): ProfileSnapshot {
    return {
      name: this.name,
      username: this.username,
      timezone: this.timezone,
      city: this.city ? { ...this.city } : undefined,
      emails: this.emails.map((entry) => ({ ...entry })),
      facts: [...this.facts],
      memory: this.memory,
      automationEnabled: this.automationEnabled,
    };
  }

  // Deduplicates facts while keeping the most recent wording.
  private pushFact(fact: string): void {
    const trimmed = fact.trim();
    if (!trimmed) {
      return;
    }

    const existingIndex = this.facts.findIndex((entry) => entry.toLowerCase() === trimmed.toLowerCase());
    if (existingIndex !== -1) {
      this.facts.splice(existingIndex, 1);
    }

    this.facts.push(trimmed);
    if (this.facts.length > FACT_LIMIT) {
      this.facts.splice(0, this.facts.length - FACT_LIMIT);
    }
  }

  // Packages the current profile state into a tool result payload.
  private makeResult(tool: ProfileStoreResult['tool'], summary: string, ok: boolean): ProfileStoreResult {
    return {
      tool,
      ok,
      summary,
      profile: this.snapshot(),
    };
  }

  // Reuses the last mutation result so retries stay idempotent.
  private getMutationResult(tool: ProfileStoreResult['tool'], updateKey: string | undefined): ProfileStoreResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === `${tool}:${updateKey}`)?.result;
  }

  // Stores mutation results under a tool-specific idempotency key.
  private saveMutationResult(tool: ProfileStoreResult['tool'], updateKey: string | undefined, result: ProfileStoreResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: `${tool}:${updateKey}`, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }

  // Uses a minimal email regex because the store just needs basic guardrails.
  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // Rebuilds the compact durable memory summary from explicit facts only.
  private async updateMemoryFromFact(fact: string): Promise<void> {
    try {
      const memory = await callGemini(
        this.config.value.geminiApiKey,
        [
          'Update long-term memory for this Telegram assistant from explicit durable facts.',
          'Only keep facts likely to matter in future chats: user preferences, personal facts, standing projects, timezone, city, email preference, and recurring constraints.',
          'Merge with existing memory and remove contradictions. Do not add generic filler.',
          'Keep it as concise bullet points.',
          '',
          'Existing memory:',
          this.memory || 'None.',
          '',
          'New durable fact:',
          fact,
        ].join('\n')
      );
      this.memory = memory.slice(0, 4000);
    } catch {
      // Memory maintenance must never block the user-facing path.
    }
  }
}
