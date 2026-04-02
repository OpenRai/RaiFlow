import type { RaiFlowConfig } from '@openrai/config';
import type { Runtime } from './runtime.js';
import type { RuntimeMetricsSnapshot } from './monitoring.js';

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function eventTagClass(type: string): string {
  if (type === 'invoice.completed') return 'tag-good';
  if (type === 'invoice.expired' || type === 'invoice.canceled') return 'tag-warn';
  return 'tag-info';
}

function requestTagClass(status: number): string {
  if (status >= 500) return 'tag-warn';
  if (status >= 400) return 'tag-bad';
  return 'tag-good';
}

function latencyBars(metrics: RuntimeMetricsSnapshot | undefined): string {
  const requests = metrics?.recentRequests ?? [];
  if (requests.length === 0) return '<div class="empty">No recent request data yet</div>';

  const max = Math.max(...requests.map((request) => request.durationMs), 1);
  return `
    <div class="sparkline">
      ${requests.map((request) => {
        const height = Math.max(10, Math.round((request.durationMs / max) * 44));
        return `<span class="sparkbar" title="${escapeHtml(`${request.method} ${request.path} ${request.status} ${formatDuration(request.durationMs)}`)}" style="height:${height}px"></span>`;
      }).join('')}
    </div>
  `;
}

function configRows(config: RaiFlowConfig | undefined): string {
  if (!config) {
    return '<tr><td colspan="2" class="empty">No config available</td></tr>';
  }

  const rows: Array<[string, string]> = [
    ['daemon.host', config.daemon.host],
    ['daemon.port', String(config.daemon.port)],
    ['daemon.apiKeyConfigured', config.daemon.apiKey ? 'yes' : 'no'],
    ['storage.driver', config.storage.driver],
    ['storage.path', config.storage.path],
    ['logging.level', config.logging.level],
    ['logging.format', config.logging.format],
    ['nano.nodes.count', String(config.nano.nodes.length)],
    ['nano.nodes.rpc', config.nano.nodes.map((node) => node.rpc).join(', ') || 'none'],
    ['nano.nodes.ws', config.nano.nodes.map((node) => node.ws).join(', ') || 'none'],
    ['custody.configured', config.custody ? 'yes' : 'no'],
    ['invoices.defaultExpirySeconds', String(config.invoices.defaultExpirySeconds)],
    ['invoices.autoSweep', config.invoices.autoSweep ? 'yes' : 'no'],
    ['invoices.sweepDestinationConfigured', config.invoices.sweepDestination ? 'yes' : 'no'],
    ['webhooks.configured.count', String(config.webhooks.length)],
  ];

  return rows.map(([key, value]) => `
    <tr>
      <td><span class="mono">${escapeHtml(key)}</span></td>
      <td>${escapeHtml(value)}</td>
    </tr>
  `).join('');
}

function systemRows(metrics: RuntimeMetricsSnapshot | undefined): string {
  if (!metrics) {
    return '<tr><td colspan="2" class="empty">No runtime metrics available</td></tr>';
  }

  const rows: Array<[string, string]> = [
    ['process.pid', String(metrics.pid)],
    ['process.startedAt', metrics.startedAt],
    ['process.uptime', relativeTime(metrics.startedAt)],
    ['process.dbPath', metrics.dbPath],
    ['process.migrations', metrics.migrations.join(', ') || 'none'],
    ['requests.total', String(metrics.requestCount)],
    ['requests.2xx', String(metrics.status2xx)],
    ['requests.4xx', String(metrics.status4xx)],
    ['requests.5xx', String(metrics.status5xx)],
    ['requests.avgLatency', formatDuration(metrics.avgRequestMs)],
    ['requests.lastAt', metrics.lastRequestAt ?? 'never'],
    ['memory.rss', formatBytes(metrics.memoryRssBytes)],
    ['memory.heapUsed', formatBytes(metrics.memoryHeapUsedBytes)],
    ['memory.heapTotal', formatBytes(metrics.memoryHeapTotalBytes)],
  ];

  return rows.map(([key, value]) => `
    <tr>
      <td><span class="mono">${escapeHtml(key)}</span></td>
      <td>${escapeHtml(value)}</td>
    </tr>
  `).join('');
}

