const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.order.findMany({
    where: { tableNum: 3 },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log('Orders for Table 3:', JSON.stringify(orders, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
