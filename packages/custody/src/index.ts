// @openrai/custody — Seed, derivation, signing, PoW, and frontier operations

import type { Account, Send } from '@openrai/model';
import { NanoAddress, type StateBlock } from '@openrai/nano-core';
import {
  createBlock,
  deriveAddress,
  derivePublicKey,
  deriveSecretKey,
  signBlock as signBlockRaw,
} from 'nanocurrency';
import { generateWork as rspowGenerate, WorkType } from 'nano-rspow-node';

export type DerivationPath = { index: number };

export interface CustodyProvider {
  deriveAddress(index: number): string;
  signStateBlock(signingPayloadHex: string, index: number): string;
  readiness(): Promise<{ ready: boolean; error?: string }>;
}

export interface OwsBindings {
  deriveWalletAddress(
    wallet: string,
    chain: string,
    credential?: string,
    index?: number,
    vaultPath?: string,
  ): string;
  signTransaction(
    wallet: string,
    chain: string,
    transactionHex: string,
    credential?: string,
    index?: number,
    vaultPath?: string,
  ): { signature: string };
}

export interface OwsCustodyProviderOptions {
  bindings: OwsBindings;
  wallet: string;
  credential?: string;
  vaultPath?: string;
}

export function createOwsCustodyProvider(options: OwsCustodyProviderOptions): CustodyProvider {
  const derive = (index: number): string => options.bindings.deriveWalletAddress(
    options.wallet,
    'nano',
    options.credential,
    index,
    options.vaultPath,
  );

  return {
    deriveAddress(index) {
      return derive(index);
    },

    signStateBlock(signingPayloadHex, index) {
      if (!/^[0-9a-f]{352}$/i.test(signingPayloadHex)) {
        throw new Error('Nano state-block signing payload must be exactly 176 bytes of hexadecimal data');
      }
      const result = options.bindings.signTransaction(
        options.wallet,
        'nano',
        signingPayloadHex,
        options.credential,
        index,
        options.vaultPath,
      );
      if (!/^[0-9a-f]{128}$/i.test(result.signature)) {
        throw new Error('OWS returned an invalid Nano signature');
      }
      return result.signature.toUpperCase();
    },

    async readiness() {
      try {
        derive(0);
        return { ready: true };
      } catch (error) {
        return {
          ready: false,
          error: error instanceof Error ? error.message : 'OWS custody provider unavailable',
        };
      }
    },
  };
}

export interface NanoCoreBlockCodec {
  stateBlockSigningPayload(block: StateBlock): string;
  hashStateBlock(block: StateBlock): string;
}

export interface ProviderCustodyConfig {
  provider: CustodyProvider;
  representative: string;
  codec: NanoCoreBlockCodec;
}

/** Production custody engine backed by a key-isolating provider such as OWS. */
export function createProviderCustodyEngine(config: ProviderCustodyConfig): CustodyEngine {
  const ZERO_HASH = '0'.repeat(64);

  async function signBlock(
    account: string,
    previous: string,
    representative: string,
    balance: string,
    link: string,
    derivationIndex: number,
  ): Promise<SignedBlock> {
    const block: StateBlock = {
      type: 'state',
      account: NanoAddress.parse(account).toString(),
      previous: previous === '' ? ZERO_HASH : previous.toUpperCase(),
      representative: NanoAddress.parse(representative).toString(),
      balance,
      link: link.toUpperCase(),
    };
    const signature = config.provider.signStateBlock(
      config.codec.stateBlockSigningPayload(block),
      derivationIndex,
    );
    const hash = config.codec.hashStateBlock(block);
    return {
      contents: JSON.stringify({ ...block, signature }),
      signature,
      hash,
    };
  }

  return {
    loadSeed(): void {
      throw new Error('Raw seeds are not accepted by provider-backed custody');
    },
    deriveInvoiceAddress(path) {
      return config.provider.deriveAddress(path.index);
    },
    deriveManagedAccount(path) {
      return config.provider.deriveAddress(path.index);
    },
    getNextInvoiceIndex() { return 0; },
    getNextManagedIndex() { return 2 ** 31; },
    async setRepresentative() {
      throw new Error('Representative changes must be signed and published with signChange');
    },
    async signSend(account, destination, resultingBalanceRaw, previousFrontier, derivationIndex) {
      if (derivationIndex === undefined) throw new Error('derivation index is required for signing');
      return signBlock(
        account,
        previousFrontier,
        config.representative,
        resultingBalanceRaw,
        NanoAddress.parse(destination).publicKey,
        derivationIndex,
      );
    },
    async signReceive(account, sourceHash, resultingBalanceRaw, previousFrontier, derivationIndex) {
      if (derivationIndex === undefined) throw new Error('derivation index is required for signing');
      return signBlock(
        account,
        previousFrontier,
        config.representative,
        resultingBalanceRaw,
        sourceHash,
        derivationIndex,
      );
    },
    async signChange(account, representative, currentBalanceRaw, previousFrontier, derivationIndex) {
      if (derivationIndex === undefined) throw new Error('derivation index is required for signing');
      return signBlock(
        account,
        previousFrontier,
        representative,
        currentBalanceRaw,
        ZERO_HASH,
        derivationIndex,
      );
    },
    async generateWork(hash) {
      return rspowGenerate(hash, WorkType.Send);
    },
    async generateReceiveWork(hash) {
      return rspowGenerate(hash, WorkType.Receive);
    },
  };
}

