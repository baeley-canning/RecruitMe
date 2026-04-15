import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: { db: { url: "file:./prisma/dev.db" } },
});

try {
  await prisma.$executeRawUnsafe("ALTER TABLE Candidate ADD COLUMN scoreBreakdown TEXT");
  console.log("Column added.");
} catch (e) {
  if (e.message.includes("duplicate column")) {
    console.log("Column already exists — nothing to do.");
  } else {
    console.error("Error:", e.message);
    process.exit(1);
  }
} finally {
  await prisma.$disconnect();
}
