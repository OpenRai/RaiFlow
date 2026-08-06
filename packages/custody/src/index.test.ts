import { describe, expect, it, vi } from 'vitest';
import {
  createOwsCustodyProvider,
  createProviderCustodyEngine,
  type OwsBindings,
} from './index.js';

const ZERO_ADDRESS = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';

function bindings(overrides: Partial<OwsBindings> = {}): OwsBindings {
  return {
    deriveWalletAddress: vi.fn().mockReturnValue('nano_1derived'),
    signTransaction: vi.fn().mockReturnValue({ signature: 'ab'.repeat(64) }),
    ...overrides,
  };
}

describe('OWS custody provider', () => {
  it('derives and signs by wallet index without exposing key material', () => {
    const sdk = bindings();
    const provider = createOwsCustodyProvider({
      bindings: sdk,
      wallet: 'runtime-wallet',
      credential: 'ows_key_redacted',
      vaultPath: '/vault',
    });

    expect(provider.deriveAddress(2 ** 31)).toBe('nano_1derived');
    expect(provider.signStateBlock('00'.repeat(176), 2 ** 31)).toBe('AB'.repeat(64));
    expect(sdk.deriveWalletAddress).toHaveBeenCalledWith(
      'runtime-wallet', 'nano', 'ows_key_redacted', 2 ** 31, '/vault',
    );
  });

  it('fails closed on malformed signing payloads or signatures', () => {
    const provider = createOwsCustodyProvider({ bindings: bindings(), wallet: 'wallet' });
    expect(() => provider.signStateBlock('00', 0)).toThrow('176 bytes');

    const badSignature = createOwsCustodyProvider({
      bindings: bindings({ signTransaction: vi.fn().mockReturnValue({ signature: 'bad' }) }),
      wallet: 'wallet',
    });
    expect(() => badSignature.signStateBlock('00'.repeat(176), 0)).toThrow('invalid Nano signature');
  });

  it('reports readiness failures without throwing', async () => {
    const provider = createOwsCustodyProvider({
      bindings: bindings({ deriveWalletAddress: vi.fn(() => { throw new Error('vault unavailable'); }) }),
      wallet: 'wallet',
    });
    await expect(provider.readiness()).resolves.toEqual({ ready: false, error: 'vault unavailable' });
  });

  it('builds provider-backed state blocks without loading raw seed material', async () => {
    const signStateBlock = vi.fn().mockReturnValue('AB'.repeat(64));
    const stateBlockSigningPayload = vi.fn().mockReturnValue('00'.repeat(176));
    const hashStateBlock = vi.fn().mockReturnValue('CD'.repeat(32));
    const engine = createProviderCustodyEngine({
      provider: {
        deriveAddress: vi.fn().mockReturnValue(ZERO_ADDRESS),
        signStateBlock,
        readiness: vi.fn().mockResolvedValue({ ready: true }),
      },
      representative: ZERO_ADDRESS,
      codec: { stateBlockSigningPayload, hashStateBlock },
    });

    expect(() => engine.loadSeed('not-accepted')).toThrow('Raw seeds are not accepted');
    const signed = await engine.signChange(
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      '42',
      '11'.repeat(32),
      2 ** 31,
    );

    expect(JSON.parse(signed.contents)).toMatchObject({
      type: 'state',
      account: ZERO_ADDRESS,
      representative: ZERO_ADDRESS,
      balance: '42',
      link: '0'.repeat(64),
      signature: 'AB'.repeat(64),
    });
    expect(signStateBlock).toHaveBeenCalledWith('00'.repeat(176), 2 ** 31);
    expect(signed.hash).toBe('CD'.repeat(32));
  });
});
