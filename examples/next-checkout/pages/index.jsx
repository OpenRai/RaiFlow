export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 560, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Pay with any Nano wallet</h1>
      <p>RaiFlow creates a one-time address for this order. The runtime API key and all wallet operations stay on the server.</p>
      <form action="/api/invoices" method="POST" style={{ display: 'grid', gap: 12 }}>
        <label>
          Order reference
          <input name="orderId" required autoComplete="off" placeholder="order-123" style={{ display: 'block', width: '100%', padding: 10 }} />
        </label>
        <label>
          Amount (XNO)
          <input name="amount" required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,30})?" placeholder="0.25" style={{ display: 'block', width: '100%', padding: 10 }} />
        </label>
        <button type="submit" style={{ padding: 12 }}>Create payment request</button>
      </form>
    </main>
  );
}
