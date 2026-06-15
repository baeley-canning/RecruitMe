/**
 * Shared tag/reminder DTOs — imported by BOTH the API callers and the
 * components so the payload shape and the UI types can't drift (the recurring
 * contract-drift bug class). Tag colour is per-tag user data (CandidateTag.color,
 * default #6366f1) and is the one sanctioned inline-hex in the UI.
 */

export interface TagDto {
  id: string;
  label: string;
  color: string;
}

export interface TagWithCount extends TagDto {
  orgId: string;
  createdAt: string;
  _count: { assignments: number };
}

/** Preset swatch palette for the tag manager — token-aligned hexes. */
export const TAG_PRESET_COLORS = [
  "#0a84ff", "#30d158", "#ff9f0a", "#ff453a",
  "#5e5ce6", "#64d2ff", "#bf5af2", "#6366f1",
] as const;

export type ReminderType = "follow_up" | "guarantee_check" | "client_feedback" | "custom";

export interface ReminderDto {
  id: string;
  candidateId: string | null;
  jobId: string | null;
  clientId: string | null;
  placementId: string | null;
  type: ReminderType;
  dueAt: string;
  note: string | null;
  dismissed: boolean;
  dismissedAt: string | null;
}

export const REMINDER_TYPE_LABEL: Record<ReminderType, string> = {
  follow_up: "Follow-up",
  guarantee_check: "Guarantee check",
  client_feedback: "Client feedback",
  custom: "Reminder",
};
