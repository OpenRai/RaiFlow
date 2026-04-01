// Checkout page — shows invoice status and polls for payment completion
// force-dynamic: this page always renders on-demand, never statically
export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';

const RAIFLOW_URL = process.env.NEXT_PUBLIC_RAIFLOW_URL ?? 'http://localhost:3100';

const RAW_PER_XNO = 1_000_000_000_000_000_000_000_000_000n;

function xnoDisplay(raw) {
  if (!raw) return '0';
  const n = BigInt(raw);
  const intPart = n / RAW_PER_XNO;
  const fracPart = (n % RAW_PER_XNO).toString().padStart(30, '0').replace(/0+$/, '');
  if (fracPart === '') return intPart.toString();
  return `${intPart}.${fracPart}`.replace(/\.$/, '');
}

function truncate(addr) {
  if (!addr || addr.length < 20) return addr ?? '?';
  return addr.slice(0, 13) + '…' + addr.slice(-6);
}

export default function CheckoutPage({ params }) {
  const id = params?.id;
  if (!id) return null;
  const [invoice, setInvoice] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [completed, setCompleted] = useState(false);

  // Fetch invoice state
  async function fetchInvoice() {
    try {
      const res = await fetch(`/api/invoice/${id}`);
      if (!res.ok) throw new Error('Invoice not found');
      const data = await res.json();
      setInvoice(data);
      if (data.status === 'completed') setCompleted(true);
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  // Poll events
  async function pollEvents() {
    try {
      const res = await fetch(`/api/invoice/${id}/events`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.events.length > events.length) {
        setEvents(data.events);
        // Check for completion
        const latestCompleted = data.events.find(
          (e) => e.type === 'invoice.completed',
        );
        if (latestCompleted) setCompleted(true);
      }
    } catch {
      // Ignore polling errors
    }
  }

  useEffect(() => {
    fetchInvoice();
  }, [id]);

  useEffect(() => {
    if (loading) return;
    const timer = setInterval(pollEvents, 2000);
    return () => clearInterval(timer);
  }, [loading, events.length]);

  if (loading) {
    return (
      <div style={{ fontFamily: 'system-ui', maxWidth: '540px', margin: '5rem auto', padding: '0 1rem', color: '#888' }}>
        Loading invoice…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ fontFamily: 'system-ui', maxWidth: '540px', margin: '5rem auto', padding: '0 1rem', color: '#f87171' }}>
        Error: {error}
      </div>
    );
  }

  const expectedXno = xnoDisplay(invoice.expectedAmountRaw);
  const confirmedXno = xnoDisplay(invoice.confirmedAmountRaw);

  return (
    <div style={{
      fontFamily: 'system-ui, sans-serif',
      maxWidth: '540px',
      margin: '3rem auto',
      padding: '0 1rem',
      background: '#0f0f0f',
      color: '#e0e0e0',
      minHeight: '100vh',
    }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>
        <a href="/" style={{ color: '#60a5fa', textDecoration: 'none' }}>←</a> Payment Checkout
      </h1>
      {invoice.metadata?.orderId && (
        <p style={{ color: '#666', fontSize: '0.875rem', marginBottom: '2rem' }}>
          Order: {invoice.metadata.orderId}
        </p>
      )}

      {/* Status card */}
      <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '8px', padding: '1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <span style={{
            display: 'inline-block',
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: completed ? '#4ade80' : invoice.status === 'expired' ? '#fb923c' : invoice.status === 'canceled' ? '#a1a1aa' : '#60a5fa',
          }} />
          <span style={{ fontWeight: '600', textTransform: 'capitalize' }}>
            {completed ? 'Payment Complete!' : invoice.status}
          </span>
        </div>

        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: '0.25rem' }}>
          Amount Due
        </div>
        <div style={{ fontSize: '1.5rem', fontWeight: '700', fontFamily: 'monospace', marginBottom: '1.5rem' }}>
          {expectedXno} <span style={{ fontSize: '1rem', color: '#888', fontWeight: '400' }}>XNO</span>
        </div>

        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: '0.25rem' }}>
          Send to Nano address
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: '0.9rem', wordBreak: 'break-all', color: '#60a5fa', marginBottom: '1.5rem' }}>
          {invoice.recipientAccount}
        </div>

        {invoice.status !== 'completed' && invoice.status !== 'expired' && invoice.status !== 'canceled' && (
          <div style={{ marginTop: '1rem', padding: '1rem', background: '#111', borderRadius: '6px', fontSize: '0.875rem' }}>
            <div style={{ color: '#888', marginBottom: '0.5rem' }}>Confirmed so far</div>
            <div style={{ fontFamily: 'monospace', color: '#4ade80' }}>
              {confirmedXno} / {expectedXno} XNO
            </div>
          </div>
        )}
      </div>

      {/* Event log */}
      <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '8px', padding: '1.5rem' }}>
        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: '1rem' }}>
          Live Status
        </div>
        {events.length === 0 && !completed && (
          <div style={{ color: '#666', fontSize: '0.875rem', fontStyle: 'italic' }}>
            Waiting for payment… Send XNO to the address above.
          </div>
        )}
        {events.map((event) => (
          <div key={event.id} style={{ fontSize: '0.875rem', padding: '0.5rem 0', borderBottom: '1px solid #2a2a2a' }}>
            <span style={{ color: '#60a5fa', fontWeight: '600' }}>{event.type}</span>
            <span style={{ color: '#666', marginLeft: '0.5rem' }}>
              {new Date(event.createdAt).toLocaleTimeString()}
            </span>
          </div>
        ))}
        {completed && (
          <div style={{ color: '#4ade80', fontSize: '0.875rem', fontWeight: '600', paddingTop: '0.5rem' }}>
            ✓ Payment received and verified. Thank you!
          </div>
        )}
      </div>
    </div>
  );
}
