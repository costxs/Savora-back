import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: '*' }));
app.use(express.json());

const JWT_SECRET = "chave_secreta_super_segura_pdv"; // Em produção, vai no .env

// ROTA DE LOGIN
app.post('/login', async (req, res) => {
    const { restaurantSlug, username, password } = req.body;

    try {
        // 1. Acha o restaurante pelo "@" (slug)
        const restaurant = await prisma.restaurant.findUnique({
            where: { slug: restaurantSlug }
        });

        if (!restaurant) {
            return res.status(404).json({ error: 'Restaurante não encontrado. Verifique o @.' });
        }

        // 2. Acha o usuário dentro daquele restaurante
        const user = await prisma.user.findFirst({
            where: {
                restaurantId: restaurant.id,
                username: username,
                password: password // (Idealmente usar bcrypt aqui depois!)
            }
        });

        if (!user) {
            return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
        }

        // 3. Cria a "Chave do Apartamento" (Token JWT)
        const token = jwt.sign(
            { userId: user.id, role: user.role, restaurantId: restaurant.id },
            JWT_SECRET,
            { expiresIn: '12h' } // Token expira em 12 horas
        );

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                username: user.username,
                role: user.role,
                restaurantId: restaurant.id,
                restaurantName: restaurant.name
            }
        });

    } catch (error) {
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// --- ROTAS DO CAIXA ---

// 1. Pega o status atual (Se tem algum aberto)
app.get('/cashier/status', async (req, res) => {
    try {
        const cashier = await prisma.cashier.findFirst({
            where: { status: 'Aberto' },
            include: {
                orders: true // Traz os pedidos para somarmos (ou usa aggregate se preferir)
            }
        });

        if (!cashier) return res.json(null);

        // Soma apenas os pedidos que não foram cancelados
        // Se você tiver status 'PAGO', filtre por ele. Aqui somamos todos do caixa.
        const totalSales = cashier.orders.reduce((acc, order) => acc + order.total, 0);

        // Retorna o caixa + o total vendido calculado
        res.json({ ...cashier, totalSales });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar status' });
    }
});

// 2. Histórico de fechamentos (Apenas os fechados)
app.get('/cashier/history', async (req, res) => {
    const history = await prisma.cashier.findMany({
        where: { status: 'Fechado' },
        orderBy: { openedAt: 'desc' },
        take: 10 // Pega os últimos 10
    });
    res.json(history);
});

// 3. Abrir Caixa (Impede abrir se já tiver um aberto)
app.post('/cashier/open', async (req, res) => {
    const { initialVal, operator } = req.body;

    const alreadyOpen = await prisma.cashier.findFirst({ where: { status: 'Aberto' } });
    if (alreadyOpen) {
        return res.status(400).json({ error: 'Já existe um caixa aberto.' });
    }

    const newCashier = await prisma.cashier.create({
        data: {
            initialVal: parseFloat(initialVal),
            operator: operator || 'Caixa 01',
            status: 'Aberto'
        }
    });
    res.json(newCashier);
});

// 4. Fechar Caixa
app.post('/cashier/close', async (req, res) => {
    const { cashierId, finalVal } = req.body;

    const closedCashier = await prisma.cashier.update({
        where: { id: cashierId },
        data: {
            status: 'Fechado',
            closedAt: new Date(),
            finalVal: parseFloat(finalVal)
        }
    });
    res.json(closedCashier);
});

// 5. Listar Vendas do Caixa Atual (Abertas e Fechadas)
app.get('/cashier/active-sales', async (req, res) => {
    try {
        // 1. Pega o caixa aberto
        const openCashier = await prisma.cashier.findFirst({
            where: { status: 'Aberto' }
        });

        let whereCondition: any = {};

        if (openCashier) {
            // Se tem caixa aberto, mostra:
            // 1. Pedidos pendentes (mesas ocupadas)
            // 2. Pedidos vinculados a este caixa
            whereCondition = {
                OR: [
                    { status: 'PENDENTE' },
                    { cashierId: openCashier.id }
                ]
            };
        } else {
            // Se NÃO tem caixa aberto, mostra:
            // 1. Pedidos pendentes
            // 2. Pedidos criados nas últimas 24 horas (para ver o histórico recente mesmo com caixa fechado)
            const oneDayAgo = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
            whereCondition = {
                OR: [
                    { status: 'PENDENTE' },
                    { createdAt: { gte: oneDayAgo } }
                ]
            };
        }

        const sales = await prisma.order.findMany({
            where: whereCondition,
            include: {
                items: { include: { product: true } }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(sales);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao buscar vendas' });
    }
});

// --- ROTA: BUSCAR PEDIDOS ABERTOS (Para pintar as mesas) ---
app.get('/orders/open', async (req, res) => {
    const openOrders = await prisma.order.findMany({
        where: { status: 'PENDENTE' }, // Só mesas ocupadas
        include: { items: { include: { product: true } } } // Traz os itens da mesa
    });
    res.json(openOrders);
});

// --- ROTA: SALVAR/ATUALIZAR PEDIDO DA MESA ---
app.post('/orders', async (req, res) => {
    const { tableNum, items, total, clientName, waiterId } = req.body;

    try {
        // SEMPRE CRIA UM NOVO PEDIDO (Batch)
        // Isso permite que cada envio vá separado para a cozinha
        const order = await prisma.order.create({
            data: {
                tableNum: Number(tableNum),
                total: parseFloat(total),
                clientName: clientName || `Mesa ${tableNum}`,
                status: 'PENDENTE',
                kitchenStatus: 'PENDING', // Começa como pendente na cozinha
                waiterId: waiterId || null
            }
        });

        // 2. Insere os itens
        if (items && items.length > 0) {
            for (const item of items) {
                await prisma.orderItem.create({
                    data: {
                        quantity: item.quantity,
                        price: item.price,
                        productId: item.id,
                        orderId: order.id
                    }
                });
            }
        }

        res.json(order);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao salvar pedido' });
    }
});

// --- ROTA: FECHAR MESA (PAGAMENTO) ---
app.post('/orders/close', async (req, res) => {
    const { tableNum, paidCash, paidPix, paidCard, change } = req.body;

    try {
        // 1. Procura o Caixa que está ABERTO no momento
        const openCashier = await prisma.cashier.findFirst({
            where: { status: 'Aberto' }
        });

        // 2. Encontra TODOS os pedidos pendentes da mesa
        const orders = await prisma.order.findMany({
            where: { tableNum: Number(tableNum), status: 'PENDENTE' }
        });

        if (orders.length === 0) return res.status(400).json({ error: 'Nenhum pedido encontrado para esta mesa.' });

        // 3. Atualiza TODOS: Muda status, Vincula ao Caixa e Salva valores
        // Como temos múltiplos pedidos, vamos dividir o pagamento proporcionalmente ou jogar tudo no primeiro?
        // Vamos jogar os valores de pagamento no PRIMEIRO pedido e zerar os outros para não duplicar faturamento no relatório.
        // Ou melhor: criar um "Pedido de Fechamento"? Não, vamos marcar todos como CONCLUIDO.

        // Estratégia: Atualizar todos para CONCLUIDO.
        // O pagamento (paidCash, etc) será registrado apenas no ÚLTIMO pedido (ou primeiro), para não somar errado depois.

        const lastOrderId = orders[orders.length - 1].id;

        // Atualiza todos para CONCLUIDO e vincula ao caixa
        await prisma.order.updateMany({
            where: { tableNum: Number(tableNum), status: 'PENDENTE' },
            data: {
                status: 'CONCLUIDO',
                cashierId: openCashier ? openCashier.id : null,
                kitchenStatus: 'DELIVERED' // Se fechou a mesa, assume que entregou tudo? Ou deixa como está? Vamos forçar entregue.
            }
        });

        // Atualiza apenas o último com os valores do pagamento (para o relatório financeiro bater)
        const updatedOrder = await prisma.order.update({
            where: { id: lastOrderId },
            data: {
                paidCash: parseFloat(paidCash || 0),
                paidPix: parseFloat(paidPix || 0),
                paidCard: parseFloat(paidCard || 0),
                change: parseFloat(change || 0)
            }
        });

        res.json(updatedOrder);

    } catch (error) {
        console.error("Erro ao fechar mesa:", error);
        res.status(500).json({ error: 'Erro interno ao fechar mesa' });
    }
});

// --- ROTAS DE GERENCIAMENTO DE PRODUTOS ---

// 1. LISTAR PRODUTOS
app.get('/products', async (req, res) => {
    try {
        const products = await prisma.product.findMany({
            include: { category: true }
        });
        res.json(products);
    } catch (error) {
        console.error("Erro ao buscar produtos:", error);
        res.status(500).json({ error: 'Erro ao buscar produtos', details: String(error) });
    }
});

// 2. CADASTRAR PRODUTO
app.post('/products', async (req, res) => {
    const { name, price, cost, code, categoryId } = req.body;

    try {
        const product = await prisma.product.create({
            data: {
                name,
                price: parseFloat(price),
                cost: parseFloat(cost || 0),
                code: code || '',
                categoryId: Number(categoryId)
            }
        });
        res.json(product);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao cadastrar produto' });
    }
});

// 2. DELETAR PRODUTO
app.delete('/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.product.delete({ where: { id: Number(id) } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao deletar produto' });
    }
});

