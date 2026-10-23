import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { xnoDisplay } from '../../../shared/nano-utils.mjs';

export default function CheckoutPage() {
  const router = useRouter();
  const invoiceId = typeof router.query.id === 'string' ? router.query.id : undefined;
  const [invoice, setInvoice] = useState(null);
  const [events, setEvents] = useState([]);
  const eventsRef = useRef([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!invoiceId) return undefined;
    let stopped = false;
    let pollingEvents = false;
    const cursorKey = `raiflow-checkout-cursor:${invoiceId}`;

    try {
      const saved = JSON.parse(window.localStorage.getItem(cursorKey) ?? 'null');
      if (Array.isArray(saved?.events)) {
        eventsRef.current = saved.events.slice(-100);
        setEvents(eventsRef.current);
      }
    } catch {
      window.localStorage.removeItem(cursorKey);
    }

    async function refreshInvoice() {
      try {
        const response = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`);
        if (!response.ok) throw new Error('Could not load this payment request');
        setInvoice(await response.json());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }

    async function refreshEvents() {
      if (pollingEvents) return;
      pollingEvents = true;
      try {
        const saved = JSON.parse(window.localStorage.getItem(cursorKey) ?? 'null');
        const after = typeof saved?.cursor === 'string' ? saved.cursor : undefined;
        const query = new URLSearchParams();
        if (after) query.set('after', after);
        const response = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/events?${query}`);
        if (!response.ok) return;
        const page = await response.json();
        if (stopped) return;
        const seen = new Set(eventsRef.current.map((event) => event.id));
        const nextEvents = [...eventsRef.current, ...page.data.filter((event) => !seen.has(event.id))].slice(-100);
        eventsRef.current = nextEvents;
        setEvents(nextEvents);
        if (page.nextCursor) {
          window.localStorage.setItem(cursorKey, JSON.stringify({ cursor: page.nextCursor, events: nextEvents }));
        }
      } catch {
        // The next poll resumes from the last stored sequence.
      } finally {
        pollingEvents = false;
      }
    }

    void refreshInvoice();
    void refreshEvents();
    const invoiceTimer = setInterval(refreshInvoice, 10_000);
    const eventTimer = setInterval(refreshEvents, 2_000);
    return () => {
      stopped = true;
      clearInterval(invoiceTimer);
      clearInterval(eventTimer);
    };
  }, [invoiceId]);

  if (error) return <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto' }}>{error}</main>;
  if (!invoice) return <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto' }}>Loading payment request…</main>;

  const notices = events.flatMap((event) => {
    if (event.type !== 'deposit.observed') return [];
    const deposit = event.data.deposit;
    if (deposit?.disposition === 'partial') return ['A partial payment was received. The remaining amount is still due.'];
    if (deposit?.disposition === 'excess') return ['An excess payment was received. Review the extra amount before fulfilling the order.'];
    if (deposit?.disposition === 'late') return ['A late payment was received after this invoice closed. It does not reopen the invoice.'];
    return [];
  });

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '3rem auto', padding: '0 1rem' }}>
      <h1>Payment request</h1>
      <p>Order: {invoice.metadata?.orderId ?? invoice.id}</p>
      <p>Status: <strong>{invoice.status}</strong></p>
      <p>Amount: <strong>{xnoDisplay(invoice.expectedAmountRaw)} XNO</strong></p>
      <p>Confirmed: {xnoDisplay(invoice.receivedAmountRaw)} XNO</p>
      <p>Send XNO from any wallet to:</p>
      <p style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{invoice.payAddress}</p>
      <p>Invoice status and payment events are fetched by the server. The runtime API key is never sent to this page.</p>

      <h2>Payment updates</h2>
      {notices.map((notice, index) => <p key={`${notice}-${index}`} role="status">{notice}</p>)}
      {events.length === 0 ? <p>Waiting for the first event…</p> : (
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              <time>{new Date(event.timestamp).toLocaleString()}</time> — {event.type}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
