# PSMT FAST

The launch site for PSMT FAST, a pillow sold like a hypercar. The whole site is one static page, `index.html`. It takes free reservations (email, optional name and country, and the chosen pillows) and stores them in Supabase. No payments are taken yet.

Live site: https://hmhmokokok.github.io/psmt-fast/

## How it fits together

- **Site:** `index.html`. Three.js and the fonts load from public CDNs. GitHub Pages serves it from `main`.
- **Reservations:** the "Reserve" form calls the `reserve_pillow()` database function using the project's publishable key. Rows land in `public.reservations`, which that public key can't read. Reserving again with the same email updates that row.
- **Database:** `supabase/migrations/` holds the schema.

## Seeing and exporting reservations

Supabase dashboard → project **psmt-fast** → Table Editor → `reservations`. Use **Export → CSV** to download the list.

## Adding payments later

The pieces are already deployed but not used by the site: `supabase/functions/psmt-checkout` (cart → Stripe Checkout link, with prices set in its own catalogue), `supabase/functions/psmt-stripe-webhook` (marks orders paid), and the `public.orders` table. To use them, the site needs a Pay button that calls `psmt-checkout` again (see git history for the earlier version), plus these settings:

1. In the Supabase dashboard, open project **psmt-fast**, then Edge Functions → Secrets. Add `STRIPE_SECRET_KEY` (an `sk_test_…` key to try it out, an `sk_live_…` key to sell for real).
2. In the Stripe dashboard, go to Developers → Webhooks and add an endpoint:
   - URL: `https://tdaxzeejjxkuzizvxyoy.supabase.co/functions/v1/psmt-stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`

   Copy its signing secret into another Supabase secret named `STRIPE_WEBHOOK_SECRET`.
3. Open `https://tdaxzeejjxkuzizvxyoy.supabase.co/functions/v1/psmt-checkout?health=1`. It should report `"payments":true,"database":true`.

## Prices

Prices live in two places that must match:
- `CATALOG` in `supabase/functions/psmt-checkout/index.ts` sets what Stripe charges.
- The `data-add` attributes in `index.html` set what the page shows.

Change both together, then redeploy the function.

## Reading reservations and orders

In the Supabase dashboard, open Table Editor → `reservations` or `orders`.

## Local preview

```bash
python -m http.server 5173
```

Then open http://localhost:5173. The checkout function accepts that origin.
