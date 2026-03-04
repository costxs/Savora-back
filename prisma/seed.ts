import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const restaurant = await prisma.restaurant.upsert({
        where: { slug: 'cantinhosabores' },
        update: {},
        create: {
            name: 'Cantinho dos Sabores',
            slug: 'cantinhosabores',
            users: {
                create: {
                    name: 'João',
                    username: 'joao123',
                    password: '123', // Em um cenário real, criptografaríamos aqui com bcrypt
                    role: 'ADMIN' // Usando uma role como exemplo, pode ajustar conforme necessário
                }
            }
        }
    });

    console.log('Seed completo:', restaurant);
}

main()
    .then(async () => {
        await prisma.$disconnect()
    })
    .catch(async (e) => {
        console.error(e)
        await prisma.$disconnect()
        process.exit(1)
    })
