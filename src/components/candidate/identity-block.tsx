"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { MapPin, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { scoreTier, scoreTierColor } from "@/lib/score-utils";
import { LinkedInIcon } from "./icons";
import { displayableLinkedinUrl } from "./helpers";

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
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
  title?: string;
}) {
  const cls = cn(
    "bg-accent-subtle text-accent flex items-center justify-center flex-shrink-0 font-semibold select-none",
    AVATAR_CLASSES[size],
    onClick && "cursor-pointer hover:bg-accent/25 transition-colors",
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} title={title}>
        {candidateInitials(name)}
      </button>
    );
  }

  return <div className={cls}>{candidateInitials(name)}</div>;
}

export interface CandidateIdentityBlockProps {
  name: string;
  headline?: string | null;
  /** Plain-text location — renders with MapPin icon. Ignored when locationNode is set. */
  location?: string | null;
  /** Custom location node — use this to pass <LocationFitPill> in job context. */
  locationNode?: ReactNode;
  phone?: string | null;
  linkedinUrl?: string | null;
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
  showPhone?: boolean;
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
  linkedinUrl,
  score,
  href,
  onAvatarClick,
  onNameClick,
  nameExtra,
  size = "md",
  showScore = true,
  showPhone = false,
  showLinkedIn = false,
  nameClassName,
  className,
}: CandidateIdentityBlockProps) {
  const tier = score != null ? scoreTier(score, "match") : null;
  const scoreColor = tier ? scoreTierColor(tier) : "";
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
      <Avatar name={name} size={size} onClick={onAvatarClick} title={onAvatarClick ? "View profile" : undefined} />

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
          {showScore && score != null && (
            <span className={cn("text-xs font-medium px-1.5 py-0.5 rounded-sm flex-shrink-0 data-mono", scoreColor)}>
              {score}%
            </span>
          )}
        </div>

        {/* Headline */}
        {headline && (
          <p className="text-xs text-text-secondary line-clamp-1 mt-0.5">{headline}</p>
        )}

        {/* Location + phone */}
        {(locationEl || (showPhone && phone)) && (
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
          </div>
        )}
      </div>
    </div>
  );
}
