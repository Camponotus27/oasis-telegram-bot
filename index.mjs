import 'dotenv/config';
import { DateTime } from 'luxon';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';

// --------- ENV ----------
const {
  MODE,
  BOT_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY,
  ALLOWED_TELEGRAM_IDS = ''
} = process.env;
if (!BOT_TOKEN) throw new Error('Falta BOT_TOKEN');

// Mapea estados técnicos de Odoo → etiqueta corta legible
const POS_STATE_LABEL = {
  draft: 'Borrador',
  paid: 'Pagado',
  done: 'Cerrado',
  invoiced: 'Facturado',
  posted: 'Registrado'
};

// Formatea CLP bonito
function fmtCLP(n) {
  try { return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n); }
  catch { return `$ ${Math.round(n).toLocaleString('es-CL')}`; }
}

// Convierte Date a “YYYY-MM-DD”
function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayRangeUTC(dateStr) {
  const tz = 'America/Santiago';
  const base = dateStr ? DateTime.fromISO(dateStr, { zone: tz }) : DateTime.now().setZone(tz);
  const start = base.startOf('day').toUTC();
  const end   = base.endOf('day').toUTC();
  return [start.toISO({ suppressMilliseconds: true }), end.toISO({ suppressMilliseconds: true })];
}


// Consulta órdenes de POS en ese rango
async function fetchPosOrdersByDate(dateStr /* opcional */) {
  const [startIso, endIso] = dayRangeUTC(dateStr);
  // Campos mínimos para listado móvil
  const fields = ['date_order', 'amount_total', 'state', 'table_id', 'name']; // name = número de orden
  // Trae “hoy” (UTC) y ordena por fecha asc
  const domain = [
    ['date_order', '>=', startIso],
    ['date_order', '<=', endIso],
    ['state', '!=', 'cancel'],
  ];
  const orders = await odooExecuteKw('pos.order', 'search_read', [domain], { fields, order: 'date_order asc', limit: 200 });
  return orders;
}

