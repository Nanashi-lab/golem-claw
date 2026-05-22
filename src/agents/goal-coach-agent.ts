// Uses Gemini for goal-specific coaching text without owning any durable state.
import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import { callGemini, type TelegramConfig } from '../gemini';
import type { Goal } from '../stores/goal-store';

@agent()
export class GoalCoachAgent extends BaseAgent {
  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  // Produces a compact tracking plan when the user first declares a goal.
  async createTrackingPlan(goal: string): Promise<string> {
    if (goal.trim().length === 0) {
      return '';
    }

    try {
      return (await callGemini(
        this.config.value.geminiApiKey,
        [
          'Create a concise tracking plan for this user goal.',
          'Include 3-5 concrete signals the assistant should ask about or track.',
          'Reply as one short sentence or semicolon-separated phrase, no markdown.',
          '',
          `Goal: ${goal}`,
        ].join('\n')
      )).slice(0, 800);
    } catch {
      return 'Check in on concrete progress, blockers, habits, and measurable signals relevant to this goal.';
    }
  }

  // Produces one supportive follow-up when a goal has gone stale.
  async composeStaleGoalPrompt(goal: Goal): Promise<string> {
    const recentProgress = goal.progress.slice(-5).map((entry) => `${entry.timestampIso}: ${entry.note}`).join('\n') || 'No recent progress logged.';

    try {
      return (await callGemini(
        this.config.value.geminiApiKey,
        [
          'Write one concise Telegram follow-up for a user goal that has gone quiet.',
          'Be supportive, specific, and short. Ask one concrete question or suggest one next step.',
          'Do not use markdown bullets.',
          '',
          `Goal: ${goal.title}`,
          `Tracking plan: ${goal.trackingPlan}`,
          `Recent progress: ${recentProgress}`,
        ].join('\n')
      )).slice(0, 500);
    } catch {
      return `Quick check-in on ${goal.title}: what is the next concrete step, or what has been getting in the way?`;
    }
  }
}