// --- ROTAS DE CATEGORIAS ---

app.get('/categories', async (req, res) => {
    const categories = await prisma.category.findMany({ include: { _count: { select: { products: true } } } });
    res.json(categories);
});

app.post('/categories', async (req, res) => {
    const { name, kitchen } = req.body;
    try {
        const category = await prisma.category.create({
            data: { name, kitchen }
        });
        res.json(category);
    } catch (error) {
        console.error("Erro ao criar categoria:", error);
        res.status(500).json({ error: 'Erro ao criar categoria. Verifique o console do servidor.' });
    }
});

app.delete('/categories/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.category.delete({ where: { id: Number(id) } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao deletar categoria' });
    }
});

// --- ROTAS DA COZINHA (KDS) ---

// 1. Listar pedidos da cozinha (Não entregues)
app.get('/kitchen/orders', async (req, res) => {
    try {
        const orders = await prisma.order.findMany({
            where: {
                kitchenStatus: { not: 'DELIVERED' }, // Traz tudo que não foi entregue
                status: { not: 'Cancelado' } // Ignora cancelados
            },
            include: {
                items: { include: { product: true } }
            },
            orderBy: { createdAt: 'asc' }
        });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar pedidos da cozinha' });
    }
});

// 2. Atualizar status da cozinha
app.patch('/kitchen/orders/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // PENDING, PREPARING, READY, DELIVERED

    try {
        const order = await prisma.order.update({
            where: { id: Number(id) },
            data: { kitchenStatus: status }
        });
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar status do pedido' });
    }
});

