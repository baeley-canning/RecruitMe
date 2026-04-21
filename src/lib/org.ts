import { prisma } from "./db";

export const DEFAULT_ORG_NAME = "Default";

export async function ensureDefaultOrg() {
  return prisma.org.upsert({
    where: { name: DEFAULT_ORG_NAME },
    update: {},
    create: { name: DEFAULT_ORG_NAME },
  });
}
