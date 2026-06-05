import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: '*' }));
app.use(express.json());

// Log de requisições para debug
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

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
        console.error("ERRO NO LOGIN:", error);
        res.status(500).json({ error: 'Erro no servidor', details: String(error) });
    }
});

// --- ROTAS DO CAIXA ---

// 1. Pega o status atual (Se tem algum aberto)
app.get('/cashier/status', async (req, res) => {
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const cashier = await prisma.cashier.findFirst({
            where: { status: 'Aberto', ...(rid ? { restaurantId: rid } : {}) },
            include: { orders: true }
        });

        if (!cashier) return res.json(null);

        let orders = cashier.orders;

        // Filtro por Jornada (Opcional)
        const { start, end } = req.query;
        if (start && end) {
            orders = orders.filter(o => {
                const time = o.createdAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
                const [h, m] = time.split(':').map(Number);
                const [sh, sm] = (start as string).split(':').map(Number);
                const [eh, em] = (end as string).split(':').map(Number);

                const orderMins = h * 60 + m;
                const startMins = sh * 60 + sm;
                const endMins = eh * 60 + em;

                if (startMins <= endMins) {
                    return orderMins >= startMins && orderMins <= endMins;
                } else {
                    return orderMins >= startMins || orderMins <= endMins;
                }
            });
        }

        const totalSales = orders.reduce((acc, order) => acc + order.total, 0);
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
    const { initialVal, operator, restaurantId } = req.body;
    const rid = restaurantId ? Number(restaurantId) : undefined;

    const alreadyOpen = await prisma.cashier.findFirst({ where: { status: 'Aberto', ...(rid ? { restaurantId: rid } : {}) } });
    if (alreadyOpen) {
        return res.status(400).json({ error: 'Já existe um caixa aberto.' });
    }

    const newCashier = await prisma.cashier.create({
        data: {
            initialVal: parseFloat(initialVal),
            operator: operator || 'Caixa 01',
            status: 'Aberto',
            ...(rid ? { restaurantId: rid } : {})
        }
    });
    res.json(newCashier);
});

// 4. Fechar Caixa
app.post('/cashier/close', async (req, res) => {
    const { cashierId, finalVal, finalCash, finalPix, finalCard } = req.body;

    const closedCashier = await prisma.cashier.update({
        where: { id: cashierId },
        data: {
            status: 'Fechado',
            closedAt: new Date(),
            finalVal: parseFloat(finalVal),
            finalCash: parseFloat(finalCash || 0),
            finalPix: parseFloat(finalPix || 0),
            finalCard: parseFloat(finalCard || 0)
        }
    });
    res.json(closedCashier);
});

// 4.1 Pegar Relatório Detalhado do Caixa
app.get('/cashier/:id/report', async (req, res) => {
    const { id } = req.params;
    try {
        const cashier = await prisma.cashier.findUnique({
            where: { id: Number(id) },
            include: { orders: true }
        });

        if (!cashier) return res.status(404).json({ error: 'Caixa não encontrado' });

        const systemData = cashier.orders.reduce((acc, o) => {
            acc.totalSales += o.total;
            acc.totalTips += o.tip;
            acc.expectedCash += (o.paidCash - o.change);
            acc.expectedPix += o.paidPix;
            acc.expectedCard += o.paidCard;
            return acc;
        }, { totalSales: 0, totalTips: 0, expectedCash: 0, expectedPix: 0, expectedCard: 0 });

        // Adiciona fundo inicial ao dinheiro esperado
        systemData.expectedCash += cashier.initialVal;

        res.json({
            cashier,
            system: systemData
        });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar relatório' });
    }
});

