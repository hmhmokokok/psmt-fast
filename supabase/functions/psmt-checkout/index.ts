// PSMT FAST checkout. GET reports whether card payments are switched on; POST turns a cart into
// a Stripe Checkout Session. Prices come from the catalogue below, never from the browser.
// Needs the STRIPE_SECRET_KEY secret. Without it, POST answers 503 and the site falls back to
// email reservations.

const CATALOG: Record<string, { name: string; cents: number }> = {
  'FAST 6H': { name: 'PSMT FAST 6H', cents: 6800 },
  'FAST 8H': { name: 'PSMT FAST 8H', cents: 8800 },
  'FAST 12H': { name: 'PSMT FAST 12H', cents: 12800 },
  'FAST 20M': { name: 'PSMT FAST 20M', cents: 2800 },
};
const COLORS: Record<string, string> = { moon: 'Moon', oat: 'Oat', midnight: 'Midnight', three: '3 a.m.' };
const SHIP_TO = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'NL', 'BE', 'SE', 'DK', 'NO', 'FI', 'ES', 'IT', 'CH', 'AT', 'IN', 'SG', 'JP'];

const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://hmhmokokok.github.io/psmt-fast/';
const ALLOWED_ORIGINS = new Set([
  new URL(SITE_URL).origin,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
]);
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Line = { model: string; color: string; qty: number; name: string; cents: number };

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : new URL(SITE_URL).origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

function db(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  });
}

function readCart(items: unknown): Line[] | null {
  if (!Array.isArray(items) || items.length === 0 || items.length > 10) return null;
  const lines: Line[] = [];
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const product = CATALOG[String(it.model)];
    const color = COLORS[String(it.color)];
    const qty = Number(it.qty);
    if (!product || !color || !Number.isInteger(qty) || qty < 1 || qty > 10) return null;
    lines.push({ model: String(it.model), color: String(it.color), qty, name: `${product.name}, ${color}`, cents: product.cents });
  }
  return lines;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (req.method === 'GET') {
    // ?health=1 also confirms this function can reach the orders table.
    if (new URL(req.url).searchParams.get('health') !== '1') return json({ payments: Boolean(stripeKey) }, 200, origin);
    const probe = await db('orders?select=id&limit=1', { method: 'GET' });
    return json({ payments: Boolean(stripeKey), database: probe.ok }, 200, origin);
  }
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
  if (!stripeKey) return json({ error: 'payments_not_configured' }, 503, origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json' }, 400, origin);
  }
  const lines = readCart(body.items);
  if (!lines) return json({ error: 'invalid_cart' }, 400, origin);

  // Send shoppers back to the page they came from, as long as it is one of ours.
  let back = SITE_URL;
  try {
    const u = new URL(String(body.return_url));
    if (ALLOWED_ORIGINS.has(u.origin)) back = u.origin + u.pathname;
  } catch {
    // keep SITE_URL
  }

  const total = lines.reduce((sum, l) => sum + l.cents * l.qty, 0);
  const created = await db('orders', {
    method: 'POST',
    body: JSON.stringify({ items: lines, amount_total: total, currency: 'usd' }),
  });
  if (!created.ok) {
    console.error('order insert failed', created.status, await created.text());
    return json({ error: 'order_failed' }, 500, origin);
  }
  const [order] = await created.json();

  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', `${back}?checkout=success&order=${order.id}`);
  form.set('cancel_url', `${back}?checkout=cancelled`);
  form.set('client_reference_id', order.id);
  form.set('metadata[order_id]', order.id);
  form.set('allow_promotion_codes', 'true');
  SHIP_TO.forEach((c, i) => form.set(`shipping_address_collection[allowed_countries][${i}]`, c));
  lines.forEach((l, i) => {
    form.set(`line_items[${i}][quantity]`, String(l.qty));
    form.set(`line_items[${i}][price_data][currency]`, 'usd');
    form.set(`line_items[${i}][price_data][unit_amount]`, String(l.cents));
    form.set(`line_items[${i}][price_data][product_data][name]`, l.name);
  });

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const session = await res.json();
  if (!res.ok) {
    console.error('stripe error', session?.error?.message);
    await db(`orders?id=eq.${order.id}`, { method: 'DELETE' });
    return json({ error: 'stripe_error' }, 502, origin);
  }

  await db(`orders?id=eq.${order.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ stripe_session_id: session.id, updated_at: new Date().toISOString() }),
  });
  return json({ url: session.url }, 200, origin);
});
