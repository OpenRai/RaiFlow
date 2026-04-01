// POST /api/create-invoice — creates an invoice and redirects to checkout page

import { RaiFlowClient } from '@openrai/raiflow-sdk';

const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';
const RAW_PER_XNO = 1_000_000_000_000_000_000_000_000_000n;

function xnoToRaw(xno) {
  const s = String(xno).trim();
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);
  const padded = (fracPart + '0'.repeat(30)).slice(0, 30);
  return (BigInt(intPart) * RAW_PER_XNO + BigInt(padded)).toString();
}

export async function POST(req) {
  const formData = await req.formData();
  const amount = formData.get('amount');
  const orderId = formData.get('orderId') || undefined;

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return new Response('Invalid amount', { status: 400 });
  }

  const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

  try {
    const invoice = await raiflow.invoices.create({
      expectedAmountRaw: xnoToRaw(amount),
      completionPolicy: { type: 'exact' },
      metadata: orderId ? { orderId } : undefined,
    });

    const url = new URL(`/checkout/${invoice.id}`, req.url);
    if (orderId) url.searchParams.set('orderId', orderId);
    if (amount) url.searchParams.set('amount', amount);

    return Response.redirect(url.toString(), 303);
  } catch (err) {
    return new Response(
      `Failed to create invoice: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  }
}