// --- ROTAS FINANCEIRAS (DASHBOARD) ---

// 1. KPI (Receita, Despesas, Lucro)
app.get('/financial/kpi', async (req, res) => {
    try {
        // Receita: Soma de todos os pedidos finalizados (ou pagos)
        const orders = await prisma.order.findMany({
            where: { status: 'CONCLUIDO' }
        });
        const revenue = orders.reduce((acc, order) => acc + (order.total || 0), 0);

        // Despesas: Soma de todas as despesas
        const expensesData = await prisma.expense.findMany();
        const expenses = expensesData.reduce((acc, exp) => acc + exp.amount, 0);

        // Lucro
        const profit = revenue - expenses;

        // Margem
        const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(2) : 0;

        res.json({ revenue, expenses, profit, margin });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao calcular KPIs' });
    }
});

// 2. Evolução Mensal (Últimos 6 meses)
app.get('/financial/evolution', async (req, res) => {
    try {
        const today = new Date();
        const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 5, 1);

        const orders = await prisma.order.findMany({
            where: {
                status: 'CONCLUIDO',
                createdAt: { gte: sixMonthsAgo }
            }
        });

        const expenses = await prisma.expense.findMany({
            where: {
                createdAt: { gte: sixMonthsAgo } // Ou dueDate? Vamos usar createdAt por enquanto
            }
        });

        // Agrupar por mês
        const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
        const result = [];

        for (let i = 0; i < 6; i++) {
            const d = new Date(today.getFullYear(), today.getMonth() - 5 + i, 1);
            const monthName = months[d.getMonth()];

            // Filtra pedidos do mês
            const monthOrders = orders.filter(o =>
                o.createdAt.getMonth() === d.getMonth() && o.createdAt.getFullYear() === d.getFullYear()
            );
            const receita = monthOrders.reduce((acc, o) => acc + o.total, 0);

            // Filtra despesas do mês
            const monthExpenses = expenses.filter(e =>
                e.createdAt.getMonth() === d.getMonth() && e.createdAt.getFullYear() === d.getFullYear()
            );
            const despesas = monthExpenses.reduce((acc, e) => acc + e.amount, 0);

            result.push({
                name: monthName,
                receita,
                despesas,
                lucro: receita - despesas
            });
        }

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao calcular evolução' });
    }
});

