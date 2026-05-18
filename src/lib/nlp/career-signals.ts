/**
 * Career signal extractor — pure deterministic, no AI, no DB.
 *
 * Wraps archetype/fingerprint.ts and adds:
 *   - Education credential detection
 *   - Employment gap analysis
 *   - Leadership/management signal detection
 *   - Certifications detection
 *
 * Intended as the input layer for the AI router's local scoring path.
 */

import { computeFingerprint, type FingerprintData } from "@/lib/archetype/fingerprint";

// ── Education ─────────────────────────────────────────────────────────────────

export type DegreeLevel =
  | "phd"
  | "masters"
  | "honours"
  | "bachelors"
  | "diploma"
  | "bootcamp"
  | "none_detected";

const DEGREE_PATTERNS: Array<[RegExp, DegreeLevel]> = [
  [/\b(?:ph\.?d|doctor(?:ate|al)|d\.?phil)\b/i, "phd"],
  [/\b(?:master(?:s)?|m\.?sc|m\.?eng|m\.?b\.?a|m\.?comp|m\.?inf|mba)\b/i, "masters"],
  [/\b(?:honours?|hons?|b\.?hons?)\b/i, "honours"],
  [/\b(?:bachelor(?:s)?|b\.?sc|b\.?eng|b\.?inf|b\.?comp|b\.?bus|b\.?tech|undergraduate|degree)\b/i, "bachelors"],
  [/\b(?:diploma|post-?grad(?:uate)?|grad\s+cert(?:ificate)?|certificate)\b/i, "diploma"],
  [/\b(?:bootcamp|boot\s+camp|coding\s+school|dev\s+academy|enspiral|yoobee|weltec|whitecliffe)\b/i, "bootcamp"],
];

function detectDegree(text: string): DegreeLevel {
  for (const [re, level] of DEGREE_PATTERNS) {
    if (re.test(text)) return level;
  }
  return "none_detected";
}

// ── Certifications ────────────────────────────────────────────────────────────

const CERT_PATTERNS: [RegExp, string][] = [
  [/\baws\s+(?:certified|solutions\s+architect|developer|sysops|devops|cloud\s+practitioner)\b/i, "AWS Certified"],
  [/\bazure\s+(?:administrator|developer|architect|fundamentals|az-\d+)\b/i, "Azure Certified"],
  [/\bgcp\s+(?:associate|professional|cloud\s+engineer)\b/i, "GCP Certified"],
  [/\bkubernetes\s+(?:ckad|cka|ckss?)\b|cka[ds]?\b/i, "Kubernetes Certified"],
  [/\bpmp\b|\bproject\s+management\s+professional\b/i, "PMP"],
  [/\bscrum\s+master\b|\bcsm\b|\bpsm\b/i, "Scrum Master"],
  [/\bsafe\s+(?:agilist|practitioner|architect)\b|\bscaled\s+agile\b/i, "SAFe Certified"],
  [/\biso\s*27001\s+(?:lead\s+)?(?:auditor|implementer)\b/i, "ISO 27001 Lead"],
  [/\bcissp\b|\bcism\b|\bceh\b|\bocsp\b/i, "Security Certification"],
  [/\bitil\s+(?:v3|v4|foundation|practitioner|expert)\b/i, "ITIL"],
  [/\bsalesforce\s+(?:certified|administrator|developer|architect)\b|\bsfdc\b/i, "Salesforce Certified"],
];

function detectCertifications(text: string): string[] {
  const found: string[] = [];
  for (const [re, label] of CERT_PATTERNS) {
    if (re.test(text)) found.push(label);
  }
  return found;
}

// ── Leadership / management ───────────────────────────────────────────────────

const LEADERSHIP_RE = /\b(?:managed|managing|led|leading|mentored|mentoring|coached|coaching|supervised|supervising|team\s+(?:lead|leader|management)|line\s+manager|people\s+manager|reports?\s+to\s+(?:me|director|cto)|direct\s+reports?)\b/i;
const TEAM_SIZE_RE  = /\bteam\s+of\s+(\d+)\b|\b(\d+)\s+(?:direct\s+)?reports?\b|\bmanaged\s+(?:a\s+)?(?:team\s+of\s+)?(\d+)\b/i;

function detectLeadership(text: string): {
  hasLeadership: boolean;
  maxTeamSize: number | null;
} {
  if (!LEADERSHIP_RE.test(text)) {
    return { hasLeadership: false, maxTeamSize: null };
  }
  let maxTeamSize: number | null = null;
  let m: RegExpExecArray | null;
  const re = new RegExp(TEAM_SIZE_RE.source, "gi");
  while ((m = re.exec(text)) !== null) {
    const size = parseInt(m[1] ?? m[2] ?? m[3] ?? "0", 10);
    if (size > 0 && (maxTeamSize === null || size > maxTeamSize)) {
      maxTeamSize = size;
    }
  }
  return { hasLeadership: true, maxTeamSize };
}

// ── Combined career signals ───────────────────────────────────────────────────

export interface CareerSignals {
  fingerprint: FingerprintData;
  degreeLevel: DegreeLevel;
  certifications: string[];
  hasLeadership: boolean;
  maxTeamSize: number | null;
}

export function extractCareerSignals(profileText: string): CareerSignals {
  const fingerprint = computeFingerprint(profileText);
  const degreeLevel = detectDegree(profileText);
  const certifications = detectCertifications(profileText);
  const { hasLeadership, maxTeamSize } = detectLeadership(profileText);

  return {
    fingerprint,
    degreeLevel,
    certifications,
    hasLeadership,
    maxTeamSize,
  };
}