export interface CustodyConfig {
  seed: string;
  representative: string;
  derivationStartIndex: {
    invoice: number;
    managed: number;
  };
}

export interface CustodyEngine {
  loadSeed(seed: string): void;
  deriveInvoiceAddress(path: DerivationPath): string;
  deriveManagedAccount(path: DerivationPath): string;
  getNextInvoiceIndex(): number;
  getNextManagedIndex(): number;
  setRepresentative(account: string, rep: string): Promise<void>;
  signSend(
    account: string,
    destination: string,
    amountRaw: string,
    previousFrontier: string,
    derivationIndex?: number,
  ): Promise<SignedBlock>;
  signReceive(
    account: string,
    sourceHash: string,
    amountRaw: string,
    previousFrontier: string,
    derivationIndex?: number,
  ): Promise<SignedBlock>;
  signChange(
    account: string,
    representative: string,
    currentBalanceRaw: string,
    previousFrontier: string,
    derivationIndex?: number,
  ): Promise<SignedBlock>;
  generateWork(hash: string): Promise<string>;
  generateReceiveWork(hash: string): Promise<string>;
}

export interface SignedBlock {
  contents: string;
  signature: string;
  hash: string;
}

export interface AccountFrontier {
  accountId: string;
  frontier: string;
  updatedAt: string;
}

export interface FrontierStore {
  get(accountId: string): Promise<AccountFrontier | undefined>;
  upsert(frontier: AccountFrontier): Promise<void>;
}

export function createCustodyEngine(
  config: CustodyConfig,
): CustodyEngine {
  let seed: string | null = null;
  let nextInvoiceIndex = config.derivationStartIndex.invoice;
  let nextManagedIndex = config.derivationStartIndex.managed;

  function addressFromPublicKey(publicKey: string): string {
    return deriveAddress(publicKey);
  }

  const ZERO_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  function deriveAddressFromPath(path: DerivationPath): string {
    if (!seed) throw new Error('Seed not loaded');
    const secretKey = deriveSecretKey(seed, path.index);
    const publicKey = derivePublicKey(secretKey);
    return addressFromPublicKey(publicKey);
  }

  function signAndPackage(
    link: string,
    balance: string,
    representative: string,
    previousFrontier: string,
    derivationIndex?: number,
  ): SignedBlock {
    if (!seed) throw new Error('Seed not loaded');
    const secretKey = deriveSecretKey(seed, derivationIndex ?? nextManagedIndex);
    const block = createBlock(secretKey, {
      previous: previousFrontier === '' ? ZERO_HASH : previousFrontier,
      link,
      balance,
      representative,
      work: null,
    });
    const signature = signBlockRaw({ hash: block.hash, secretKey });
    return { contents: JSON.stringify(block.block), signature, hash: block.hash };
  }

  return {
    loadSeed(seedHex: string): void {
      seed = seedHex;
    },

    deriveInvoiceAddress(path: DerivationPath): string {
      return deriveAddressFromPath(path);
    },

    deriveManagedAccount(path: DerivationPath): string {
      return deriveAddressFromPath(path);
    },

    getNextInvoiceIndex(): number {
      return nextInvoiceIndex;
    },

    getNextManagedIndex(): number {
      return nextManagedIndex;
    },

    async setRepresentative(_account: string, _rep: string): Promise<void> {
      throw new Error('Representative changes must be signed and published with signChange');
    },

    async signSend(
      _account: string,
      destination: string,
      amountRaw: string,
      previousFrontier: string,
      derivationIndex?: number,
    ): Promise<SignedBlock> {
      return signAndPackage(destination, amountRaw, config.representative, previousFrontier, derivationIndex);
    },

    async signReceive(
      _account: string,
      sourceHash: string,
      amountRaw: string,
      previousFrontier: string,
      derivationIndex?: number,
    ): Promise<SignedBlock> {
      return signAndPackage(sourceHash, amountRaw, config.representative, previousFrontier, derivationIndex);
    },

    async signChange(
      _account: string,
      representative: string,
      currentBalanceRaw: string,
      previousFrontier: string,
      derivationIndex?: number,
    ): Promise<SignedBlock> {
      return signAndPackage(ZERO_HASH, currentBalanceRaw, representative, previousFrontier, derivationIndex);
    },

    async generateWork(hash: string): Promise<string> {
      return rspowGenerate(hash, WorkType.Send);
    },

    async generateReceiveWork(hash: string): Promise<string> {
      return rspowGenerate(hash, WorkType.Receive);
    },
  };
}