// 5. Buscar gorjetas do Caixa Atual
app.get('/cashier/tips', async (req, res) => {
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const openCashier = await prisma.cashier.findFirst({
            where: { status: 'Aberto', ...(rid ? { restaurantId: rid } : {}) }
        });

        if (!openCashier) {
            return res.json({ total: 0, byWaiter: [] });
        }

        // Busca todas as ordens finalizadas neste caixa que tenham gorjeta > 0
        let orders = await prisma.order.findMany({
            where: {
                cashierId: openCashier.id,
                status: 'CONCLUIDO',
                tip: { gt: 0 }
            }
        });

        // Filtro por Jornada (Opcional)
        const { start, end } = req.query;
        if (start && end) {
            orders = orders.filter(o => {
                const time = o.createdAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
                const [h, m] = time.split(':').map(Number);
                const [sh, sm] = (start as string).split(':').map(Number);
                const [eh, em] = (end as string).split(':').map(Number);

                const orderMins = h * 60 + m;
                const startMins = sh * 60 + sm;
                const endMins = eh * 60 + em;

                if (startMins <= endMins) {
                    return orderMins >= startMins && orderMins <= endMins;
                } else {
                    // Turno da noite (atravessa meia noite)
                    return orderMins >= startMins || orderMins <= endMins;
                }
            });
        }

        let total = 0;
        const tipsMap: Record<string, number> = {};

        // Agrupa por waiterId
        orders.forEach(order => {
            total += order.tip;
            const wId = order.waiterId || 'sem_garcom';
            tipsMap[wId] = (tipsMap[wId] || 0) + order.tip;
        });

        // Busca os nomes dos garçons
        const byWaiter = [];
        const waiterIds = Object.keys(tipsMap).filter(id => id !== 'sem_garcom').map(Number);
        
        const users = await prisma.user.findMany({
            where: { id: { in: waiterIds } },
            select: { id: true, name: true }
        });
        const usersMap = Object.fromEntries(users.map(u => [u.id, u.name]));

        for (const [wId, amount] of Object.entries(tipsMap)) {
            let name = "Não identificado";
            if (wId === 'sem_garcom') {
                name = "Sem garçom";
            } else {
                name = usersMap[Number(wId)] || "Não identificado";
            }
            byWaiter.push({ waiterId: wId, name, amount });
        }

        // Ordena por maior valor
        byWaiter.sort((a, b) => b.amount - a.amount);

        res.json({ total, byWaiter });
    } catch (e) {
        console.error("Erro ao buscar gorjetas:", e);
        res.status(500).json({ error: 'Erro ao buscar gorjetas' });
    }
});

