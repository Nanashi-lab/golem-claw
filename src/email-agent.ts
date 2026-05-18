import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import type { TelegramConfig } from './gemini';

export type EmailAddress = {
  email: string;
  label: string;
  default: boolean;
  createdAt: string;
};

export type EmailResult = {
  tool: 'addEmail' | 'listEmails' | 'sendEmail';
  ok: boolean;
  summary: string;
  emails: EmailAddress[];
  sentId?: string;
};

type MutationResult = {
  key: string;
  result: EmailResult;
};

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const MUTATION_RESULT_LIMIT = 100;

@agent()
export class EmailAgent extends BaseAgent {
  private emails: EmailAddress[] = [];
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  async addEmail(email: string, label: string | undefined, updateKey?: string): Promise<EmailResult> {
    const existing = this.getMutationResult('addEmail', updateKey);
    if (existing) {
      return existing;
    }

    const normalized = email.trim().toLowerCase();
    const displayLabel = label?.trim() || 'primary';
    let result: EmailResult;

    if (!this.isValidEmail(normalized)) {
      result = this.makeResult('addEmail', `Please provide a valid email address. I got: ${email}`);
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

  async listEmails(): Promise<EmailResult> {
    if (this.emails.length === 0) {
      return this.makeResult('listEmails', 'No email addresses are saved yet.', true);
    }

    return this.makeResult(
      'listEmails',
      `Saved emails:\n${this.emails.map((entry) => `- ${entry.email} (${entry.label})${entry.default ? ' [default]' : ''}`).join('\n')}`,
      true
    );
  }

  async sendEmail(to: string | undefined, subject: string, text: string, updateKey?: string): Promise<EmailResult> {
    const existing = this.getMutationResult('sendEmail', updateKey);
    if (existing) {
      return existing;
    }

    const recipient = this.resolveRecipient(to);
    const trimmedSubject = subject.trim();
    const trimmedText = text.trim();
    let result: EmailResult;

    if (!recipient) {
      result = this.makeResult('sendEmail', 'No recipient found. Add an email first or provide one explicitly.');
    } else if (trimmedSubject.length === 0) {
      result = this.makeResult('sendEmail', 'Please provide an email subject.');
    } else if (trimmedText.length === 0) {
      result = this.makeResult('sendEmail', 'Please provide email body text.');
    } else {
      const sentId = await this.postEmail(recipient, trimmedSubject, trimmedText, updateKey);
      result = this.makeResult('sendEmail', `Email sent to ${recipient}: ${trimmedSubject}.`, true, sentId);
    }

    this.saveMutationResult('sendEmail', updateKey, result);
    return result;
  }

  async sendStoredEmail(subject: string, text: string, idempotencyKey: string): Promise<EmailResult> {
    return this.sendEmail(undefined, subject, text, idempotencyKey);
  }

  async getDefaultEmail(): Promise<string | undefined> {
    return this.emails.find((entry) => entry.default)?.email ?? this.emails[0]?.email;
  }

  private async postEmail(to: string, subject: string, text: string, idempotencyKey?: string): Promise<string> {
    const response = await fetch(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.value.resendApiKey.get()}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': this.safeIdempotencyKey(idempotencyKey) } : {}),
      },
      body: JSON.stringify({
        from: this.config.value.resendFromEmail.get(),
        to: [to],
        subject,
        text,
        html: `<pre style="white-space: pre-wrap; font-family: sans-serif;">${this.escapeHtml(text)}</pre>`,
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Resend send failed: ${response.status} ${body}`);
    }

    const parsed = JSON.parse(body) as { id?: string };
    return parsed.id ?? 'unknown';
  }

  private resolveRecipient(to: string | undefined): string | undefined {
    const trimmed = to?.trim().toLowerCase() ?? '';
    if (trimmed.length > 0 && this.isValidEmail(trimmed)) {
      return trimmed;
    }

    if (trimmed.length > 0) {
      return undefined;
    }

    return this.emails.find((entry) => entry.default)?.email ?? this.emails[0]?.email;
  }

  private makeResult(tool: EmailResult['tool'], summary: string, ok = false, sentId?: string): EmailResult {
    return {
      tool,
      ok,
      summary,
      emails: this.emails.map((entry) => ({ ...entry })),
      sentId,
    };
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private safeIdempotencyKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 256);
  }

  private getMutationResult(tool: EmailResult['tool'], updateKey: string | undefined): EmailResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === `${tool}:${updateKey}`)?.result;
  }

  private saveMutationResult(tool: EmailResult['tool'], updateKey: string | undefined, result: EmailResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: `${tool}:${updateKey}`, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }
}