export async function renderDashboard(
  runtime: Runtime,
  options?: {
    view?: string;
    config?: RaiFlowConfig;
    metrics?: RuntimeMetricsSnapshot;
  },
): Promise<string> {
  const view = options?.view === 'config' ? 'config' : 'overview';
  const invoices = await runtime.listInvoices();
  const webhooks = await runtime.webhookEndpointStore.list();
  const metrics = options?.metrics;

  const sortedInvoices = [...invoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentInvoices = sortedInvoices.slice(0, 8);

  const recentEvents = [] as Array<{
    id: string;
    type: string;
    createdAt: string;
    label: string;
  }>;

  for (const invoice of recentInvoices) {
    const events = await runtime.getEventsByInvoice(invoice.id);
    for (const event of events) {
      recentEvents.push({
        id: event.id,
        type: event.type,
        createdAt: event.createdAt,
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
    : recentInvoices.map((invoice) => {
      const recipientAccount = String((invoice as unknown as { recipientAccount?: string }).recipientAccount ?? '');
      const orderLabel = String(invoice.metadata?.orderId ?? '');

      return `
        <tr>
          <td><span class="mono">${escapeHtml(invoice.id.slice(0, 8))}</span></td>
          <td><span class="badge badge-${escapeHtml(invoice.status)}">${escapeHtml(invoice.status)}</span></td>
          <td>${orderLabel === '' ? '<span class="muted">none</span>' : escapeHtml(orderLabel)}</td>
          <td><span class="mono">${escapeHtml(recipientAccount)}</span></td>
          <td>${escapeHtml(relativeTime(invoice.createdAt))}</td>
        </tr>
      `;
    }).join('');

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

  const requestRows = !metrics || metrics.recentRequests.length === 0
    ? '<tr><td colspan="5" class="empty">No recent requests yet</td></tr>'
    : metrics.recentRequests.map((request) => `
      <tr>
        <td><span class="mono">${escapeHtml(request.method)}</span></td>
        <td><span class="mono">${escapeHtml(request.path)}</span></td>
        <td><span class="tag ${requestTagClass(request.status)}">${request.status}</span></td>
        <td>${escapeHtml(formatDuration(request.durationMs))}</td>
        <td>${escapeHtml(relativeTime(request.at))}</td>
      </tr>
    `).join('');

  const nav = `
    <nav class="tabs">
      <a class="tab ${view === 'overview' ? 'tab-active' : ''}" href="/">Overview</a>
      <a class="tab ${view === 'config' ? 'tab-active' : ''}" href="/?view=config">Config</a>
    </nav>
  `;

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
      max-width: 1380px;
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
    .tabs {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .tab {
      text-decoration: none;
      color: var(--muted);
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
      font-size: 0.88rem;
      font-weight: 600;
    }
    .tab-active {
      color: var(--text);
      background: rgba(74,144,226,0.16);
      border-color: rgba(74,144,226,0.45);
    }
    .grid {
      display: grid;
      gap: 20px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .stat h2 {
      margin: 0 0 10px;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
    }
    .value {
      font-size: 2.3rem;
      font-weight: 700;
      letter-spacing: -0.05em;
    }
    .subvalue {
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .spark {
      margin-top: 12px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(74,144,226,0.25), rgba(74,144,226,0.75));
    }
    .sparkline {
      display: flex;
      align-items: end;
      gap: 3px;
      min-height: 48px;
      margin-top: 12px;
    }
    .sparkbar {
      width: 10px;
      border-radius: 999px 999px 2px 2px;
      background: linear-gradient(180deg, rgba(74,144,226,0.9), rgba(74,144,226,0.25));
      display: inline-block;
    }
    .two-col {
      display: grid;
      gap: 20px;
      grid-template-columns: 1.1fr 1fr;
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
    .tag-bad { background: rgba(231,76,60,0.12); color: #ff9a8e; }
    .muted, .empty { color: var(--muted); }
    .footer {
      color: var(--muted);
      font-size: 0.8rem;
      text-align: right;
    }
    @media (max-width: 1100px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .two-col { grid-template-columns: 1fr; }
    }
    @media (max-width: 700px) {
      .grid { grid-template-columns: 1fr; }
      body { padding: 14px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="panel hero">
      <div>
        <h1>RaiFlow Runtime Dashboard</h1>
        <p>Built-in runtime overview, recent domain activity, attached sinks, and effective non-secret configuration.</p>
        ${nav}
      </div>
      <div class="status">Runtime online</div>
    </section>

    ${view === 'overview' ? `
    <section class="grid">
      <article class="panel stat">
        <h2>Uptime</h2>
        <div class="value">${metrics ? escapeHtml(relativeTime(metrics.startedAt)) : 'n/a'}</div>
        <div class="subvalue">pid ${metrics ? metrics.pid : 'n/a'}</div>
        <div class="spark"></div>
      </article>
      <article class="panel stat">
        <h2>Total Requests</h2>
        <div class="value">${metrics ? metrics.requestCount : 0}</div>
        <div class="subvalue">avg latency ${metrics ? escapeHtml(formatDuration(metrics.avgRequestMs)) : 'n/a'}</div>
        ${latencyBars(metrics)}
      </article>
      <article class="panel stat">
        <h2>Open Invoices</h2>
        <div class="value">${open}</div>
        <div class="subvalue">${completed} completed · ${terminal} terminal</div>
        <div class="spark"></div>
      </article>
      <article class="panel stat">
        <h2>Attached Sinks</h2>
        <div class="value">${webhooks.length}</div>
        <div class="subvalue">last request ${metrics?.lastRequestAt ? escapeHtml(relativeTime(metrics.lastRequestAt)) : 'never'}</div>
        <div class="spark"></div>
      </article>
    </section>

    <section class="two-col">
      <article class="panel">
        <h2 class="section-title">Recent HTTP Requests</h2>
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th>Path</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${requestRows}</tbody>
        </table>
      </article>

      <article class="panel">
        <h2 class="section-title">Process Metrics</h2>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>${systemRows(metrics)}</tbody>
        </table>
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
    ` : `
    <section class="panel">
      <h2 class="section-title">Effective Non-Secret Configuration</h2>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>${configRows(options?.config)}</tbody>
      </table>
      <div class="footer" style="margin-top: 16px; text-align: left;">
        Secrets are not shown here. This view only exposes effective non-secret values and presence flags.
      </div>
    </section>
    `}

    <div class="footer">Auto-refreshes every 5 seconds · ${new Date().toLocaleTimeString()}</div>
  </main>
</body>
</html>`;
}