// 6. Listar Vendas do Caixa Atual (Abertas e Fechadas)
app.get('/cashier/active-sales', async (req, res) => {
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const openCashier = await prisma.cashier.findFirst({
            where: { status: 'Aberto', ...(rid ? { restaurantId: rid } : {}) }
        });

        let whereCondition: any = rid ? { restaurantId: rid } : {};

        if (openCashier) {
            whereCondition = {
                ...whereCondition,
                OR: [
                    { status: 'PENDENTE' },
                    { cashierId: openCashier.id }
                ]
            };
        } else {
            const oneDayAgo = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
            whereCondition = {
                ...whereCondition,
                OR: [
                    { status: 'PENDENTE' },
                    { createdAt: { gte: oneDayAgo } }
                ]
            };
        }

        const sales = await prisma.order.findMany({
            where: whereCondition,
            include: { items: { include: { product: true } } },
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
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    const openOrders = await prisma.order.findMany({
        where: rid
            ? { status: 'PENDENTE', OR: [{ restaurantId: rid }, { restaurantId: null }] }
            : { status: 'PENDENTE' },
        include: { items: { include: { product: true } } }
    });
    // Filter in-memory para remover pedidos de OUTROS restaurantes (que tenham rid != null)
    const filtered = rid
        ? openOrders.filter(o => o.restaurantId === null || o.restaurantId === rid)
        : openOrders;
    res.json(filtered);
});

// --- ROTA: MIGRAR DADOS LEGADOS (Atribuir restaurantId aos registros antigos) ---
app.post('/admin/migrate-restaurant-data', async (req, res) => {
    const { restaurantId } = req.body;
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId obrigatório' });
    const rid = Number(restaurantId);

    try {
        // Atribui restaurantId aos registros que ainda não têm
        const [orders, cashiers, products, categories, payments] = await Promise.all([
            prisma.order.updateMany({ where: { restaurantId: null }, data: { restaurantId: rid } }),
            prisma.cashier.updateMany({ where: { restaurantId: null }, data: { restaurantId: rid } }),
            prisma.product.updateMany({ where: { restaurantId: null }, data: { restaurantId: rid } }),
            prisma.category.updateMany({ where: { restaurantId: null }, data: { restaurantId: rid } }),
            prisma.paymentMethod.updateMany({ where: { restaurantId: null }, data: { restaurantId: rid } }),
        ]);
        res.json({ success: true, updated: { orders: orders.count, cashiers: cashiers.count, products: products.count, categories: categories.count, payments: payments.count } });
    } catch (error) {
        console.error('Erro na migração:', error);
        res.status(500).json({ error: 'Erro ao migrar dados' });
    }
});

// --- ROTA: SALVAR/ATUALIZAR PEDIDO DA MESA ---
app.post('/orders', async (req, res) => {
    const { tableNum, items, total, clientName, waiterId, restaurantId } = req.body;
    const rid = restaurantId ? Number(restaurantId) : undefined;

    try {
        const order = await prisma.order.create({
            data: {
                tableNum: Number(tableNum),
                total: parseFloat(total),
                clientName: clientName || `Mesa ${tableNum}`,
                status: 'PENDENTE',
                kitchenStatus: 'PENDING',
                waiterId: waiterId ? String(waiterId) : null,
                ...(rid ? { restaurantId: rid } : {})
            }
        });

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

        // --- AUTOMAÇÃO: Criar solicitação de impressão para o Electron ---
        await prisma.printRequest.create({
            data: {
                tableNum: Number(tableNum),
                orderId: order.id,
                status: 'pending'
            }
        });
        console.log(`[PRINT] Solicitação criada para Mesa ${tableNum} (Pedido ${order.id})`);

        res.json(order);
    } catch (error) {
        console.error("ERRO NO CREATE ORDER:", error);
        res.status(500).json({ error: 'Erro ao salvar pedido', details: String(error) });
    }
});

// --- ROTA: FECHAR MESA (PAGAMENTO) ---
app.post('/orders/close', async (req, res) => {
    const { tableNum, paidCash, paidPix, paidCard, change, restaurantId, tip } = req.body;
    const rid = restaurantId ? Number(restaurantId) : undefined;

    console.log(`[CLOSE_ORDER] Solicitado fechamento Mesa ${tableNum} (Restaurante: ${rid})`);

    try {
        // 1. Procura o Caixa que está ABERTO no momento
        const openCashier = await prisma.cashier.findFirst({
            where: { status: 'Aberto', ...(rid ? { restaurantId: rid } : {}) }
        });

        if (!openCashier) {
            console.warn(`[CLOSE_ORDER] Tentativa de fechar mesa sem caixa aberto!`);
            return res.status(400).json({ error: 'Não há um caixa aberto para registrar o pagamento.' });
        }

        // 2. Encontra TODOS os pedidos pendentes da mesa
        const orders = await prisma.order.findMany({
            where: { tableNum: Number(tableNum), status: 'PENDENTE', ...(rid ? { restaurantId: rid } : {}) }
        });

        console.log(`[CLOSE_ORDER] Encontrados ${orders.length} pedidos pendentes para a mesa ${tableNum}`);

        if (orders.length === 0) {
            return res.status(400).json({ error: 'Nenhum pedido encontrado para esta mesa.' });
        }

        const lastOrderId = orders[orders.length - 1].id;

        // Atualiza todos para CONCLUIDO e vincula ao caixa
        await prisma.order.updateMany({
            where: { tableNum: Number(tableNum), status: 'PENDENTE', ...(rid ? { restaurantId: rid } : {}) },
            data: {
                status: 'CONCLUIDO',
                cashierId: openCashier.id,
                kitchenStatus: 'DELIVERED'
            }
        });

        const updatedOrder = await prisma.order.update({
            where: { id: lastOrderId },
            data: {
                paidCash: parseFloat(paidCash || 0),
                paidPix: parseFloat(paidPix || 0),
                paidCard: parseFloat(paidCard || 0),
                change: parseFloat(change || 0),
                tip: parseFloat(tip || 0)
            }
        });

        console.log(`[CLOSE_ORDER] Mesa ${tableNum} fechada com sucesso! Order ID: ${lastOrderId}`);
        res.json(updatedOrder);

    } catch (error) {
        console.error("[CLOSE_ORDER] Erro crítico ao fechar mesa:", error);
        res.status(500).json({ error: 'Erro interno ao fechar mesa', details: String(error) });
    }
});

// --- ROTA: PEDIR CONTA (Imprimir) ---
app.post('/print-requests', async (req, res) => {
    const { tableNum, orderId } = req.body;
    try {
        const reqBill = await prisma.printRequest.create({
            data: { tableNum: Number(tableNum), orderId: Number(orderId), status: 'pending' }
        });
        res.json(reqBill);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno ao enviar pedido para a printer' });
    }
});

// --- ROTA: ATUALIZAR STATUS DA IMPRESSÃO ---
app.patch('/print-requests/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const updated = await prisma.printRequest.update({
            where: { id: Number(id) },
            data: { status }
        });
        res.json(updated);
    } catch (e) {
        res.status(500).json({ error: 'Erro ao atualizar status de impressão' });
    }
});

