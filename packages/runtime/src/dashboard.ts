import type { Runtime } from './runtime.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor(diffMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function eventTagClass(type: string): string {
  if (type === 'invoice.completed') return 'tag-good';
  if (type === 'invoice.expired' || type === 'invoice.canceled') return 'tag-warn';
  return 'tag-info';
}

export async function renderDashboard(runtime: Runtime): Promise<string> {
  const invoices = await runtime.listInvoices();
  const webhooks = await runtime.webhookEndpointStore.list();

  const sortedInvoices = [...invoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentInvoices = sortedInvoices.slice(0, 8);

  const recentEvents = [] as Array<{
    id: string;
    type: string;
    createdAt: string;
    invoiceId: string;
    label: string;
  }>;

  for (const invoice of recentInvoices) {
    const events = await runtime.getEventsByInvoice(invoice.id);
    for (const event of events) {
      recentEvents.push({
        id: event.id,
        type: event.type,
        createdAt: event.createdAt,
        invoiceId: invoice.id,
        label: String(invoice.metadata?.orderId ?? invoice.id.slice(0, 8)),
      });
    }
  }

  recentEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const open = invoices.filter((invoice) => invoice.status === 'open').length;
  const completed = invoices.filter((invoice) => invoice.status === 'completed').length;
  const terminal = invoices.filter((invoice) => invoice.status === 'expired' || invoice.status === 'canceled').length;

  const invoiceRows = recentInvoices.length === 0
    ? '<tr><td colspan="5" class="empty">No invoices yet</td></tr>'
    : recentInvoices.map((invoice) => `
      <tr>
        <td><span class="mono">${escapeHtml(invoice.id.slice(0, 8))}</span></td>
        <td><span class="badge badge-${escapeHtml(invoice.status)}">${escapeHtml(invoice.status)}</span></td>
        <td>${escapeHtml(String(invoice.metadata?.orderId ?? '')) || '<span class="muted">none</span>'}</td>
        <td><span class="mono">${escapeHtml(String((invoice as unknown as { recipientAccount?: string }).recipientAccount ?? ''))}</span></td>
        <td>${escapeHtml(relativeTime(invoice.createdAt))}</td>
      </tr>
    `).join('');

  const eventRows = recentEvents.length === 0
    ? '<tr><td colspan="4" class="empty">No events yet</td></tr>'
    : recentEvents.slice(0, 20).map((event) => `
      <tr>
        <td><span class="tag ${eventTagClass(event.type)}">${escapeHtml(event.type)}</span></td>
        <td><span class="mono">${escapeHtml(event.label)}</span></td>
        <td>${escapeHtml(new Date(event.createdAt).toLocaleTimeString())}</td>
        <td>${escapeHtml(relativeTime(event.createdAt))}</td>
      </tr>
    `).join('');

  const webhookRows = webhooks.length === 0
    ? '<tr><td colspan="4" class="empty">No sinks attached yet</td></tr>'
    : webhooks.map((endpoint) => `
      <tr>
        <td><span class="mono">${escapeHtml(endpoint.id.slice(0, 8))}</span></td>
        <td>${escapeHtml(endpoint.url)}</td>
        <td>${escapeHtml(endpoint.eventTypes.join(', '))}</td>
        <td>${escapeHtml(new Date(endpoint.createdAt).toLocaleTimeString())}</td>
      </tr>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RaiFlow Runtime Dashboard</title>
  <meta http-equiv="refresh" content="5">
  <style>
    :root {
      --bg: #0a0a0c;
      --panel: rgba(20, 20, 24, 0.72);
      --border: rgba(255,255,255,0.08);
      --text: #ffffff;
      --muted: #9494a0;
      --accent: #4a90e2;
      --good: #2ecc71;
      --warn: #f1c40f;
      --bad: #e74c3c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      min-height: 100vh;
    }
    .shell {
      max-width: 1280px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 20px;
      backdrop-filter: blur(16px);
      box-shadow: 0 18px 40px rgba(0,0,0,0.35);
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      flex-wrap: wrap;
    }
    .hero h1 { margin: 0; font-size: 1.9rem; }
    .hero p { margin: 6px 0 0; color: var(--muted); }
    .status {
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.05);
      font-weight: 600;
    }
    .grid {
      display: grid;
      gap: 20px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .stat h2 {
      margin: 0 0 10px;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
    }
    .value {
      font-size: 2.6rem;
      font-weight: 700;
      letter-spacing: -0.05em;
    }
    .spark {
      margin-top: 12px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(74,144,226,0.25), rgba(74,144,226,0.75));
    }
    .two-col {
      display: grid;
      gap: 20px;
      grid-template-columns: 1.2fr 1fr;
    }
    .section-title {
      margin: 0 0 14px;
      font-size: 1rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    th, td {
      padding: 12px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      text-align: left;
    }
    th {
      color: var(--muted);
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
    }
    tr:last-child td { border-bottom: none; }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-all;
    }
    .badge, .tag {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 700;
    }
    .badge-open { background: rgba(74,144,226,0.15); color: #84b8ff; }
    .badge-completed { background: rgba(46,204,113,0.15); color: #6ee7a0; }
    .badge-expired, .badge-canceled { background: rgba(231,76,60,0.12); color: #ff9a8e; }
    .tag-info { background: rgba(74,144,226,0.15); color: #84b8ff; }
    .tag-good { background: rgba(46,204,113,0.15); color: #6ee7a0; }
    .tag-warn { background: rgba(241,196,15,0.15); color: #f5d76e; }
    .muted, .empty { color: var(--muted); }
    .footer {
      color: var(--muted);
      font-size: 0.8rem;
      text-align: right;
    }
    @media (max-width: 960px) {
      .grid, .two-col { grid-template-columns: 1fr; }
      body { padding: 14px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="panel hero">
      <div>
        <h1>RaiFlow Runtime Dashboard</h1>
        <p>Built-in status view for runtime health, attached sinks, invoices, and recent domain events.</p>
      </div>
      <div class="status">Runtime online</div>
    </section>

    <section class="grid">
      <article class="panel stat">
        <h2>Open Invoices</h2>
        <div class="value">${open}</div>
        <div class="spark"></div>
      </article>
      <article class="panel stat">
        <h2>Completed</h2>
        <div class="value">${completed}</div>
        <div class="spark"></div>
      </article>
      <article class="panel stat">
        <h2>Attached Sinks</h2>
        <div class="value">${webhooks.length}</div>
        <div class="spark"></div>
      </article>
    </section>

    <section class="two-col">
      <article class="panel">
        <h2 class="section-title">Recent Domain Events</h2>
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Resource</th>
              <th>Clock Time</th>
              <th>Relative</th>
            </tr>
          </thead>
          <tbody>${eventRows}</tbody>
        </table>
      </article>

      <article class="panel">
        <h2 class="section-title">Recent Invoices</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Order</th>
              <th>Recipient</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${invoiceRows}</tbody>
        </table>
      </article>
    </section>

    <section class="panel">
      <h2 class="section-title">Attached Clients / Webhook Sinks</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Endpoint</th>
            <th>Subscriptions</th>
            <th>Registered</th>
          </tr>
        </thead>
        <tbody>${webhookRows}</tbody>
      </table>
    </section>

    <div class="footer">Auto-refreshes every 5 seconds · ${new Date().toLocaleTimeString()}</div>
  </main>
</body>
</html>`;
}
