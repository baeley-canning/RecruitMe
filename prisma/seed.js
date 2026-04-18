const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.user.findUnique({ where: { username: "Cassius" } });
  if (existing) {
    console.log("Owner account already exists — skipping.");
    return;
  }
  const hashed = await bcrypt.hash("Cassius", 12);
  await prisma.user.create({ data: { username: "Cassius", password: hashed, role: "owner" } });
  console.log("Created owner account: Cassius");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