// Arma mensaje compacto: "HH:MM  Mesa X — $Total — Estado"
function buildPosSummaryMessage(orders, { title = 'Resumen del día' } = {}) {
  if (!orders.length) return `${title}\n(no hay órdenes)`;
  let total = 0;
  const lines = orders.map(o => {
    total += o.amount_total || 0;

    // Odoo: "YYYY-MM-DD HH:mm:ss" (sin T)
    const dt = DateTime.fromFormat(o.date_order, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' })
                        .setZone('America/Santiago');
    const hhmm = dt.toFormat('HH:mm');

    const mesa = Array.isArray(o.table_id) ? o.table_id[1] : (o.table_id || '-');
    const estado = POS_STATE_LABEL[o.state] || o.state;
    return `• ${hhmm}  ${mesa} — ${fmtCLP(o.amount_total)} — ${estado}`;
  });

  return [`*${title}*`, ...lines, `\n*Total*: ${fmtCLP(total)}  |  Órdenes: ${orders.length}`].join('\n');
}

const allowed = new Set(
  ALLOWED_TELEGRAM_IDS.split(',').map(s => s.trim()).filter(Boolean).map(Number)
);

// --- Helpers JSON-RPC estándar (authenticate + execute_kw) ---
let ODOO_UID = null;
async function odooRpcCall(service, method, args) {
  const res = await axios.post(
    `${ODOO_URL.replace(/\/$/, '')}/jsonrpc`,
    { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  if (res.data.error) throw new Error(JSON.stringify(res.data.error));
  return res.data.result;
}

async function odooAuthenticate() {
  if (ODOO_UID) return ODOO_UID;
  // OJO: la API Key se usa como "password"
  const uid = await odooRpcCall('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
  if (!uid) throw new Error('Odoo auth falló: revisa ODOO_DB / ODOO_USER / ODOO_API_KEY');
  ODOO_UID = uid;
  return uid;
}

async function odooExecuteKw(model, method, args = [], kwargs = {}) {
  const uid = await odooAuthenticate();
  return odooRpcCall('object', 'execute_kw', [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);
}

// Busca product.product por "name ilike" y purchase_ok = true
async function searchPurchasableProductsByName(q, limit = 10) {
  const domain = [['purchase_ok', '=', true], '|', ['name', 'ilike', q], ['display_name', 'ilike', q]];
  const fields = ['id', 'name', 'display_name', 'product_tmpl_id', 'uom_id'];
  // Nota: en execute_kw, domain va en args; fields/limit en kwargs
  return odooExecuteKw('product.product', 'search_read', [domain], { fields, limit, order: 'name' });
}

// Obtiene primer proveedor del template del producto
async function getFirstVendorForProductTemplate(product_tmpl_id) {
  const domain = [['product_tmpl_id', '=', product_tmpl_id]];
  const infos = await odooExecuteKw('product.supplierinfo', 'search_read', [domain], {
    fields: ['partner_id'],
    limit: 1,
    order: 'sequence asc, id asc', // opcional
  });
  if (!infos.length) return null;
  const partner = infos[0].partner_id; // [id, "Vendor Name"]
  return Array.isArray(partner) ? partner[0] : partner;
}

// Crea pedido de compra (borrador) con una línea
async function createPurchaseRFQ(partner_id, product_id, qty, uom_po) {
  const orderId = await odooExecuteKw('purchase.order', 'create', [{
    partner_id: partner_id,
  }]);

  await odooExecuteKw('purchase.order.line', 'create', [{
    order_id: orderId,
    product_id: product_id,
    name: 'Reposición vía Telegram',
    product_qty: qty,
    product_uom: Array.isArray(uom_po) ? uom_po[0] : uom_po,
    price_unit: 0,
    date_planned: new Date().toISOString().slice(0, 10),
  }]);

  return orderId;
}

// --------- ESTADO SIMPLE POR USUARIO ---------
const session = new Map(); // { userId: { step, lastQuery, pickedProduct, qty } }

// --------- BOT ----------
const bot = new Telegraf(BOT_TOKEN);

function isAllowed(ctx) {
  return allowed.size === 0 || allowed.has(ctx.from.id);
}

bot.start((ctx) => {
  if (!isAllowed(ctx)) return ctx.reply(`No autorizado. Tu ID: ${ctx.from.id}`);
  ctx.reply('Hola 👋 Usa `/reponer <texto> [cantidad]`.\nEj: `/reponer ciabatta 20`', { parse_mode: 'Markdown' });
});

bot.command(['resumen', 'hoy'], async (ctx) => {
  if (!isAllowed(ctx)) return;

  try {
    const txt = ctx.message.text.trim();
    // Permite /resumen YYYY-MM-DD
    const parts = txt.split(/\s+/);
    const dateArg = parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]) ? parts[1] : null;

    await ctx.reply('📊 Generando resumen…');

    const orders = await fetchPosOrdersByDate(dateArg);
    const titulo = dateArg ? `Resumen ${dateArg}` : 'Resumen de hoy';
    const message = buildPosSummaryMessage(orders, { title: titulo });

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Resumen POS error:', e.response?.data || e);
    const serverMsg = e.response?.data?.error?.data?.message || e.message;
    await ctx.reply(`⚠️ Error obteniendo resumen: ${serverMsg}`);
  }
});

bot.command('reponer', async (ctx) => {
  if (!isAllowed(ctx)) return;

  const text = ctx.message.text || '';
  // Extrae términos y cantidad opcional al final
  // /reponer ciabatta 20
  const parts = text.split(/\s+/).slice(1);
  if (!parts.length) return ctx.reply('Dime qué quieres reponer. Ej: `/reponer ciabatta 10`', { parse_mode: 'Markdown' });

  let qty = null;
  const maybeQty = parts[parts.length - 1];
  if (/^\d+([.,]\d+)?$/.test(maybeQty)) {
    qty = parseFloat(maybeQty.replace(',', '.'));
    parts.pop();
  }
  const query = parts.join(' ').trim();

  // Busca productos en Odoo
  await ctx.reply(`🔎 Buscando productos que contengan “${query}”...`);
  try {
    const items = await searchPurchasableProductsByName(query, 10);
    if (!items.length) {
      return ctx.reply('No encontré productos comprables con ese término. Prueba otro nombre.');
    }

    // Guarda sesión
    session.set(ctx.from.id, { step: 'choose_product', lastQuery: query, qty });

    // Muestra botones
    const buttons = items.map(p =>
      [Markup.button.callback(p.display_name || p.name, `pick:${p.id}:${p.product_tmpl_id[0]}`)]
    );
    await ctx.reply(
      'Elige el producto a reponer:',
      Markup.inlineKeyboard(buttons)
    );
  } catch (e) {
    await ctx.reply(`⚠️ Error buscando productos: ${e.message}`);
  }
});

// Usuario elige producto
bot.on('callback_query', async (ctx) => {
  if (!isAllowed(ctx)) {
    await ctx.answerCbQuery('No autorizado.');
    return;
  }

  const data = ctx.callbackQuery.data || '';
  if (!data.startsWith('pick:')) return ctx.answerCbQuery();

  const [, productIdStr, tmplIdStr] = data.split(':');
  const product_id = Number(productIdStr);
  const product_tmpl_id = Number(tmplIdStr);

  const st = session.get(ctx.from.id) || {};
  st.pickedProduct = { product_id, product_tmpl_id };
  session.set(ctx.from.id, st);

  // Si ya teníamos cantidad (del comando), avanzar a crear RFQ
  if (st.qty && st.qty > 0) {
    await ctx.editMessageText('Procesando reposición…');
    return createRFQFlow(ctx, st);
  }

  // Pedir cantidad
  st.step = 'ask_qty';
  session.set(ctx.from.id, st);
  await ctx.editMessageText('¿Cantidad a reponer? (ej: 20)');
});

// Usuario ingresa la cantidad
bot.on('text', async (ctx) => {
  if (!isAllowed(ctx)) return;

  const st = session.get(ctx.from.id);
  if (!st || st.step !== 'ask_qty') return; // Ignora textos fuera del flujo

  const raw = (ctx.message.text || '').trim();
  if (!/^\d+([.,]\d+)?$/.test(raw)) {
    return ctx.reply('Por favor, ingresa un número. Ej: 20');
  }
  st.qty = parseFloat(raw.replace(',', '.'));
  session.set(ctx.from.id, st);

  await ctx.reply('Procesando reposición…');
  return createRFQFlow(ctx, st);
});

async function createRFQFlow(ctx, st) {
  try {
    const { product_id, product_tmpl_id } = st.pickedProduct;
    const qty = st.qty || 1;

    // UoM de compra desde el template
    const tmpl = await odooExecuteKw('product.template', 'read', [[product_tmpl_id]], {
      fields: ['uom_po_id', 'name']
    });
    const uom_po = tmpl?.[0]?.uom_po_id || null;

    // Proveedor principal
    const vendorId = await getFirstVendorForProductTemplate(product_tmpl_id);
    if (!vendorId) {
      session.delete(ctx.from.id);
      return ctx.reply('⚠️ El producto no tiene proveedor configurado en Odoo. Agrega uno y vuelve a intentar.');
    }

    // Crear RFQ
    const poId = await createPurchaseRFQ(vendorId, product_id, qty, uom_po);

    session.delete(ctx.from.id);
    return ctx.reply(`✅ RFQ creada en Odoo (purchase.order ID ${poId}) por *${qty}* unidades.`, { parse_mode: 'Markdown' });
  } catch (e) {
    session.delete(ctx.from.id);
    console.error('Error en createRFQFlow:', e.response?.data || e);
    return ctx.reply(`⚠️ Error creando RFQ: ${e.response?.data?.error?.data?.message || e.message}`);
  }
}

process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e?.response?.data || e);
});
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT EXCEPTION:', e);
});