// 3. DRE (Demonstração do Resultado)
app.get('/financial/dre', async (req, res) => {
    try {
        // Simplificado: Pega TUDO (ideal seria filtrar por período, ex: este mês)
        const orders = await prisma.order.findMany({ where: { status: 'CONCLUIDO' }, include: { items: { include: { product: true } } } });
        const expenses = await prisma.expense.findMany();

        const receitaBruta = orders.reduce((acc, o) => acc + o.total, 0);
        const deducoes = receitaBruta * 0.06; // Simulação: 6% de imposto
        const receitaLiquida = receitaBruta - deducoes;

        // CMV (Custo da Mercadoria Vendida)
        let cmv = 0;
        orders.forEach(order => {
            order.items.forEach(item => {
                // Se tiver custo cadastrado no produto, usa. Senão estima 30% do preço.
                const custoItem = item.product.cost > 0 ? item.product.cost : (item.price * 0.3);
                cmv += custoItem * item.quantity;
            });
        });

        const lucroBruto = receitaLiquida - cmv;

        const despesasOperacionais = expenses.filter(e => e.category === 'OPERATIONAL').reduce((acc, e) => acc + e.amount, 0);
        const despesasFinanceiras = expenses.filter(e => e.category === 'FINANCIAL').reduce((acc, e) => acc + e.amount, 0);

        // Outras despesas não categorizadas
        const outrasDespesas = expenses.filter(e => e.category !== 'OPERATIONAL' && e.category !== 'FINANCIAL').reduce((acc, e) => acc + e.amount, 0);

        const totalDespesas = despesasOperacionais + despesasFinanceiras + outrasDespesas;
        const lucroLiquido = lucroBruto - totalDespesas;

        const dre = [
            { label: 'Receita Bruta', value: receitaBruta, type: 'positive', bold: true },
            { label: '(-) Deduções / Impostos (Est. 6%)', value: -deducoes, type: 'negative' },
            { label: '= Receita Líquida', value: receitaLiquida, type: 'result', bold: true },
            { label: '(-) CMV (Custo Mercadoria)', value: -cmv, type: 'negative' },
            { label: '= Lucro Bruto', value: lucroBruto, type: 'result', bold: true },
            { label: '(-) Despesas Operacionais', value: -despesasOperacionais, type: 'negative' },
            { label: '(-) Despesas Financeiras', value: -despesasFinanceiras, type: 'negative' },
            { label: '= Lucro Líquido', value: lucroLiquido, type: 'final', bold: true },
        ];

        res.json(dre);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao calcular DRE' });
    }
});

// 4. Contas a Pagar (Listar)
app.get('/financial/payables', async (req, res) => {
    try {
        const expenses = await prisma.expense.findMany({
            orderBy: { dueDate: 'asc' }
        });
        res.json(expenses);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar contas' });
    }
});

// 5. Adicionar Conta a Pagar
app.post('/financial/payables', async (req, res) => {
    const { description, amount, dueDate, category } = req.body;
    try {
        const expense = await prisma.expense.create({
            data: {
                description,
                amount: parseFloat(amount),
                dueDate: new Date(dueDate),
                category: category || 'OPERATIONAL',
                status: 'PENDING'
            }
        });
        res.json(expense);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar despesa' });
    }
});

// --- ROTAS: GERENCIAMENTO DE USUÁRIOS ---

// ROTA: LISTAR USUÁRIOS DO RESTAURANTE
app.get('/users/:restaurantId', async (req, res) => {
    const { restaurantId } = req.params;
    try {
        const users = await prisma.user.findMany({
            where: { restaurantId: Number(restaurantId) },
            select: { id: true, name: true, username: true, role: true } // Oculta a senha
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar usuários' });
    }
});

// ROTA: CRIAR NOVO USUÁRIO
app.post('/users', async (req, res) => {
    const { name, username, password, role, restaurantId } = req.body;

    try {
        const existingUser = await prisma.user.findFirst({
            where: { username, restaurantId: Number(restaurantId) }
        });

        if (existingUser) {
            return res.status(400).json({ error: 'Nome de usuário já existe neste restaurante.' });
        }

        const user = await prisma.user.create({
            data: {
                name,
                username,
                password, // Em produção, utilize bcrypt para hashear a senha
                role,
                restaurantId: Number(restaurantId)
            }
        });

        res.json({ success: true, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao cadastrar usuário' });
    }
});

// --- ROTA: CRIAR RESTAURANTE (Registro Inicial) ---
app.post('/restaurants', async (req, res) => {
    const { restaurantName, restaurantSlug, ownerName, username, password } = req.body;

    try {
        // 1. Verifica se o slug já existe
        const existingRestaurant = await prisma.restaurant.findUnique({
            where: { slug: restaurantSlug }
        });

        if (existingRestaurant) {
            return res.status(400).json({ error: 'Este @ já está em uso por outro restaurante.' });
        }

        // 2. Cria o restaurante e o usuário ADMIN na mesma transação
        const newRestaurant = await prisma.$transaction(async (tx) => {
            const restaurant = await tx.restaurant.create({
                data: {
                    name: restaurantName,
                    slug: restaurantSlug
                }
            });

            const user = await tx.user.create({
                data: {
                    name: ownerName,
                    username: username,
                    password: password, // Em produção, usar bcrypt
                    role: 'ADMIN',
                    restaurantId: restaurant.id
                }
            });

            return { restaurant, user };
        });

        res.json({ success: true, message: 'Restaurante criado com sucesso!', data: newRestaurant });
    } catch (error) {
        console.error("Erro ao criar restaurante:", error);
        res.status(500).json({ error: 'Erro ao criar restaurante.' });
    }
});

app.listen(3001, () => {
    console.log('✅ Servidor PDV rodando na porta 3001');
});
