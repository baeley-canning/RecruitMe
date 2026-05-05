import type { ParsedRole } from "./ai";
import { isRemoteFriendlyLocationRule } from "./location";

export interface JobBriefUploadPrefill {
  title: string;
  company: string;
  location: string;
  isRemote: boolean;
  salaryEnabled: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function parseAmount(raw: string, unit?: string | null, fallbackUnit?: string | null): number | null {
  const numeric = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const resolvedUnit = (unit ?? fallbackUnit ?? "").toLowerCase();
  if (resolvedUnit === "m") return Math.round(numeric * 1_000_000);
  if (resolvedUnit === "k") return Math.round(numeric * 1_000);
  if (numeric < 1_000) return Math.round(numeric * 1_000);
  return Math.round(numeric);
}

export function parseSalaryBandRange(salaryBand: string): { min: number | null; max: number | null } {
  const normalized = cleanText(salaryBand)
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ");

  if (!normalized) return { min: null, max: null };

  const rangeMatch = normalized.match(/\$?\s*([\d,.]+)\s*(k|m)?\s*(?:-|to)\s*\$?\s*([\d,.]+)\s*(k|m)?/i);
  if (rangeMatch) {
    const firstUnit = rangeMatch[2] ?? rangeMatch[4] ?? null;
    const secondUnit = rangeMatch[4] ?? rangeMatch[2] ?? null;
    return {
      min: parseAmount(rangeMatch[1], firstUnit, secondUnit),
      max: parseAmount(rangeMatch[3], secondUnit, firstUnit),
    };
  }

  const fromMatch = normalized.match(/\b(?:from|starting at|min(?:imum)?|base)\s+\$?\s*([\d,.]+)\s*(k|m)?/i);
  if (fromMatch) {
    return { min: parseAmount(fromMatch[1], fromMatch[2]), max: null };
  }

  const upToMatch = normalized.match(/\b(?:up to|max(?:imum)?|capped at)\s+\$?\s*([\d,.]+)\s*(k|m)?/i);
  if (upToMatch) {
    return { min: null, max: parseAmount(upToMatch[1], upToMatch[2]) };
  }

  const plusMatch = normalized.match(/\$?\s*([\d,.]+)\s*(k|m)?\s*\+/i);
  if (plusMatch) {
    return { min: parseAmount(plusMatch[1], plusMatch[2]), max: null };
  }

  return { min: null, max: null };
}

export function inferRemoteRole(locationRules: string): boolean {
  return isRemoteFriendlyLocationRule(locationRules);
}

export function deriveJobBriefUploadPrefill(
  parsedRole: Partial<ParsedRole> | null | undefined
): JobBriefUploadPrefill | null {
  if (!parsedRole) return null;

  const title = cleanText(parsedRole.title);
  const company = cleanText(parsedRole.company);
  const location = cleanText(parsedRole.location);
  const isRemote = inferRemoteRole(parsedRole.location_rules ?? "");
  const salaryRange = parseSalaryBandRange(parsedRole.salary_band ?? "");
  const hasFullSalaryRange = Boolean(salaryRange.min && salaryRange.max);

  const prefill: JobBriefUploadPrefill = {
    title,
    company,
    location,
    isRemote,
    salaryEnabled: hasFullSalaryRange,
    salaryMin: hasFullSalaryRange ? salaryRange.min : null,
    salaryMax: hasFullSalaryRange ? salaryRange.max : null,
  };

  if (
    !prefill.title &&
    !prefill.company &&
    !prefill.location &&
    !prefill.isRemote &&
    !prefill.salaryEnabled
  ) {
    return null;
  }

  return prefill;
}
