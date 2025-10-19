import "dotenv/config";
import axios, { AxiosResponse } from "axios";
import { Telegraf, Markup, Context } from "telegraf";
import { DateTime } from "luxon";

/* =========================
   ENV
========================= */
const {
  MODE,
  BOT_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY,
  ALLOWED_TELEGRAM_IDS = "",
} = process.env as Record<string, string | undefined>;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!ODOO_URL) throw new Error("Falta ODOO_URL");
if (!ODOO_DB) throw new Error("Falta ODOO_DB");
if (!ODOO_USER) throw new Error("Falta ODOO_USER");
if (!ODOO_API_KEY) throw new Error("Falta ODOO_API_KEY");

const allowed = new Set<number>(
  (ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

/* =========================
   TIPOS
========================= */
type PosState = "draft" | "paid" | "done" | "invoiced" | "posted" | "cancel";

interface PosOrder {
  id: number;
  date_order: string; // "YYYY-MM-DD HH:mm:ss" (UTC en string sin 'T')
  amount_total: number;
  state: PosState;
  table_id: [number, string] | false | null;
  name: string;
}

interface SupplierInfo {
  partner_id: [number, string];
}

interface ProductVariant {
  id: number;
  name: string;
  display_name: string;
  product_tmpl_id: [number, string];
  uom_id: [number, string];
}

interface ProductTemplate {
  id: number;
  name: string;
  uom_po_id: [number, string] | false | null;
}

type JsonRpcResult<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: any;
};

/* =========================
   UTILIDADES
========================= */
const POS_STATE_LABEL: Record<string, string> = {
  draft: "Borrador",
  paid: "Pagado",
  done: "Cerrado",
  invoiced: "Facturado",
  posted: "Registrado",
  cancel: "Cancelado",
};

function fmtCLP(n: number | null | undefined): string {
  const v = Math.round(n ?? 0);
  try {
    return new Intl.NumberFormat("es-CL", {
      style: "currency",
      currency: "CLP",
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `$ ${v.toLocaleString("es-CL")}`;
  }
}

function dayRangeUTC(dateStr?: string | null): [string, string] {
  const tz = "America/Santiago";
  const base = dateStr
    ? DateTime.fromISO(dateStr, { zone: tz })
    : DateTime.now().setZone(tz);
  const start = base.startOf("day").toUTC();
  const end = base.endOf("day").toUTC();
  // Odoo acepta "YYYY-MM-DD HH:mm:ss" con espacio
  return [
    start.toFormat("yyyy-LL-dd HH:mm:ss"),
    end.toFormat("yyyy-LL-dd HH:mm:ss"),
  ];
}

function m2oId(v: unknown): number | null {
  return Array.isArray(v) ? (v[0] as number) : null;
}

/* =========================
   ODOO JSON-RPC (authenticate + execute_kw)
========================= */
const ODOO_BASE = ODOO_URL.replace(/\/$/, "");
let ODOO_UID: number | null = null;

async function odooRpcCall<T = unknown>(
  service: "common" | "object",
  method: string,
  args: any[]
): Promise<T> {
  const payload = {
    jsonrpc: "2.0" as const,
    method: "call",
    params: { service, method, args },
    id: Date.now(),
  };
  const res: AxiosResponse<JsonRpcResult<T>> = await axios.post(
    `${ODOO_BASE}/jsonrpc`,
    payload,
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  if (res.data.error) {
    throw new Error(JSON.stringify(res.data.error));
  }
  return res.data.result as T;
}

async function odooAuthenticate(): Promise<number> {
  if (ODOO_UID) return ODOO_UID;
  // API Key se usa como "password"
  const uid = await odooRpcCall<number>("common", "authenticate", [
    ODOO_DB,
    ODOO_USER,
    ODOO_API_KEY,
    {},
  ]);
  if (!uid)
    throw new Error(
      "Odoo auth falló: revisa ODOO_DB / ODOO_USER / ODOO_API_KEY"
    );
  ODOO_UID = uid;
  return uid;
}

async function odooExecuteKw<T = unknown>(
  model: string,
  method: string,
  args: any[] = [],
  kwargs: Record<string, any> = {}
): Promise<T> {
  const uid = await odooAuthenticate();
  return odooRpcCall<T>("object", "execute_kw", [
    ODOO_DB,
    uid,
    ODOO_API_KEY,
    model,
    method,
    args,
    kwargs,
  ]);
}

/* =========================
   ODOO HELPERS DE NEGOCIO
========================= */
async function searchPurchasableProductsByName(
  q: string,
  limit = 10
): Promise<ProductVariant[]> {
  const domain: any[] = [
    ["purchase_ok", "=", true],
    "|",
    ["name", "ilike", q],
    ["display_name", "ilike", q],
  ];
  const fields = ["id", "name", "display_name", "product_tmpl_id", "uom_id"];
  return odooExecuteKw<ProductVariant[]>(
    "product.product",
    "search_read",
    [domain],
    { fields, limit, order: "name" }
  );
}

async function getFirstVendorForProductTemplate(
  product_tmpl_id: number
): Promise<number | null> {
  const domain: any[] = [["product_tmpl_id", "=", product_tmpl_id]];
  const infos = await odooExecuteKw<SupplierInfo[]>(
    "product.supplierinfo",
    "search_read",
    [domain],
    {
      fields: ["partner_id"],
      limit: 1,
      order: "sequence asc, id asc",
    }
  );
  if (!infos.length) return null;
  const partner = infos[0].partner_id;
  return Array.isArray(partner) ? partner[0] : partner || null;
}

async function createPurchaseRFQ(
  partner_id: number,
  product_id: number,
  qty: number,
  uom_id?: number | null
) {
  const orderId = await odooExecuteKw<number>("purchase.order", "create", [
    {
      partner_id,
    },
  ]);

  await odooExecuteKw<number>("purchase.order.line", "create", [
    {
      order_id: orderId,
      product_id,
      name: "Reposición vía Telegram",
      product_qty: qty,
      product_uom: uom_id ?? undefined, // ✅ nunca boolean
      price_unit: 0,
      date_planned: DateTime.now().toFormat("yyyy-LL-dd"),
    },
  ]);

  return orderId;
}

/* =========================
   RESUMEN POS
========================= */
async function fetchPosOrdersByDate(
  dateStr?: string | null
): Promise<PosOrder[]> {
  const [startIso, endIso] = dayRangeUTC(dateStr);
  const fields = ["date_order", "amount_total", "state", "table_id", "name"];
  const domain: any[] = [
    ["date_order", ">=", startIso],
    ["date_order", "<=", endIso],
    ["state", "!=", "cancel"],
  ];
  const orders = await odooExecuteKw<PosOrder[]>(
    "pos.order",
    "search_read",
    [domain],
    {
      fields,
      order: "date_order asc",
      limit: 200,
    }
  );
  return orders;
}

function buildPosSummaryMessage(
  orders: PosOrder[],
  { title = "Resumen del día" }: { title?: string } = {}
): string {
  if (!orders.length) return `${title}\n(no hay órdenes)`;

  let total = 0;
  const lines = orders.map((o) => {
    total += o.amount_total || 0;
    // Odoo: "YYYY-MM-DD HH:mm:ss" (UTC sin 'T'); lo parseamos como UTC
    const dt = DateTime.fromFormat(o.date_order, "yyyy-LL-dd HH:mm:ss", {
      zone: "UTC",
    }).setZone("America/Santiago");
    const hhmm = dt.isValid ? dt.toFormat("HH:mm") : "??:??";

    const mesa = Array.isArray(o.table_id)
      ? o.table_id[1]
      : (o.table_id as any) || "-";
    const estado = POS_STATE_LABEL[o.state] ?? o.state;

    return `• ${hhmm}  ${mesa} — ${fmtCLP(o.amount_total)} — ${estado}`;
  });

  return [
    `*${title}*`,
    ...lines,
    `\n*Total*: ${fmtCLP(total)}  |  Órdenes: ${orders.length}`,
  ].join("\n");
}

/* =========================
   ESTADO SIMPLE POR USUARIO
========================= */
type SessionState = {
  step?: "choose_product" | "ask_qty";
  lastQuery?: string;
  pickedProduct?: { product_id: number; product_tmpl_id: number };
  qty?: number | null;
};
const session = new Map<number, SessionState>();

/* =========================
   BOT
========================= */
const bot = new Telegraf(BOT_TOKEN);

function isAllowed(ctx: Context): boolean {
  const isAllowed = allowed.size === 0 || allowed.has(ctx.from!.id);
  console.log(
    `"Revicion de autorizacion de ${ctx.from?.first_name} y ID ${
      ctx.from?.id
    } ${isAllowed ? "autorizado" : "NO autorizado"}"`
  );
  return isAllowed;
}

bot.start((ctx) => {
  if (!isAllowed(ctx))
    return ctx.reply(`No autorizado. Tu ID: ${ctx.from!.id}`);
  return ctx.reply(
    "Hola 👋 Usa:\n" +
      "• `/reponer <texto> [cantidad]`\n" +
      "• `/hoy` o `/resumen [YYYY-MM-DD]`",
    { parse_mode: "Markdown" }
  );
});

bot.command(["resumen", "hoy"], async (ctx) => {
  if (!isAllowed(ctx)) return;

  try {
    const txt = (ctx.message as any).text?.trim() ?? "";
    const parts = txt.split(/\s+/);
    const dateArg =
      parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]) ? parts[1] : null;

    await ctx.reply("📊 Generando resumen…");

    const orders = await fetchPosOrdersByDate(dateArg);
    const titulo = dateArg ? `Resumen ${dateArg}` : "Resumen de hoy";
    const message = buildPosSummaryMessage(orders, { title: titulo });

    await ctx.reply(message, { parse_mode: "Markdown" });
  } catch (e: any) {
    console.error("Resumen POS error:", e?.response?.data || e);
    const serverMsg =
      e?.response?.data?.error?.data?.message ||
      e?.message ||
      "Error desconocido";
    await ctx.reply(`⚠️ Error obteniendo resumen: ${serverMsg}`);
  }
});

bot.command("reponer", async (ctx) => {
  if (!isAllowed(ctx)) return;

  const text = (ctx.message as any).text ?? "";
  const parts = text.split(/\s+/).slice(1);
  if (!parts.length) {
    return ctx.reply("Dime qué quieres reponer. Ej: `/reponer ciabatta 10`", {
      parse_mode: "Markdown",
    });
  }

  let qty: number | null = null;
  const maybeQty = parts[parts.length - 1];
  if (/^\d+([.,]\d+)?$/.test(maybeQty)) {
    qty = parseFloat(maybeQty.replace(",", "."));
    parts.pop();
  }
  const query = parts.join(" ").trim();

  await ctx.reply(`🔎 Buscando productos que contengan “${query}”...`);
  try {
    const items = await searchPurchasableProductsByName(query, 10);
    if (!items.length) {
      return ctx.reply(
        "No encontré productos comprables con ese término. Prueba otro nombre."
      );
    }

    session.set(ctx.from!.id, {
      step: "choose_product",
      lastQuery: query,
      qty,
    });

    const buttons = items.map((p) => [
      Markup.button.callback(
        p.display_name || p.name,
        `pick:${p.id}:${p.product_tmpl_id[0]}`
      ),
    ]);

    await ctx.reply(
      "Elige el producto a reponer:",
      Markup.inlineKeyboard(buttons)
    );
  } catch (e: any) {
    const msg = e?.response?.data?.error?.data?.message || e?.message;
    await ctx.reply(`⚠️ Error buscando productos: ${msg}`);
  }
});

bot.on("callback_query", async (ctx) => {
  if (!isAllowed(ctx)) {
    await ctx.answerCbQuery("No autorizado.");
    return;
  }
  const data = (ctx.callbackQuery as any)?.data ?? "";
  if (!data.startsWith("pick:")) return ctx.answerCbQuery();

  const [, productIdStr, tmplIdStr] = data.split(":");
  const product_id = Number(productIdStr);
  const product_tmpl_id = Number(tmplIdStr);

  const st: SessionState = session.get(ctx.from!.id) ?? {};
  st.pickedProduct = { product_id, product_tmpl_id };
  session.set(ctx.from!.id, st);

  if (st.qty && st.qty > 0) {
    await ctx.editMessageText("Procesando reposición…");
    return createRFQFlow(ctx, st);
  }

  st.step = "ask_qty";
  session.set(ctx.from!.id, st);
  await ctx.editMessageText("¿Cantidad a reponer? (ej: 20)");
});

bot.on("text", async (ctx) => {
  if (!isAllowed(ctx)) return;

  const st: SessionState | undefined = session.get(ctx.from!.id);
  if (!st || st.step !== "ask_qty") return;

  const raw = ((ctx.message as any).text ?? "").trim();
  if (!/^\d+([.,]\d+)?$/.test(raw)) {
    return ctx.reply("Por favor, ingresa un número. Ej: 20");
  }
  st.qty = parseFloat(raw.replace(",", "."));
  session.set(ctx.from!.id, st);

  await ctx.reply("Procesando reposición…");
  return createRFQFlow(ctx, st);
});

/* =========================
   RFQ FLOW
========================= */
async function createRFQFlow(ctx: Context, st: SessionState) {
  try {
    const { product_id, product_tmpl_id } = st.pickedProduct!;
    const qty = st.qty ?? 1;

    const tmpl = await odooExecuteKw<ProductTemplate[]>(
      "product.template",
      "read",
      [[product_tmpl_id]],
      {
        fields: ["uom_po_id", "name"],
      }
    );
    const uomId: number | null = m2oId(tmpl?.[0]?.uom_po_id);

    const vendorId = await getFirstVendorForProductTemplate(product_tmpl_id);
    if (!vendorId) {
      session.delete(ctx.from!.id);
      return ctx.reply(
        "⚠️ El producto no tiene proveedor configurado en Odoo. Agrega uno y vuelve a intentar."
      );
    }

    const poId = await createPurchaseRFQ(vendorId, product_id, qty, uomId);

    session.delete(ctx.from!.id);
    return ctx.reply(
      `✅ RFQ creada en Odoo (purchase.order ID ${poId}) por *${qty}* unidades.`,
      { parse_mode: "Markdown" }
    );
  } catch (e: any) {
    session.delete(ctx.from!.id);
    console.error("Error en createRFQFlow:", e?.response?.data || e);
    const serverMsg =
      e?.response?.data?.error?.data?.message ||
      e?.message ||
      "Error desconocido";
    return ctx.reply(`⚠️ Error creando RFQ: ${serverMsg}`);
  }
}

/* =========================
   ERRORES GLOBALES Y ARRANQUE
========================= */
bot.catch((err, ctx) => {
  console.error("TELEGRAF ERROR:", err);
  if ((ctx as any)?.reply)
    (ctx as any).reply("⚠️ Error interno. Intenta de nuevo.");
});

process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", (e as any)?.response?.data || e);
});
process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT EXCEPTION:", e);
});

(async () => {
  try {
    console.log("Modo actual:", MODE || "(no definido)");
    console.log("BOT_TOKEN set?:", !!BOT_TOKEN);

    console.log("Borrando webhook (si existe)…");
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });

    const wh = await bot.telegram.getWebhookInfo();
    console.log("Webhook actual:", (wh as any)?.url || "(ninguno)");

    const me = await bot.telegram.getMe();
    console.log("Conectado como @" + me.username);

    bot.command("ping", (ctx) => ctx.reply("pong"));
    bot.use(async (ctx, next) => {
      console.log("Update recibido:", JSON.stringify(ctx.update));
      return next();
    });

    // 💓 Heartbeat: muestra "alive" cada minuto para confirmar que el bot sigue activo
    setInterval(() => {
      const now = new Date().toLocaleString("es-CL", {
        timeZone: "America/Santiago",
      });
      console.log(`💓 alive at ${now}`);
    }, 60_000);

    await bot.launch({ dropPendingUpdates: false });
    console.log(
      "✅ Bot iniciado (long polling). Envíale /ping o /start por Telegram."
    );
  } catch (e: any) {
    console.error("❌ Error al iniciar:", e?.response?.data || e);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
