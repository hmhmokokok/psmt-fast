// Stripe webhook for PSMT FAST: marks orders paid or expired. Every request must carry a valid
// Stripe-Signature for STRIPE_WEBHOOK_SECRET; anything else is rejected before the body is used.

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't') timestamp = v;
    else if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // 5-minute replay window
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((s) => safeEqual(s, expected));
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret) return new Response('Webhook secret not configured', { status: 503 });

  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get('stripe-signature'), secret))) {
    return new Response('Invalid signature', { status: 400 });
  }

  const event = JSON.parse(payload);
  const session = event?.data?.object ?? {};
  const orderId = String(session.metadata?.order_id ?? session.client_reference_id ?? '');

  let patch: Record<string, unknown> | null = null;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    patch = {
      status: session.payment_status === 'paid' ? 'paid' : 'created',
      customer_email: session.customer_details?.email ?? null,
      amount_total: session.amount_total ?? undefined,
      shipping: session.collected_information?.shipping_details ?? session.shipping_details ?? null,
    };
  } else if (event.type === 'checkout.session.expired') {
    patch = { status: 'expired' };
  }

  if (patch && UUID.test(orderId)) {
    const res = await fetch(`${SB_URL}/rest/v1/orders?id=eq.${orderId}`, {
      method: 'PATCH',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.error('order update failed', res.status, await res.text());
      return new Response('Update failed', { status: 500 }); // Stripe retries
    }
  }
  return new Response('ok');
});
