import { prisma } from "./db";

const ENV_KEYS: Record<string, string | undefined> = {
  PDL_API_KEY:     process.env.PDL_API_KEY,
  SERPAPI_API_KEY: process.env.SERPAPI_API_KEY,
  BING_API_KEY:    process.env.BING_API_KEY,
  APIFY_API_KEY:   process.env.APIFY_API_KEY,
};

/**
 * Get a setting value — env var takes priority over DB so .env.local always wins.
 */
export async function getServerSetting(key: string): Promise<string | null> {
  const fromEnv = ENV_KEYS[key]?.trim();
  if (fromEnv) return fromEnv;

  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    return row?.value?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Save a setting to the DB.
 */
export async function setServerSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}
