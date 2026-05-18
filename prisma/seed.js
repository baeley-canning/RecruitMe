const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const username = (process.env.SEED_OWNER_USERNAME ?? "Cassius").trim();
  const password = process.env.SEED_OWNER_PASSWORD;
  const isProd = process.env.NODE_ENV === "production";

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`[seed] Owner account "${username}" already exists — skipping.`);
    return;
  }

  // No password set: hard-fail in prod (refuse to boot with a default), warn + skip in dev.
  // This is the security boundary — prior versions hardcoded the password into the repo,
  // which meant every production deploy shipped with a publicly-known admin account.
  if (!password || !password.trim()) {
    if (isProd) {
      console.error(
        "[seed] SEED_OWNER_PASSWORD is required in production to provision the owner account. " +
        "Set it on Railway and redeploy. Refusing to seed with a default."
      );
      process.exit(1);
    }
    console.warn(
      `[seed] No SEED_OWNER_PASSWORD set — skipping owner seed. ` +
      `To create the "${username}" owner locally, set SEED_OWNER_PASSWORD in .env.local and re-run.`
    );
    return;
  }

  const hashed = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: { username, password: hashed, role: "owner" },
  });
  console.log(`[seed] Created owner account "${username}".`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
