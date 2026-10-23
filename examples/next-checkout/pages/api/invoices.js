import { RaiFlowClient } from '@openrai/raiflow-sdk';

function getClient() {
  const baseUrl = process.env.RAIFLOW_URL ?? 'http://localhost:3100';
  const apiKey = process.env.RAIFLOW_API_KEY;
  if (!apiKey) throw new Error('RAIFLOW_API_KEY is required by this server-side example');
  return RaiFlowClient.initialize({ baseUrl, apiKey });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).send('Method Not Allowed');
    return;
  }

  const amount = String(req.body?.amount ?? '').trim();
  const orderId = String(req.body?.orderId ?? '').trim();
  if (!/^[0-9]+(?:\.[0-9]{1,30})?$/.test(amount) || /^0(?:\.0+)?$/.test(amount)) {
    res.status(400).send('Enter a positive XNO amount with at most 30 decimal places.');
    return;
  }
  if (!orderId || orderId.length > 120) {
    res.status(400).send('Enter an order reference between 1 and 120 characters.');
    return;
  }

  try {
    const invoice = await getClient().invoices.create({
      accountKey: 'next-checkout',
      invoiceKey: orderId,
      expectedAmount: amount,
      metadata: { orderId },
    }, `checkout:${orderId}`);
    res.redirect(303, `/checkout/${encodeURIComponent(invoice.id)}`);
  } catch (error) {
    res.status(502).send(`Could not create payment request: ${error instanceof Error ? error.message : String(error)}`);
  }
}
