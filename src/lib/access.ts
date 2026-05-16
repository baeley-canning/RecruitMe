// Shared access-control predicates. Kept tiny so client components and
// server routes can share the same role checks.
//
// Accepts any session-like object — next-auth's Session.user type doesn't
// include a `role` field by default (we extend it via the JWT callback) so
// the predicate reads `role` through an `unknown` cast rather than requiring
// every caller to widen the type.

type SessionLike = { user?: unknown } | null | undefined;

/** True when the current session belongs to a platform owner. */
export function isOwner(session: SessionLike): boolean {
  const user = session?.user as { role?: string } | undefined;
  return user?.role === "owner";
}
