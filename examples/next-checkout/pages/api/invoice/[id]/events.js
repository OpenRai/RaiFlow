import { RaiFlowClient } from '@openrai/raiflow-sdk';

const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).send('Method Not Allowed');
    return;
  }

  const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

  try {
    const { data: events } = await raiflow.invoices.listEvents(req.query.id);
    res.status(200).json({ events });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
