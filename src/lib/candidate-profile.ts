/** Returns true when a candidate row has a meaningful captured profile. */
export function hasFullCandidateProfile(row: {
  profileCapturedAt: Date | string | null | undefined;
  profileText: string | null | undefined;
}): boolean {
  return (row.profileText?.trim().length ?? 0) >= 2000;
}
