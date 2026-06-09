import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const cashiers = await prisma.cashier.findMany({
        orderBy: { openedAt: 'desc' },
        take: 10
    });
    console.log('Cashiers:', JSON.stringify(cashiers, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());

