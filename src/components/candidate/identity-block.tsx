"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Mail, MapPin, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { scoreTier, scoreTierColor, type ScoreTier } from "@/lib/score-utils";
import { LinkedInIcon } from "./icons";
import { displayableLinkedinUrl } from "./helpers";

// JobAdder-style tier-word labels for match scores. Mirrors the local
// TIER_STYLE map in src/app/candidates/[id]/page.tsx so labels stay
// consistent across surfaces. Kept here (not in score-utils) because
// score-utils is used by server code that has no need for UI copy.
const TIER_LABEL: Record<ScoreTier, string> = {
  strong: "Strong match",
  fair:   "Good match",
  weak:   "Moderate match",
  poor:   "Weak match",
};

// Tier text colours matching the detail-page TIER_STYLE palette
// (strong→success, fair→accent, weak→warning, poor→tertiary). The
// scoreTierColor() helper returns *background* pills — for the inline
// tier-word label we want just the text colour.
const TIER_TEXT: Record<ScoreTier, string> = {
  strong: "text-success",
  fair:   "text-accent",
  weak:   "text-warning",
  poor:   "text-text-tertiary",
};

/**
 * Pure helper — exported so it can be unit-tested without rendering React.
 *
 * Returns the string + colour class the IdentityBlock should display for
 * a given (score, format) pair. Returns null when there's nothing to show.
 *
 * - format="number": returns "{score}%" with the existing pill colours
 *   (background-tinted, matches pre-refactor look).
 * - format="tier" : returns "{Tier match} · {score}" with just text colour
 *   (no background pill — tier-word labels read better unboxed).
 */
export function formatScoreLabel(
  score: number | null | undefined,
  format: "number" | "tier" = "number",
): { text: string; colorClass: string; isTier: boolean } | null {
  if (score == null) return null;
  const tier = scoreTier(score, "match");
  if (format === "tier") {
    return { text: `${TIER_LABEL[tier]} · ${score}`, colorClass: TIER_TEXT[tier], isTier: true };
  }
  return { text: `${score}%`, colorClass: scoreTierColor(tier), isTier: false };
}

export function candidateInitials(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// All sizes use rounded-full — consistent profile-photo feel everywhere.
const AVATAR_CLASSES = {
  sm: "w-8 h-8 text-xs rounded-full",
  md: "w-10 h-10 text-sm rounded-full",
  lg: "w-14 h-14 text-base rounded-full",
} as const;

function Avatar({
  name,
  size = "md",
  onClick,
  title,
  photoUrl,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
  title?: string;
  photoUrl?: string | null;
}) {
  // Track per-render whether the photo errored so we can fall back to
  // initials. The /api/candidates/<id>/files/<photoFileId>?inline=1 route
  // returns 404 when the file has been deleted (or the candidate was
  // restored without one) — that 404 fires onError and the swap happens
  // cleanly without a broken-image glyph flash.
  const [imageFailed, setImageFailed] = useState(false);
  const showPhoto = Boolean(photoUrl) && !imageFailed;

  const cls = cn(
    "bg-accent-subtle text-accent flex items-center justify-center flex-shrink-0 font-semibold select-none overflow-hidden",
    AVATAR_CLASSES[size],
    onClick && "cursor-pointer hover:bg-accent/25 transition-colors",
  );

  // referrerPolicy="no-referrer" is belt-and-braces — the photo URL is
  // first-party (/api/candidates/...), but the policy means no Referer
  // leaks even if a future code path swaps in a third-party photo source.
  // Bare <img> (not next/image): the URL is dynamic per-candidate and the
  // image is encrypted-at-rest behind an auth-gated API route, neither of
  // which next/image's static optimiser knows how to handle. Avatars are
  // 32-56px so there's no LCP win from next/image anyway.
  const content = showPhoto ? (
    <img // eslint-disable-line @next/next/no-img-element
      src={photoUrl ?? undefined}
      alt={name}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setImageFailed(true)}
      className={cn("w-full h-full object-cover", AVATAR_CLASSES[size])}
    />
  ) : (
    candidateInitials(name)
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} title={title}>
        {content}
      </button>
    );
  }

  return <div className={cls}>{content}</div>;
}

