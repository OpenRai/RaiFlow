// @openrai/custody — Seed, derivation, signing, PoW, and frontier operations

import type { Account, Send } from '@openrai/model';
import { WorkProvider } from '@openrai/nano-core';
import {
  createBlock,
  deriveAddress,
  derivePublicKey,
  deriveSecretKey,
  signBlock as signBlockRaw,
  computeWork,
} from 'nanocurrency';

export type DerivationPath = { index: number };

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
    previousFrontier: string,
    derivationIndex?: number,
  ): Promise<SignedBlock>;
  generateWork(hash: string, difficulty?: string): Promise<string>;
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
  workProvider?: WorkProvider,
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
      // Frontier-based; actual rep change is done via signChange
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
      previousFrontier: string,
      derivationIndex?: number,
    ): Promise<SignedBlock> {
      return signAndPackage(ZERO_HASH, '0', representative, previousFrontier, derivationIndex);
    },

    async generateWork(hash: string, difficulty?: string): Promise<string> {
      if (workProvider) {
        return workProvider.generate(hash, difficulty ?? 'fffffff800000000');
      }
      const result = await computeWork(hash);
      if (!result) throw new Error('Work generation failed');
      return result;
    },
  };
}