// --- ROTA: BUSCAR UM PEDIDO ESPECÍFICO ---
app.get('/orders/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const order = await prisma.order.findUnique({
            where: { id: Number(id) },
            include: { items: { include: { product: true } } }
        });

        if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

        // Busca o nome do garçom se houver waiterId
        let waiterName = "Não informado";
        if (order.waiterId) {
            const waiter = await prisma.user.findUnique({
                where: { id: Number(order.waiterId) }
            });
            if (waiter) waiterName = waiter.name;
        }

        res.json({ ...order, waiterName });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro ao buscar pedido' });
    }
});

// --- ROTAS DE GERENCIAMENTO DE PRODUTOS ---

// 1. LISTAR PRODUTOS
app.get('/products', async (req, res) => {
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const products = await prisma.product.findMany({
            where: rid ? { restaurantId: rid } : {},
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
    const { name, price, cost, code, categoryId, restaurantId } = req.body;
    const rid = restaurantId ? Number(restaurantId) : undefined;

    try {
        const product = await prisma.product.create({
            data: {
                name,
                price: parseFloat(price),
                cost: parseFloat(cost || 0),
                code: code || '',
                categoryId: Number(categoryId),
                ...(rid ? { restaurantId: rid } : {})
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
        console.error("ERRO DETALHADO AO DELETAR PRODUTO:", error);
        res.status(500).json({ error: 'Erro ao deletar produto' });
    }
});

// --- ROTAS DE CATEGORIAS ---

app.get('/categories', async (req, res) => {
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    const categories = await prisma.category.findMany({
        where: rid ? { restaurantId: rid } : {},
        include: { _count: { select: { products: true } } }
    });
    res.json(categories);
});

app.post('/categories', async (req, res) => {
    const { name, kitchen, restaurantId } = req.body;
    const rid = restaurantId ? Number(restaurantId) : undefined;
    try {
        const category = await prisma.category.create({
            data: { name, kitchen, ...(rid ? { restaurantId: rid } : {}) }
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
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const orders = await prisma.order.findMany({
            where: {
                kitchenStatus: { not: 'DELIVERED' },
                status: { not: 'Cancelado' },
                ...(rid ? { restaurantId: rid } : {})
            },
            include: { items: { include: { product: true } } },
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
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const aggregate = await prisma.order.aggregate({
            _sum: { total: true },
            where: { status: 'CONCLUIDO', ...(rid ? { restaurantId: rid } : {}) }
        });
        const revenue = aggregate._sum.total || 0;

        const expensesAggregate = await prisma.expense.aggregate({
            _sum: { amount: true }
        });
        const expenses = expensesAggregate._sum.amount || 0;
        const profit = revenue - expenses;
        const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(2) : 0;

        res.json({ revenue, expenses, profit, margin });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao calcular KPIs' });
    }
});

app.get('/financial/evolution', async (req, res) => {
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const today = new Date();
        const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 5, 1);

        const orders = await prisma.order.findMany({
            where: { status: 'CONCLUIDO', createdAt: { gte: sixMonthsAgo }, ...(rid ? { restaurantId: rid } : {}) }
        });

        const expenses = await prisma.expense.findMany({
            where: { createdAt: { gte: sixMonthsAgo } }
        });

        const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
        const result = [];

        for (let i = 0; i < 6; i++) {
            const d = new Date(today.getFullYear(), today.getMonth() - 5 + i, 1);
            const monthName = months[d.getMonth()];

            const monthOrders = orders.filter(o =>
                o.createdAt.getMonth() === d.getMonth() && o.createdAt.getFullYear() === d.getFullYear()
            );
            const receita = monthOrders.reduce((acc, o) => acc + o.total, 0);

            const monthExpenses = expenses.filter(e =>
                e.createdAt.getMonth() === d.getMonth() && e.createdAt.getFullYear() === d.getFullYear()
            );
            const despesas = monthExpenses.reduce((acc, e) => acc + e.amount, 0);

            result.push({ name: monthName, receita, despesas, lucro: receita - despesas });
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

// --- ROTAS: MÉTODOS DE PAGAMENTO ---

app.get('/payments', async (req, res) => {
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const methods = await prisma.paymentMethod.findMany({
            where: rid ? { restaurantId: rid } : {}
        });
        res.json(methods);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar métodos de pagamento' });
    }
});

app.post('/payments', async (req, res) => {
    const { name, type, active } = req.body;
    try {
        const restaurante = await prisma.restaurant.findFirst();

        const method = await prisma.paymentMethod.create({
            data: {
                name,
                type: type || 'OTHER',
                active: active !== undefined ? active : true,
                restaurantId: restaurante?.id || null
            }
        });
        res.json(method);
    } catch (error) {
        console.error("ERRO NO CREATE PAYMENT", error);
        res.status(500).json({ error: 'Erro ao criar método de pagamento' });
    }
});

app.put('/payments/:id', async (req, res) => {
    const { id } = req.params;
    const { active } = req.body;
    try {
        const method = await prisma.paymentMethod.update({
            where: { id: Number(id) },
            data: { active }
        });
        res.json(method);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar método de pagamento' });
    }
});

app.delete('/payments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.paymentMethod.delete({ where: { id: Number(id) } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao deletar método' });
    }
});

// --- ROTAS DE JORNADAS (SHIFTS) ---

app.get('/shifts', async (req, res) => {
    const rid = req.query.rid ? Number(req.query.rid) : undefined;
    try {
        const shifts = await prisma.shift.findMany({
            where: rid ? { restaurantId: rid } : {}
        });
        res.json(shifts);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar jornadas' });
    }
});

app.post('/shifts', async (req, res) => {
    const { name, startTime, endTime, restaurantId } = req.body;
    try {
        const shift = await prisma.shift.create({
            data: {
                name,
                startTime,
                endTime,
                restaurantId: restaurantId ? Number(restaurantId) : null
            }
        });
        res.json(shift);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar jornada' });
    }
});

app.put('/shifts/:id', async (req, res) => {
    const { id } = req.params;
    const { name, startTime, endTime } = req.body;
    try {
        const shift = await prisma.shift.update({
            where: { id: Number(id) },
            data: { name, startTime, endTime }
        });
        res.json(shift);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar jornada' });
    }
});

app.delete('/shifts/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.shift.delete({ where: { id: Number(id) } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao deletar jornada' });
    }
});

// Se estivermos rodando no seu computador (ambiente local), ele usa a porta 3001
app.listen(3001, '0.0.0.0', () => {
    console.log('✅ Servidor PDV rodando em http://localhost:3001');
});

// Exportamos o 'app' para a Vercel poder usar no modo Serverless
export default app;
