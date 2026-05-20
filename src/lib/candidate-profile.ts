export const FULL_PROFILE_MIN_CHARS = 2000;
export const CAPTURED_PROFILE_MIN_CHARS = 500;

/** Returns true when a candidate row has a meaningful reusable profile. */
export function hasFullCandidateProfile(row: {
  profileCapturedAt: Date | string | null | undefined;
  profileText: string | null | undefined;
}): boolean {
  const charCount = row.profileText?.trim().length ?? 0;
  if (charCount >= FULL_PROFILE_MIN_CHARS) return true;
  return Boolean(row.profileCapturedAt && charCount >= CAPTURED_PROFILE_MIN_CHARS);
}
