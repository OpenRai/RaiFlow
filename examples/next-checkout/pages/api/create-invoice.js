import { RaiFlowClient } from '@openrai/raiflow-sdk';

const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';
const DEFAULT_RECIPIENT_ACCOUNT =
  process.env.RAIFLOW_RECIPIENT_ACCOUNT ??
  'nano_3strnmn7h9b7oghxa6h9ckrpf5r454fsobpicixps6xwiwc5q4hat7wjbpqz';
const RAW_PER_XNO = 1_000_000_000_000_000_000_000_000_000n;

function xnoToRaw(xno) {
  const s = String(xno).trim();
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);
  const padded = (fracPart + '0'.repeat(30)).slice(0, 30);
  return (BigInt(intPart) * RAW_PER_XNO + BigInt(padded)).toString();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).send('Method Not Allowed');
    return;
  }

  const amount = req.body?.amount;
  const orderId = req.body?.orderId || undefined;
  const recipientAccount = String(req.body?.recipientAccount || DEFAULT_RECIPIENT_ACCOUNT).trim();

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    res.status(400).send('Invalid amount');
    return;
  }

  const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

  try {
    const invoice = await raiflow.invoices.create({
      recipientAccount,
      expectedAmountRaw: xnoToRaw(amount),
      completionPolicy: { type: 'exact' },
      metadata: orderId ? { orderId } : undefined,
    });

    const params = new URLSearchParams();
    if (orderId) params.set('orderId', String(orderId));
    if (amount) params.set('amount', String(amount));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    res.redirect(303, `/checkout/${invoice.id}${suffix}`);
  } catch (err) {
    res
      .status(500)
      .send(`Failed to create invoice: ${err instanceof Error ? err.message : String(err)}`);
  }
}
