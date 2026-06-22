import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  await prisma.$executeRaw`ALTER TABLE "pdv"."PrintRequest" DISABLE ROW LEVEL SECURITY;`;
  console.log("RLS desativado na tabela PrintRequest.");
}
main().catch(console.error).finally(() => prisma.$disconnect());
