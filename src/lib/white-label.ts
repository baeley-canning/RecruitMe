/**
 * White-label configuration — P6-1
 *
 * Orgs on Agency plan can customise:
 *   - logoUrl: URL of their logo (displayed in sidebar + reports)
 *   - brandName: shown instead of "RecruitMe" in the UI
 *   - primaryColour: hex colour override for accent colour
 *   - customDomain: custom domain (for link sharing, emails)
 *   - footerText: custom footer text on exported reports
 *
 * All settings are stored in the Setting table under keys:
 *   wl.{orgId}.logoUrl
 *   wl.{orgId}.brandName
 *   wl.{orgId}.primaryColour
 *   wl.{orgId}.customDomain
 *   wl.{orgId}.footerText
 *
 * Enforcement: white-label features require Agency plan.
 * checkFeatureAccess("hasWhiteLabel") is called before saving.
 */

import { prisma } from "./db";

export interface WhiteLabelConfig {
  logoUrl?:       string;
  brandName?:     string;
  primaryColour?: string; // hex, e.g. "#1D4ED8"
  customDomain?:  string;
  footerText?:    string;
}

const WL_FIELDS: Array<keyof WhiteLabelConfig> = [
  "logoUrl", "brandName", "primaryColour", "customDomain", "footerText",
];

export async function getWhiteLabelConfig(orgId: string): Promise<WhiteLabelConfig> {
  const keys = WL_FIELDS.map((f) => `wl.${orgId}.${f}`);
  const settings = await prisma.setting.findMany({ where: { key: { in: keys } } });

  const config: WhiteLabelConfig = {};
  for (const s of settings) {
    const field = s.key.replace(`wl.${orgId}.`, "") as keyof WhiteLabelConfig;
    if (WL_FIELDS.includes(field) && s.value) {
      (config as Record<string, string>)[field] = s.value;
    }
  }
  return config;
}

export async function saveWhiteLabelConfig(
  orgId: string,
  updates: Partial<WhiteLabelConfig>,
): Promise<void> {
  const upserts = Object.entries(updates)
    .filter(([field]) => WL_FIELDS.includes(field as keyof WhiteLabelConfig))
    .map(([field, value]) =>
      prisma.setting.upsert({
        where: { key: `wl.${orgId}.${field}` },
        create: { key: `wl.${orgId}.${field}`, value: value as string },
        update: { value: value as string },
      })
    );

  await Promise.all(upserts);
}

export async function clearWhiteLabelConfig(orgId: string): Promise<void> {
  const keys = WL_FIELDS.map((f) => `wl.${orgId}.${f}`);
  await prisma.setting.deleteMany({ where: { key: { in: keys } } });
}
