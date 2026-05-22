// Stores durable goals, recent progress, and stale-goal follow-up metadata.
import { BaseAgent, agent } from '@golemcloud/golem-ts-sdk';

export type GoalProgressEntry = {
  timestampIso: string;
  note: string;
};

export type Goal = {
  id: string;
  title: string;
  trackingPlan: string;
  status: 'active' | 'paused' | 'done';
  progress: GoalProgressEntry[];
  createdAt: string;
  updatedAt: string;
  lastProgressAt?: string;
  lastNudgedAt?: string;
};

export type GoalStoreResult = {
  tool: 'addGoal' | 'listGoals' | 'logGoalProgress' | 'markGoalNudged';
  ok: boolean;
  summary: string;
  goals: Goal[];
  goal?: Goal;
};

type MutationResult = {
  key: string;
  result: GoalStoreResult;
};

const GOAL_LIMIT = 20;
const GOAL_PROGRESS_LIMIT = 20;
const MUTATION_RESULT_LIMIT = 100;

@agent()
export class GoalStore extends BaseAgent {
  private goals: Goal[] = [];
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string) {
    super();
  }

  // Adds a new goal or refreshes the tracking plan for an existing one.
  async addGoal(title: string, trackingPlan: string, updateKey?: string): Promise<GoalStoreResult> {
    const existing = this.getMutationResult('addGoal', updateKey);
    if (existing) {
      return existing;
    }

    const trimmedTitle = title.trim();
    const trimmedPlan = trackingPlan.trim() || 'Check in on concrete progress, blockers, habits, and measurable signals relevant to this goal.';
    if (!trimmedTitle) {
      const empty = this.makeResult('addGoal', 'Please provide a goal to track.', false);
      this.saveMutationResult('addGoal', updateKey, empty);
      return empty;
    }

    const existingGoal = this.goals.find((entry) => entry.title.toLowerCase() === trimmedTitle.toLowerCase());
    if (existingGoal) {
      existingGoal.trackingPlan = trimmedPlan;
      existingGoal.updatedAt = new Date().toISOString();
      const result = this.makeResult('addGoal', `Updated goal ${existingGoal.id}: ${existingGoal.title}.`, true, existingGoal);
      this.saveMutationResult('addGoal', updateKey, result);
      return result;
    }

    const now = new Date().toISOString();
    const goal: Goal = {
      id: this.uniqueGoalId(`goal-${this.slugify(trimmedTitle)}`),
      title: trimmedTitle,
      trackingPlan: trimmedPlan,
      status: 'active',
      progress: [],
      createdAt: now,
      updatedAt: now,
    };
    this.goals.push(goal);
    if (this.goals.length > GOAL_LIMIT) {
      this.goals.shift();
    }

    const result = this.makeResult('addGoal', `Tracking goal ${goal.id}: ${goal.title}\nPlan: ${goal.trackingPlan}`, true, goal);
    this.saveMutationResult('addGoal', updateKey, result);
    return result;
  }

  // Lists tracked goals in a compact chat-friendly format.
  async listGoals(): Promise<GoalStoreResult> {
    if (this.goals.length === 0) {
      return this.makeResult('listGoals', 'No goals are being tracked yet.', true);
    }

    return this.makeResult(
      'listGoals',
      `Tracked goals:\n${this.goals.map((goal) => `- ${goal.id}: ${goal.title}\n  Plan: ${goal.trackingPlan}`).join('\n')}`,
      true
    );
  }

  // Appends one progress note to a matched goal.
  async logGoalProgress(goal: string, progress: string, updateKey?: string): Promise<GoalStoreResult> {
    const existing = this.getMutationResult('logGoalProgress', updateKey);
    if (existing) {
      return existing;
    }

    const goalEntry = this.findGoal(goal);
    const trimmedProgress = progress.trim();
    if (!goalEntry) {
      const missing = this.makeResult('logGoalProgress', `I could not find a goal matching: ${goal}.`, false);
      this.saveMutationResult('logGoalProgress', updateKey, missing);
      return missing;
    }
    if (!trimmedProgress) {
      const empty = this.makeResult('logGoalProgress', 'Please provide progress to log.', false);
      this.saveMutationResult('logGoalProgress', updateKey, empty);
      return empty;
    }

    const timestampIso = new Date().toISOString();
    goalEntry.progress.push({ timestampIso, note: trimmedProgress });
    if (goalEntry.progress.length > GOAL_PROGRESS_LIMIT) {
      goalEntry.progress.shift();
    }
    goalEntry.updatedAt = timestampIso;
    goalEntry.lastProgressAt = timestampIso;

    const result = this.makeResult('logGoalProgress', `Logged progress for ${goalEntry.title}: ${trimmedProgress}`, true, goalEntry);
    this.saveMutationResult('logGoalProgress', updateKey, result);
    return result;
  }

  // Records that the user has already been nudged about a stale goal.
  async markGoalNudged(goalId: string, timestampIso = new Date().toISOString(), updateKey?: string): Promise<GoalStoreResult> {
    const existing = this.getMutationResult('markGoalNudged', updateKey);
    if (existing) {
      return existing;
    }

    const goal = this.findGoal(goalId);
    if (!goal) {
      const missing = this.makeResult('markGoalNudged', `I could not find a goal matching: ${goalId}.`, false);
      this.saveMutationResult('markGoalNudged', updateKey, missing);
      return missing;
    }

    goal.lastNudgedAt = timestampIso;
    goal.updatedAt = timestampIso;
    const result = this.makeResult('markGoalNudged', `Recorded a goal follow-up for ${goal.title}.`, true, goal);
    this.saveMutationResult('markGoalNudged', updateKey, result);
    return result;
  }

  // Returns a defensive copy for reporting and orchestration.
  async getGoals(): Promise<Goal[]> {
    return this.goals.map((goal) => ({ ...goal, progress: goal.progress.map((entry) => ({ ...entry })) }));
  }

  // Finds active goals with no recent progress inside the stale window.
  async getStaleGoals(staleDays: number, nowIso?: string): Promise<Goal[]> {
    const staleMs = staleDays * 24 * 60 * 60 * 1000;
    const now = nowIso ? new Date(nowIso) : new Date();

    return this.goals
      .filter((goal) => goal.status === 'active')
      .filter((goal) => {
        const lastActivityIso = goal.lastProgressAt ?? goal.createdAt;
        const lastActivityMs = new Date(lastActivityIso).getTime();
        if (Number.isNaN(lastActivityMs)) {
          return false;
        }
        return now.getTime() - lastActivityMs >= staleMs;
      })
      .map((goal) => ({ ...goal, progress: goal.progress.map((entry) => ({ ...entry })) }));
  }

  // Packages the current goal state into a tool result payload.
  private makeResult(tool: GoalStoreResult['tool'], summary: string, ok: boolean, goal?: Goal): GoalStoreResult {
    return {
      tool,
      ok,
      summary,
      goals: this.goals.map((entry) => ({ ...entry, progress: entry.progress.map((progress) => ({ ...progress })) })),
      goal: goal ? { ...goal, progress: goal.progress.map((entry) => ({ ...entry })) } : undefined,
    };
  }

  // Matches goals by id, exact title, or partial title.
  private findGoal(goal: string): Goal | undefined {
    const normalized = goal.trim().toLowerCase();
    if (normalized.length === 0) {
      return undefined;
    }

    return this.goals.find((entry) =>
      entry.id.toLowerCase() === normalized
      || entry.title.toLowerCase() === normalized
      || entry.title.toLowerCase().includes(normalized)
    );
  }

  // Avoids collisions when similar goal titles are created repeatedly.
  private uniqueGoalId(baseId: string): string {
    let candidate = baseId;
    let suffix = 2;

    while (this.goals.some((goal) => goal.id === candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  // Generates readable stable ids from free-form goal titles.
  private slugify(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'goal';
  }

  // Reuses the last mutation result so retries stay idempotent.
  private getMutationResult(tool: GoalStoreResult['tool'], updateKey: string | undefined): GoalStoreResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === `${tool}:${updateKey}`)?.result;
  }

  // Stores mutation results under a tool-specific idempotency key.
  private saveMutationResult(tool: GoalStoreResult['tool'], updateKey: string | undefined, result: GoalStoreResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: `${tool}:${updateKey}`, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }
}