export interface CandidateIdentityBlockProps {
  name: string;
  headline?: string | null;
  /** Plain-text location — renders with MapPin icon. Ignored when locationNode is set. */
  location?: string | null;
  /** Custom location node — use this to pass <LocationFitPill> in job context. */
  locationNode?: ReactNode;
  phone?: string | null;
  /** Plain-text email — renders as a `mailto:` link next to phone. */
  email?: string | null;
  linkedinUrl?: string | null;
  /** Optional avatar photo URL — when set, renders <img> with fallback to initials on error. */
  photoUrl?: string | null;
  score?: number | null;
  /** Render name as a Next.js link */
  href?: string;
  /** Callback: clicking avatar opens drawer (e.g. in-job pipeline card) */
  onAvatarClick?: () => void;
  /** Callback: clicking name opens drawer. Mutually exclusive with href. */
  onNameClick?: () => void;
  /** Extra nodes rendered inline after the name — e.g. LinkedIn icon, JobAdder badge */
  nameExtra?: ReactNode;
  size?: "sm" | "md" | "lg";
  showScore?: boolean;
  /** When "tier", render score as JobAdder-style tier-word label
   *  ("Strong match · 75") instead of bare "75%". Default "number"
   *  preserves the pre-refactor look on every untouched surface. */
  scoreFormat?: "number" | "tier";
  showPhone?: boolean;
  /** Render email next to phone when an email is present. Default true. */
  showEmail?: boolean;
  showLinkedIn?: boolean;
  /** Extra classes merged onto the name element, e.g. "group-hover:text-accent transition-colors" */
  nameClassName?: string;
  className?: string;
}

/**
 * Universal candidate identity block — avatar + name + headline + location +
 * optional phone / LinkedIn / score badge.
 *
 * Used across job pipeline, library, dashboard, browse modal, shortlist, and
 * candidate detail so the visual language is consistent everywhere.
 */
export function CandidateIdentityBlock({
  name,
  headline,
  location,
  locationNode,
  phone,
  email,
  linkedinUrl,
  photoUrl,
  score,
  href,
  onAvatarClick,
  onNameClick,
  nameExtra,
  size = "md",
  showScore = true,
  scoreFormat = "number",
  showPhone = false,
  showEmail = true,
  showLinkedIn = false,
  nameClassName,
  className,
}: CandidateIdentityBlockProps) {
  const scoreLabel = formatScoreLabel(score, scoreFormat);
  const displayUrl = displayableLinkedinUrl(linkedinUrl ?? null);

  const nameCls = cn("font-semibold text-text-primary line-clamp-1", nameClassName);

  let nameEl: ReactNode;
  if (href) {
    nameEl = (
      <Link href={href} className={cn(nameCls, "hover:text-accent transition-colors")}>
        {name}
      </Link>
    );
  } else if (onNameClick) {
    nameEl = (
      <button
        type="button"
        onClick={onNameClick}
        className={cn(nameCls, "text-left hover:text-accent transition-colors")}
      >
        {name}
      </button>
    );
  } else {
    nameEl = <span className={nameCls}>{name}</span>;
  }

  const locationEl = locationNode ?? (
    location ? (
      <span className="flex items-center gap-1 text-xs text-text-tertiary">
        <MapPin className="w-3 h-3 flex-shrink-0" />
        <span className="line-clamp-1">{location}</span>
      </span>
    ) : null
  );

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <Avatar
        name={name}
        size={size}
        onClick={onAvatarClick}
        title={onAvatarClick ? "View profile" : undefined}
        photoUrl={photoUrl}
      />

      <div className="flex-1 min-w-0">
        {/* Name row */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex-1 min-w-0 flex items-center gap-1.5 min-w-0">
            {nameEl}
            {nameExtra}
            {showLinkedIn && displayUrl && !nameExtra && (
              <a
                href={displayUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-text-tertiary hover:text-accent transition-colors flex-shrink-0"
                title="Open LinkedIn profile"
              >
                <LinkedInIcon className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
          {showScore && scoreLabel && (
            <span
              className={cn(
                "text-xs font-medium flex-shrink-0",
                // Tier-word labels read better without a background pill —
                // they're already verbose ("Strong match · 75"). The numeric
                // variant keeps the pre-refactor padded pill for back-compat.
                scoreLabel.isTier
                  ? scoreLabel.colorClass
                  : cn("px-1.5 py-0.5 rounded-sm data-mono", scoreLabel.colorClass),
              )}
            >
              {scoreLabel.text}
            </span>
          )}
        </div>

        {/* Headline */}
        {headline && (
          <p className="text-xs text-text-secondary line-clamp-1 mt-0.5">{headline}</p>
        )}

        {/* Location + phone + email */}
        {(locationEl || (showPhone && phone) || (showEmail && email)) && (
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {locationEl}
            {showPhone && phone && (
              <a
                href={`tel:${phone}`}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-xs text-text-tertiary hover:text-accent transition-colors"
              >
                <Phone className="w-3 h-3 flex-shrink-0" />
                <span>{phone}</span>
              </a>
            )}
            {showEmail && email && (
              <a
                href={`mailto:${email}`}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-xs text-text-tertiary hover:text-accent transition-colors min-w-0"
                title={email}
              >
                <Mail className="w-3 h-3 flex-shrink-0" />
                <span className="truncate max-w-[200px]">{email}</span>
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
