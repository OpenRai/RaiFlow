// GET /api/invoice/[id]/events — returns events array for polling

import { RaiFlowClient } from '@openrai/raiflow-sdk';

const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';

export async function GET(_req, { params }) {
  const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

  try {
    const { data: events } = await raiflow.invoices.listEvents(params.id);
    return Response.json({ events });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
