import { RaiFlowClient } from '@openrai/raiflow-sdk';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).end('Method Not Allowed');
    return;
  }
  const apiKey = process.env.RAIFLOW_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'RAIFLOW_API_KEY is required' });
    return;
  }
  const client = RaiFlowClient.initialize({
    baseUrl: process.env.RAIFLOW_URL ?? 'http://localhost:3100',
    apiKey,
  });
  const after = typeof req.query.after === 'string' ? req.query.after : undefined;
  try {
    const page = await client.events.list({ ...(after ? { after } : {}), limit: 100 });
    const invoiceId = String(req.query.id);
    const events = page.data.filter((event) => {
      const data = event.data ?? {};
      return event.resourceId === invoiceId
        || data.invoice?.id === invoiceId
        || data.payment?.invoiceId === invoiceId
        || data.deposit?.invoiceId === invoiceId;
    });
    const lastSequence = page.data[page.data.length - 1]?.sequence;
    res.status(200).json({
      data: events,
      nextCursor: page.nextCursor ?? (lastSequence === undefined ? after ?? null : String(lastSequence)),
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
