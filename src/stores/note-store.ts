// Stores free-form notes plus research notes with tags and source links.
import { BaseAgent, agent } from '@golemcloud/golem-ts-sdk';

export type Note = {
  name: string;
  title: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  kind: 'note' | 'research';
  tags: string[];
  sources: string[];
};

export type NoteStoreResult = {
  tool: 'saveNote' | 'saveResearchNote' | 'listNotes' | 'readNote' | 'editNote' | 'deleteNote' | 'searchNotes';
  ok: boolean;
  summary: string;
  notes: Note[];
  note?: Note;
};

type MutationResult = {
  key: string;
  result: NoteStoreResult;
};

const MUTATION_RESULT_LIMIT = 100;

@agent()
export class NoteStore extends BaseAgent {
  private notes: Note[] = [];
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string) {
    super();
  }

  // Saves a plain note using the note text to derive a readable title and name.
  async saveNote(text: string, tags: string[] = [], updateKey?: string): Promise<NoteStoreResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const trimmed = text.trim();
    let result: NoteStoreResult;

    if (trimmed.length === 0) {
      result = this.makeResult('saveNote', 'I could not save an empty note.');
    } else {
      const note: Note = {
        name: this.uniqueName(`note-${this.slugify(this.makeTitle(trimmed))}`),
        title: this.makeTitle(trimmed),
        text: trimmed,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        kind: 'note',
        tags: this.normalizeTags(tags),
        sources: [],
      };
      this.notes.push(note);
      result = this.makeResult('saveNote', `Saved note ${note.name}: ${note.title}.`, note, true);
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  // Saves a research note with research tagging and optional source URLs.
  async saveResearchNote(title: string, text: string, updateKey?: string, tags: string[] = [], sources: string[] = []): Promise<NoteStoreResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const trimmedTitle = title.trim() || 'Research note';
    const trimmedText = text.trim();
    let result: NoteStoreResult;

    if (trimmedText.length === 0) {
      result = this.makeResult('saveResearchNote', 'I could not save an empty research note.');
    } else {
      const note: Note = {
        name: this.uniqueName(`research-${this.slugify(trimmedTitle.replace(/^Research:\s*/i, ''))}`),
        title: trimmedTitle,
        text: trimmedText,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        kind: 'research',
        tags: this.normalizeTags(['research', ...tags]),
        sources: sources.filter((source) => source.trim().length > 0),
      };
      this.notes.push(note);
      result = this.makeResult('saveResearchNote', `Saved research note ${note.name}: ${note.title}.`, note, true);
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  // Lists saved notes with their kind and tags.
  async listNotes(): Promise<NoteStoreResult> {
    if (this.notes.length === 0) {
      return this.makeResult('listNotes', 'You do not have any saved notes.', undefined, true);
    }

    return this.makeResult(
      'listNotes',
      `Saved notes:\n${this.notes.map((note) => `- ${note.name} (${note.kind})${note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''}: ${note.title}`).join('\n')}`,
      undefined,
      true
    );
  }

  // Reads a note back with its tags and saved sources.
  async readNote(name: string): Promise<NoteStoreResult> {
    const note = this.findNote(name);
    if (!note) {
      return this.makeResult('readNote', `I could not find a note named ${name}.`);
    }

    const sourceText = note.sources.length > 0 ? `\n\nSources:\n${note.sources.map((source) => `- ${source}`).join('\n')}` : '';
    const tagText = note.tags.length > 0 ? `\nTags: ${note.tags.join(', ')}` : '';
    return this.makeResult('readNote', `${note.name} (${note.kind}): ${note.title}${tagText}\n\n${note.text}${sourceText}`, note, true);
  }

  // Updates note text, title, name, or tags in one mutation.
  async editNote(name: string, text: string | undefined, newName: string | undefined, title: string | undefined, tags: string[] = [], updateKey?: string): Promise<NoteStoreResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const note = this.findNote(name);
    const trimmedText = text?.trim() ?? '';
    const trimmedTitle = title?.trim() ?? '';
    const normalizedName = newName ? this.slugify(newName) : '';
    const normalizedTags = this.normalizeTags(tags);
    let result: NoteStoreResult;

    if (!note) {
      result = this.makeResult('editNote', `I could not find a note named ${name}.`);
    } else if (trimmedText.length === 0 && trimmedTitle.length === 0 && normalizedName.length === 0 && normalizedTags.length === 0) {
      result = this.makeResult('editNote', 'Please provide note text, a title, tags, or a new name to update.');
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
      if (normalizedTags.length > 0) {
        note.tags = normalizedTags;
        changes.push('tags');
      }
      note.updatedAt = new Date().toISOString();
      result = this.makeResult('editNote', `Updated note ${note.name}: ${changes.join(', ')}.`, note, true);
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  // Deletes one matched note by name or title.
  async deleteNote(name: string, updateKey?: string): Promise<NoteStoreResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const index = this.notes.findIndex((note) => this.matchesNote(note, name));
    let result: NoteStoreResult;

    if (index === -1) {
      result = this.makeResult('deleteNote', `I could not find a note named ${name}.`);
    } else {
      const deleted = this.notes.splice(index, 1)[0];
      result = this.makeResult('deleteNote', `Deleted note ${deleted?.name}: ${deleted?.title}.`, deleted, true);
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  // Searches notes by text and optional tag.
  async searchNotes(query: string, tag?: string): Promise<NoteStoreResult> {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedTag = tag?.trim().toLowerCase();

    const matches = this.notes.filter((note) => {
      const matchesQuery = normalizedQuery.length === 0
        || note.name.toLowerCase().includes(normalizedQuery)
        || note.title.toLowerCase().includes(normalizedQuery)
        || note.text.toLowerCase().includes(normalizedQuery);
      const matchesTag = !normalizedTag || note.tags.some((entry) => entry.toLowerCase() === normalizedTag);
      return matchesQuery && matchesTag;
    });

    if (matches.length === 0) {
      return {
        tool: 'searchNotes',
        ok: true,
        summary: 'No notes matched that search.',
        notes: [],
      };
    }

    return {
      tool: 'searchNotes',
      ok: true,
      summary: `Matching notes:\n${matches.map((note) => `- ${note.name} (${note.kind})${note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''}: ${note.title}`).join('\n')}`,
      notes: matches.map((note) => ({ ...note, tags: [...note.tags], sources: [...note.sources] })),
    };
  }

  // Returns a defensive copy for reporting and read-only consumers.
  async getNotes(): Promise<Note[]> {
    return this.notes.map((note) => ({ ...note, tags: [...note.tags], sources: [...note.sources] }));
  }

  // Derives a short display title from a longer body of text.
  private makeTitle(text: string): string {
    return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
  }

  // Deduplicates and normalizes note tags.
  private normalizeTags(tags: string[]): string[] {
    return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))];
  }

  // Packages the current note state into a tool result payload.
  private makeResult(tool: NoteStoreResult['tool'], summary: string, note?: Note, ok = false): NoteStoreResult {
    return {
      tool,
      ok,
      summary,
      notes: this.notes.map((entry) => ({ ...entry, tags: [...entry.tags], sources: [...entry.sources] })),
      note: note ? { ...note, tags: [...note.tags], sources: [...note.sources] } : undefined,
    };
  }

  // Finds a note by exact durable name or exact title.
  private findNote(name: string): Note | undefined {
    return this.notes.find((note) => this.matchesNote(note, name));
  }

  // Keeps note lookup rules consistent across read, edit, and delete flows.
  private matchesNote(note: Note, name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return note.name.toLowerCase() === normalized || note.title.toLowerCase() === normalized;
  }

  // Avoids collisions when notes want the same readable name.
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

  // Generates slug-like durable note names from user text.
  private slugify(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  // Reuses the last mutation result so retries stay idempotent.
  private getMutationResult(updateKey: string | undefined): NoteStoreResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === updateKey)?.result;
  }

  // Stores mutation results under a stable idempotency key.
  private saveMutationResult(updateKey: string | undefined, result: NoteStoreResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: updateKey, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }
}