(async () => {
  try {
    console.log('Modo actual:', process.env.MODE || '(no definido)');
    console.log('BOT_TOKEN set?:', !!process.env.BOT_TOKEN);

    // 1) Fuerza LONG POLLING (borra webhook si estuviera activo)
    console.log('Borrando webhook (si existe)…');
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });

    // 2) Muestra info de webhook para confirmar que quedó limpio
    const wh = await bot.telegram.getWebhookInfo();
    console.log('Webhook actual:', wh?.url || '(ninguno)');

    // 3) Confirma el bot correcto
    const me = await bot.telegram.getMe();
    console.log('Conectado como @' + me.username);

    // 4) Handlers mínimos para probar vida
    bot.command('ping', (ctx) => ctx.reply('pong'));
    bot.use(async (ctx, next) => {
      console.log('Update recibido:', JSON.stringify(ctx.update));
      return next();
    });

    // 5) Lanza POLLING
    await bot.launch({ dropPendingUpdates: false });
    console.log('✅ Bot iniciado (long polling). Envíale /ping o /start por Telegram.');
  } catch (e) {
    console.error('❌ Error al iniciar:', e?.response?.data || e);
    // Si estás en VSCode, no cierres el proceso de inmediato para leer el log;
    // si quieres cerrar: process.exit(1);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
