/**
 * Candidate avatar photo URL helper.
 *
 * Photos are recruiter-uploaded, encrypted at rest, and served via the existing
 * CandidateFile infrastructure — same encryption, same per-org auth check,
 * same inline-vs-attachment allow-list — only the `type` discriminator
 * differs ("photo" vs "cv" / "cover_letter" / "other").
 *
 * Earlier iterations of this helper tried to resolve LinkedIn-slug avatars
 * through unavatar.io. That stopped being viable: real recruiter URLs hit
 * unavatar's LinkedIn route at a ~17% success rate (5 of 6 production URLs
 * returned 404 in a hand-test on 2026-05-20). The image fell back to initials
 * on almost every candidate, so the photo column looked identical to the
 * pre-PR state. We dropped the network-resolution path entirely in favour of
 * an explicit upload affordance — see /api/candidates/[id]/photo.
 *
 * This helper is pure URL construction — no network call, no DB read. The
 * caller's SELECT must include candidate.photoFileId; null = "no photo set"
 * and the Avatar component falls back to initials.
 */

export function getCandidatePhotoUrl(input: {
  photoFileId?: string | null;
  candidateId?: string | null;
}): string | null {
  if (!input.photoFileId) return null;
  if (!input.candidateId) return null;
  return `/api/candidates/${input.candidateId}/files/${input.photoFileId}?inline=1`;
}
