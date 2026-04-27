/** Returns true when a candidate row has a meaningful captured profile. */
export function hasFullCandidateProfile(row: {
  profileCapturedAt: Date | string | null | undefined;
  profileText: string | null | undefined;
}): boolean {
  return Boolean(row.profileCapturedAt || (row.profileText?.trim().length ?? 0) >= 500);
}
