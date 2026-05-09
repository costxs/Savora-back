import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const pendingOrders = await prisma.order.findMany({
        where: { status: 'PENDENTE' },
        include: { items: true }
    });
    console.log('Pending Orders Count:', pendingOrders.length);
    console.log('Orders:', JSON.stringify(pendingOrders, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
