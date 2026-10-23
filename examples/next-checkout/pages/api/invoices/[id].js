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
  try {
    res.status(200).json(await client.invoices.get(String(req.query.id)));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Invoice not found' });
  }
}
