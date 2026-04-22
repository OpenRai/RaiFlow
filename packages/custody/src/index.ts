// @openrai/custody — Seed, derivation, signing, PoW, and frontier operations

import type { Account, Send } from '@openrai/model';
import { WorkProvider } from '@openrai/nano-core';
import {
  createBlock,
  deriveAddress,
  derivePublicKey,
  deriveSecretKey,
  signBlock,
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
  generateWork(hash: string): Promise<string>;
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

  return {
    loadSeed(seedHex: string): void {
      seed = seedHex;
    },

    deriveInvoiceAddress(path: DerivationPath): string {
      if (!seed) throw new Error('Seed not loaded');
      const secretKey = deriveSecretKey(seed, path.index);
      const publicKey = derivePublicKey(secretKey);
      return addressFromPublicKey(publicKey);
    },

    deriveManagedAccount(path: DerivationPath): string {
      if (!seed) throw new Error('Seed not loaded');
      const secretKey = deriveSecretKey(seed, path.index);
      const publicKey = derivePublicKey(secretKey);
      return addressFromPublicKey(publicKey);
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
      if (!seed) throw new Error('Seed not loaded');
      const secretKey = deriveSecretKey(seed, derivationIndex ?? nextManagedIndex);

      const block = createBlock(secretKey, {
        previous: previousFrontier === '' ? '0000000000000000000000000000000000000000000000000000000000000000' : previousFrontier,
        link: destination,
        balance: amountRaw,
        representative: config.representative,
        work: null,
      });

      const signature = signBlock({ hash: block.hash, secretKey });

      return {
        contents: JSON.stringify(block.block),
        signature,
        hash: block.hash,
      };
    },

    async signReceive(
      _account: string,
      sourceHash: string,
      amountRaw: string,
      previousFrontier: string,
      derivationIndex?: number,
    ): Promise<SignedBlock> {
      if (!seed) throw new Error('Seed not loaded');
      const secretKey = deriveSecretKey(seed, derivationIndex ?? nextManagedIndex);

      const block = createBlock(secretKey, {
        previous: previousFrontier === '' ? '0000000000000000000000000000000000000000000000000000000000000000' : previousFrontier,
        link: sourceHash,
        balance: amountRaw,
        representative: config.representative,
        work: null,
      });

      const signature = signBlock({ hash: block.hash, secretKey });

      return {
        contents: JSON.stringify(block.block),
        signature,
        hash: block.hash,
      };
    },

    async signChange(
      _account: string,
      representative: string,
      previousFrontier: string,
      derivationIndex?: number,
    ): Promise<SignedBlock> {
      if (!seed) throw new Error('Seed not loaded');
      const secretKey = deriveSecretKey(seed, derivationIndex ?? nextManagedIndex);

      const block = createBlock(secretKey, {
        previous: previousFrontier === '' ? '0000000000000000000000000000000000000000000000000000000000000000' : previousFrontier,
        link: '0000000000000000000000000000000000000000000000000000000000000000',
        balance: '0',
        representative,
        work: null,
      });

      const signature = signBlock({ hash: block.hash, secretKey });

      return {
        contents: JSON.stringify(block.block),
        signature,
        hash: block.hash,
      };
    },

    async generateWork(hash: string): Promise<string> {
      if (workProvider) {
        return workProvider.generate(hash, 'fffffff800000000');
      }
      const result = await computeWork(hash);
      if (!result) throw new Error('Work generation failed');
      return result;
    },
  };
}
