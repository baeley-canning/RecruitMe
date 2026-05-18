"use client";

import Link from "next/link";
import { MapPin, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { scoreTier, scoreTierColor } from "@/lib/score-utils";
import { LinkedInIcon } from "./icons";
import { displayableLinkedinUrl } from "./helpers";

function initials(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const AVATAR_CLASSES = {
  sm: "w-8 h-8 text-xs rounded-md",
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
  const className = cn(
    "bg-accent-subtle text-accent flex items-center justify-center flex-shrink-0 font-semibold select-none",
    AVATAR_CLASSES[size],
    onClick && "cursor-pointer hover:bg-accent/25 transition-colors",
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className} title={title}>
        {initials(name)}
      </button>
    );
  }

  return <div className={className}>{initials(name)}</div>;
}

export interface CandidateIdentityBlockProps {
  name: string;
  headline?: string | null;
  location?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  score?: number | null;
  href?: string;
  onAvatarClick?: () => void;
  size?: "sm" | "md" | "lg";
  showScore?: boolean;
  showPhone?: boolean;
  showLinkedIn?: boolean;
  /** Extra classes on the name element, e.g. "group-hover:text-accent transition-colors" */
  nameClassName?: string;
  className?: string;
}

export function CandidateIdentityBlock({
  name,
  headline,
  location,
  phone,
  linkedinUrl,
  score,
  href,
  onAvatarClick,
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

  const nameEl = href ? (
    <Link
      href={href}
      className={cn("font-semibold text-text-primary hover:text-accent transition-colors line-clamp-1", nameClassName)}
    >
      {name}
    </Link>
  ) : (
    <span className={cn("font-semibold text-text-primary line-clamp-1", nameClassName)}>{name}</span>
  );

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <Avatar name={name} size={size} onClick={onAvatarClick} title={onAvatarClick ? "View profile" : undefined} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            {nameEl}
            {showLinkedIn && displayUrl && (
              <a
                href={displayUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="text-text-tertiary hover:text-accent transition-colors flex-shrink-0"
                title="Open LinkedIn profile"
              >
                <LinkedInIcon className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
          {showScore && score != null && (
            <span
              className={cn(
                "text-xs font-medium px-1.5 py-0.5 rounded-sm flex-shrink-0 data-mono",
                scoreColor,
              )}
            >
              {score}%
            </span>
          )}
        </div>

        {headline && (
          <p className="text-xs text-text-secondary line-clamp-1 mt-0.5">{headline}</p>
        )}

        {(location || (showPhone && phone)) && (
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {location && (
              <span className="flex items-center gap-1 text-xs text-text-tertiary">
                <MapPin className="w-3 h-3 flex-shrink-0" />
                <span className="line-clamp-1">{location}</span>
              </span>
            )}
            {showPhone && phone && (
              <a
                href={`tel:${phone}`}
                onClick={(event) => event.stopPropagation()}
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
