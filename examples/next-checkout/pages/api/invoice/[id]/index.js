// GET /api/invoice/[id] — returns invoice state

import { RaiFlowClient } from '@openrai/raiflow-sdk';

const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';

export async function GET(_req, { params }) {
  const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

  try {
    const invoice = await raiflow.invoices.get(params.id);
    return Response.json(invoice);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Not found' }, { status: 404 });
  }
}
