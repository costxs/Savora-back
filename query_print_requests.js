const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const reqs = await prisma.printRequest.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log('Last 10 print requests:', JSON.stringify(reqs, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
