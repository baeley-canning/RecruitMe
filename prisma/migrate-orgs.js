const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  // Create Default org if it doesn't exist
  const defaultOrg = await prisma.org.upsert({
    where: { name: "Default" },
    update: {},
    create: { name: "Default" },
  });
  console.log("Default org id:", defaultOrg.id);

  // Assign all existing jobs without an org to the Default org
  const result = await prisma.job.updateMany({
    where: { orgId: null },
    data: { orgId: defaultOrg.id },
  });
  console.log("Assigned", result.count, "existing jobs to Default org");

  const users = await prisma.user.updateMany({
    where: {
      orgId: null,
      role: { not: "owner" },
    },
    data: { orgId: defaultOrg.id },
  });
  console.log("Assigned", users.count, "existing users to Default org");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
