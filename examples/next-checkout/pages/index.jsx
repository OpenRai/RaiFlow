// Landing page — create an invoice

export default function Home() {
  const defaultRecipientAccount = process.env.NEXT_PUBLIC_RAIFLOW_RECIPIENT_ACCOUNT ?? 'nano_3strnmn7h9b7oghxa6h9ckrpf5r454fsobpicixps6xwiwc5q4hat7wjbpqz';

  return (
    <div style={{
      fontFamily: 'system-ui, sans-serif',
      maxWidth: '540px',
      margin: '5rem auto',
      padding: '0 1rem',
    }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
        RaiFlow Next.js Checkout
      </h1>
      <p style={{ color: '#888', marginBottom: '2rem' }}>
        Create a Nano invoice and watch your payment complete in real time.
      </p>

      <div style={{
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: '8px',
        padding: '2rem',
      }}>
        <form action="/api/create-invoice" method="POST">
          <label style={{ display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: '0.5rem' }}>
            Recipient Account
          </label>
          <input
            type="text"
            name="recipientAccount"
            defaultValue={defaultRecipientAccount}
            style={{
              width: '100%',
              padding: '0.75rem',
              fontSize: '1rem',
              background: '#111',
              border: '1px solid #333',
              borderRadius: '6px',
              color: '#e0e0e0',
              marginBottom: '1rem',
              boxSizing: 'border-box',
            }}
          />

          <label style={{ display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: '0.5rem' }}>
            Amount (XNO)
          </label>
          <input
            type="text"
            name="amount"
            placeholder="0.50"
            required
            pattern="[0-9]+(\.[0-9]+)?"
            style={{
              width: '100%',
              padding: '0.75rem',
              fontSize: '1rem',
              background: '#111',
              border: '1px solid #333',
              borderRadius: '6px',
              color: '#e0e0e0',
              marginBottom: '1rem',
              boxSizing: 'border-box',
            }}
          />

          <label style={{ display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: '0.5rem' }}>
            Order ID (optional)
          </label>
          <input
            type="text"
            name="orderId"
            placeholder="order-12345"
            style={{
              width: '100%',
              padding: '0.75rem',
              fontSize: '1rem',
              background: '#111',
              border: '1px solid #333',
              borderRadius: '6px',
              color: '#e0e0e0',
              marginBottom: '1.5rem',
              boxSizing: 'border-box',
            }}
          />

          <button
            type="submit"
            style={{
              width: '100%',
              padding: '0.875rem',
              fontSize: '1rem',
              fontWeight: '600',
              background: '#1d4ed8',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Create Invoice
          </button>
        </form>
      </div>
    </div>
  );
}
