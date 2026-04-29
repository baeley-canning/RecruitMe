import type { ParsedRole } from "./ai";

const EXPLICIT_CLEARANCE_RE =
  /\b(security clearance|national security clearance|baseline clearance|confidential clearance|secret clearance|top secret clearance|top\s+secret\s+special|ts\/sci|nzsis vetting|security vetting|must be cleared|ability to obtain clearance|eligible for clearance)\b/i;

const SENSITIVE_ORG_RE =
  /\b(new zealand customs|customs service|nz customs|nzdf|new zealand defence force|ministry of defence|defence|nzsis|gcsb|police|corrections|justice|border|immigration new zealand|aviation security|maritime new zealand|civil aviation authority)\b/i;

const SENSITIVE_TITLE_RE =
  /\b(security|cyber|border|intelligence|protection|customs|defence|defense|national security|identity|fraud|risk|compliance|enforcement)\b/i;

const CLEARANCE_REQUIREMENT =
  "Security clearance eligibility or existing clearance relevant to sensitive government systems";

const CLEARANCE_NICE_TO_HAVE =
  "Evidence of prior clearance-sensitive government, defence, border, justice, police, or security work";

function hasSimilarRequirement(items: string[], needle: string) {
  const key = needle.toLowerCase().slice(0, 32);
  return items.some((item) => item.toLowerCase().includes(key) || EXPLICIT_CLEARANCE_RE.test(item));
}

export function inferSecurityClearanceContext(input: {
  jd?: string;
  title?: string | null;
  company?: string | null;
  responsibilities?: string[];
  explicitlyStated?: string[];
  stronglyInferred?: string[];
}) {
  const combined = [
    input.jd,
    input.title,
    input.company,
    ...(input.responsibilities ?? []),
    ...(input.explicitlyStated ?? []),
    ...(input.stronglyInferred ?? []),
  ]
    .filter(Boolean)
    .join("\n");

  const explicit = EXPLICIT_CLEARANCE_RE.test(combined);
  const sensitiveOrg = SENSITIVE_ORG_RE.test(combined);
  const sensitiveTitle = SENSITIVE_TITLE_RE.test(combined);

  return {
    explicit,
    inferred: !explicit && sensitiveOrg && sensitiveTitle,
    sensitiveOrg,
    sensitiveTitle,
  };
}

export function enrichRoleWithSecurityClearance(jd: string, parsedRole: ParsedRole): ParsedRole {
  const context = inferSecurityClearanceContext({
    jd,
    title: parsedRole.title,
    company: parsedRole.company,
    responsibilities: parsedRole.responsibilities,
    explicitlyStated: parsedRole.explicitly_stated,
    stronglyInferred: parsedRole.strongly_inferred,
  });

  const next: ParsedRole = {
    ...parsedRole,
    must_haves: [...parsedRole.must_haves],
    nice_to_haves: [...parsedRole.nice_to_haves],
    knockout_criteria: [...parsedRole.knockout_criteria],
    strongly_inferred: [...parsedRole.strongly_inferred],
    search_expansion: [...parsedRole.search_expansion],
  };

  if (context.explicit) {
    if (!hasSimilarRequirement(next.knockout_criteria, CLEARANCE_REQUIREMENT)) {
      next.knockout_criteria.push(CLEARANCE_REQUIREMENT);
    }
    if (!hasSimilarRequirement(next.must_haves, CLEARANCE_REQUIREMENT)) {
      next.must_haves.push(CLEARANCE_REQUIREMENT);
    }
    return next;
  }

  if (context.inferred) {
    if (!next.strongly_inferred.some((item) => /clearance|security vetting/i.test(item))) {
      next.strongly_inferred.push(
        "Clearance-sensitive government context inferred from the organisation and role domain; verify clearance eligibility during screening."
      );
    }
    if (!hasSimilarRequirement(next.nice_to_haves, CLEARANCE_NICE_TO_HAVE)) {
      next.nice_to_haves.push(CLEARANCE_NICE_TO_HAVE);
    }
    if (!next.search_expansion.some((item) => /clearance|government|defence|border/i.test(item))) {
      next.search_expansion.push("Prior NZ government, defence, border, justice, police, or security-cleared delivery experience");
    }
  }

  return next;
}

