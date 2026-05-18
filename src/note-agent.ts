import { BaseAgent, agent } from '@golemcloud/golem-ts-sdk';

export type Note = {
  name: string;
  title: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  kind: 'note' | 'research';
};

export type NoteResult = {
  tool: 'saveNote' | 'saveResearchNote' | 'listNotes' | 'readNote' | 'editNote' | 'deleteNote';
  ok: boolean;
  summary: string;
  notes: Note[];
  note?: Note;
};

type MutationResult = {
  key: string;
  result: NoteResult;
};

const MUTATION_RESULT_LIMIT = 100;

@agent()
export class NoteAgent extends BaseAgent {
  private notes: Note[] = [];
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string) {
    super();
  }

  async saveNote(text: string, updateKey?: string): Promise<NoteResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const trimmed = text.trim();
    let result: NoteResult;

    if (trimmed.length === 0) {
      result = this.makeResult('saveNote', 'I could not save an empty note.');
    } else {
      this.notes.push({
        name: this.uniqueName(`note-${this.slugify(this.makeTitle(trimmed))}`),
        title: this.makeTitle(trimmed),
        text: trimmed,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        kind: 'note',
      });
      const note = this.notes[this.notes.length - 1];
      result = this.makeResult('saveNote', `Saved note ${note?.name}: ${note?.title}.`, note, true);
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  async saveResearchNote(title: string, text: string, updateKey?: string): Promise<NoteResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const trimmedTitle = title.trim() || 'Research note';
    const trimmedText = text.trim();
    let result: NoteResult;

    if (trimmedText.length === 0) {
      result = this.makeResult('saveResearchNote', 'I could not save an empty research note.');
    } else {
      const note = {
        name: this.uniqueName(`research-${this.slugify(trimmedTitle.replace(/^Research:\s*/i, ''))}`),
        title: trimmedTitle,
        text: trimmedText,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        kind: 'research' as const,
      };
      this.notes.push(note);
      result = this.makeResult('saveResearchNote', `Saved research note ${note.name}: ${note.title}.`, note, true);
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  async listNotes(): Promise<NoteResult> {
    if (this.notes.length === 0) {
      return this.makeResult('listNotes', 'You do not have any saved notes.', undefined, true);
    }

    return this.makeResult(
      'listNotes',
      `Saved notes:\n${this.notes.map((note) => `- ${note.name} (${note.kind}): ${note.title}`).join('\n')}`,
      undefined,
      true
    );
  }

  async readNote(name: string): Promise<NoteResult> {
    const note = this.findNote(name);
    if (!note) {
      return this.makeResult('readNote', `I could not find a note named ${name}.`);
    }

    return this.makeResult('readNote', `${note.name} (${note.kind}): ${note.title}\n\n${note.text}`, note, true);
  }

  async editNote(
    name: string,
    text: string | undefined,
    newName: string | undefined,
    title: string | undefined,
    updateKey?: string
  ): Promise<NoteResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const note = this.findNote(name);
    const trimmedText = text?.trim() ?? '';
    const trimmedTitle = title?.trim() ?? '';
    const normalizedName = newName ? this.slugify(newName) : '';
    let result: NoteResult;

    if (!note) {
      result = this.makeResult('editNote', `I could not find a note named ${name}.`);
    } else if (trimmedText.length === 0 && trimmedTitle.length === 0 && normalizedName.length === 0) {
      result = this.makeResult('editNote', 'Please provide note text, a title, or a new name to update.');
    } else {
      const changes: string[] = [];
      if (trimmedText.length > 0) {
        note.text = trimmedText;
        changes.push('text');
      }
      if (trimmedTitle.length > 0) {
        note.title = trimmedTitle;
        changes.push('title');
      }
      if (normalizedName.length > 0) {
        const prefix = note.kind === 'research' && !normalizedName.startsWith('research-') ? 'research-' : '';
        note.name = this.uniqueName(`${prefix}${normalizedName}`, note.name);
        changes.push('name');
      }
      note.updatedAt = new Date().toISOString();
      result = this.makeResult('editNote', `Updated note ${note.name}: ${changes.join(', ')}.`, note, true);
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  async deleteNote(name: string, updateKey?: string): Promise<NoteResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const index = this.notes.findIndex((note) => this.matchesNote(note, name));
    let result: NoteResult;

    if (index === -1) {
      result = this.makeResult('deleteNote', `I could not find a note named ${name}.`);
    } else {
      const deleted = this.notes.splice(index, 1)[0];
      result = this.makeResult('deleteNote', `Deleted note ${deleted?.name}: ${deleted?.title}.`, deleted, true);
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  private makeTitle(text: string): string {
    return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
  }

  private makeResult(tool: NoteResult['tool'], summary: string, note?: Note, ok = false): NoteResult {
    return {
      tool,
      ok,
      summary,
      notes: [...this.notes],
      note,
    };
  }

  private findNote(name: string): Note | undefined {
    return this.notes.find((note) => this.matchesNote(note, name));
  }

  private matchesNote(note: Note, name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return note.name.toLowerCase() === normalized || note.title.toLowerCase() === normalized;
  }

  private uniqueName(baseName: string, currentName?: string): string {
    const base = this.slugify(baseName) || 'note';
    let candidate = base;
    let suffix = 2;

    while (this.notes.some((note) => note.name === candidate && note.name !== currentName)) {
      candidate = `${base}-${suffix}`;
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
      .slice(0, 80);
  }

  private getMutationResult(updateKey: string | undefined): NoteResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === updateKey)?.result;
  }

  private saveMutationResult(updateKey: string | undefined, result: NoteResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: updateKey, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }
}
