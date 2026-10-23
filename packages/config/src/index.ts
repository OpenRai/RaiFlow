// @openrai/config — YAML config loader with env: resolution and validation

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { NanoAddress, NanoAmount } from '@openrai/nano-core';

export const DEFAULT_MINIMUM_RECEIVE_AMOUNT_XNO = '0.000001';
export const DEFAULT_STORAGE_MAX_DATABASE_BYTES = 1_073_741_824;
export const DEFAULT_STORAGE_MAX_DEPOSITS_PER_ACCOUNT = 100_000;

/** Validate the inbound admission minimum and convert it without floating point. */
export function minimumReceiveAmountRaw(value: string): string {
  try {
    if (typeof value !== 'string') throw new Error('Expected a decimal string');
    const amount = NanoAmount.fromNano(value);
    if (amount.raw === '0') throw new Error('Expected a positive amount');
    return amount.raw;
  } catch (cause) {
    throw new Error('receiving.minimumAmountXno must be a positive decimal XNO string with at most 30 fractional digits', { cause });
  }
}

export type RunMode = 'custodial' | 'non-custodial';

export interface DaemonConfig {
  host: string;
  port: number;
  apiKey?: string;
  mode?: RunMode;
  enableDashboardAuth: boolean;
}

export interface NanoConfig {
  rpc: string[];
  ws: string[];
  work: string[];
}

export interface CustodyConfig {
  provider: 'ows';
  wallet: string;
  credential?: string;
  vaultPath?: string;
  representative: string;
}

export interface InvoicesConfig {
  defaultExpirySeconds: number;
  autoSweep: boolean;
  sweepDestination: string | null;
}

export interface ReceivingConfig {
  /** Inclusive minimum for each inbound transfer, expressed as a decimal XNO string. */
  minimumAmountXno: string;
}

export interface StorageConfig {
  driver: 'sqlite';
  path: string;
  /** SQLite database page limit; inbound processing pauses before this is reached. */
  maxDatabaseBytes: number;
  /** Maximum retained confirmed deposits for one Nano destination address. */
  maxDepositsPerAccount: number;
}

export interface WebhookConfig {
  url: string;
  secret: string;
  events: string[];
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'pretty';
}

export interface RaiFlowConfig {
  daemon: DaemonConfig;
  nano: NanoConfig;
  custody: CustodyConfig | null;
  invoices: InvoicesConfig;
  receiving: ReceivingConfig;
  storage: StorageConfig;
  webhooks: WebhookConfig[];
  logging: LoggingConfig;
}

interface RawConfig {
  daemon?: unknown;
  nano?: unknown;
  custody?: unknown;
  invoices?: unknown;
  receiving?: unknown;
  storage?: unknown;
  webhooks?: unknown;
  logging?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (!isString(val)) throw new Error(`config.${key} must be a string`);
  return val;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  if (val === undefined) return undefined;
  if (!isString(val)) throw new Error(`config.${key} must be a string`);
  return val;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  if (val === undefined) return undefined;
  if (typeof val !== 'number') throw new Error(`config.${key} must be a number`);
  return val;
}

function positiveInteger(value: unknown, key: string): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`config.storage.${key} must be a positive safe integer`);
  }
  return parsed;
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const val = obj[key];
  if (val === undefined) return undefined;
  if (!isBoolean(val)) throw new Error(`config.${key} must be a boolean`);
  return val;
}

function resolveEnv(value: string): string {
  if (value.startsWith('env:')) {
    const envKey = value.slice(4);
    const envVal = process.env[envKey];
    if (envVal === undefined) {
      throw new Error(`environment variable ${envKey} is not set`);
    }
    return envVal;
  }
  return value;
}

function resolveEnvValue(val: unknown): unknown {
  if (isString(val)) return resolveEnv(val);
  if (isObject(val)) {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      resolved[k] = resolveEnvValue(v);
    }
    return resolved;
  }
  if (Array.isArray(val)) return val.map(resolveEnvValue);
  return val;
}

function resolveStringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`config.${key} must be an array of strings`);
  }

  const resolved = resolveEnvValue(value);
  if (!isStringArray(resolved)) {
    throw new Error(`config.${key} must be an array of strings`);
  }

  return resolved;
}

function parseDaemon(obj: Record<string, unknown>): DaemonConfig {
  const daemon = isObject(obj.daemon) ? obj.daemon : {};
  const apiKey = optionalString(daemon, 'apiKey');

  // Dashboard auth resolution: RAIFLOW_DASHBOARD_AUTH env var > daemon.enableDashboardAuth in YAML > true
  let enableDashboardAuth = true;
  const envDashboardAuth = process.env['RAIFLOW_DASHBOARD_AUTH'];
  const yamlDashboardAuth = optionalBoolean(daemon, 'enableDashboardAuth');

  if (envDashboardAuth !== undefined) {
    // In env var, we want "false" to mean disable auth.
    enableDashboardAuth = envDashboardAuth.toLowerCase() !== 'false';
  } else if (yamlDashboardAuth !== undefined) {
    enableDashboardAuth = yamlDashboardAuth;
  }

  // Mode resolution: RAIFLOW_MODE env var > daemon.mode in YAML > undefined
  let mode: RunMode | undefined;
  const envMode = process.env['RAIFLOW_MODE'];
  const yamlMode = optionalString(daemon, 'mode');
  const rawMode = envMode ?? yamlMode;
  if (rawMode !== undefined) {
    const normalized = rawMode.toLowerCase().trim();
    if (normalized !== 'custodial' && normalized !== 'non-custodial') {
      throw new Error(
        `config.daemon.mode must be "custodial" or "non-custodial", got "${rawMode}"`,
      );
    }
    mode = normalized;
  }

  return {
    host: optionalString(daemon, 'host') ?? '0.0.0.0',
    port: optionalNumber(daemon, 'port') ?? 3100,
    apiKey: apiKey ? resolveEnv(apiKey) : undefined,
    mode,
    enableDashboardAuth,
  };
}

function parseNano(obj: Record<string, unknown>): NanoConfig {
  const nano = isObject(obj.nano) ? obj.nano : {};
  return {
    rpc: resolveStringArray(nano.rpc, 'nano.rpc'),
    ws: resolveStringArray(nano.ws, 'nano.ws'),
    work: resolveStringArray(nano.work, 'nano.work'),
  };
}

function parseCustody(obj: Record<string, unknown>): CustodyConfig | null {
  if (obj.custody === undefined || obj.custody === null) {
    return null;
  }
  if (!isObject(obj.custody)) {
    throw new Error('config.custody must be an object');
  }
  const custody = obj.custody;
  if (custody['seed'] !== undefined) {
    throw new Error(
      'config.custody.seed is no longer accepted; configure an OWS wallet so RaiFlow never receives raw seed material',
    );
  }
  const provider = optionalString(custody, 'provider') ?? 'ows';
  if (provider !== 'ows') {
    throw new Error('config.custody.provider must be "ows"');
  }
  const credential = optionalString(custody, 'credential');
  const vaultPath = optionalString(custody, 'vaultPath');
  return {
    provider: 'ows',
    wallet: resolveEnv(requireString(custody, 'wallet')),
    credential: credential ? resolveEnv(credential) : undefined,
    vaultPath: vaultPath ? resolveEnv(vaultPath) : undefined,
    representative: resolveEnv(requireString(custody, 'representative')),
  };
}

function parseInvoices(obj: Record<string, unknown>): InvoicesConfig {
  const invoices = isObject(obj.invoices) ? obj.invoices : {};
  const defaultExpirySeconds = optionalNumber(invoices, 'defaultExpirySeconds') ?? 3600;
  if (!Number.isSafeInteger(defaultExpirySeconds) || defaultExpirySeconds <= 0) {
    throw new Error('config.invoices.defaultExpirySeconds must be a positive integer');
  }
  const autoSweep = optionalBoolean(invoices, 'autoSweep') ?? false;
  const sweepDestination = optionalString(invoices, 'sweepDestination');
  if (autoSweep && !sweepDestination) {
    throw new Error('config.invoices.sweepDestination is required when autoSweep is true');
  }
  const resolvedSweepDestination = sweepDestination ? resolveEnv(sweepDestination) : null;
  if (autoSweep && resolvedSweepDestination) {
    try {
      NanoAddress.parse(resolvedSweepDestination);
    } catch (cause) {
      throw new Error('config.invoices.sweepDestination must be a valid Nano address', { cause });
    }
  }
  return {
    defaultExpirySeconds,
    autoSweep,
    sweepDestination: resolvedSweepDestination,
  };
}

function parseStorage(obj: Record<string, unknown>): StorageConfig {
  const storage = isObject(obj.storage) ? obj.storage : {};
  const driver = optionalString(storage, 'driver') ?? 'sqlite';
  if (driver !== 'sqlite') {
    throw new Error(`config.storage.driver must be 'sqlite' for now`);
  }
  const maxDatabaseBytes = positiveInteger(
    process.env['RAIFLOW_STORAGE_MAX_DATABASE_BYTES']
      ?? storage.maxDatabaseBytes
      ?? DEFAULT_STORAGE_MAX_DATABASE_BYTES,
    'maxDatabaseBytes',
  );
  const maxDepositsPerAccount = positiveInteger(
    process.env['RAIFLOW_STORAGE_MAX_DEPOSITS_PER_ACCOUNT']
      ?? storage.maxDepositsPerAccount
      ?? DEFAULT_STORAGE_MAX_DEPOSITS_PER_ACCOUNT,
    'maxDepositsPerAccount',
  );
  if (maxDatabaseBytes < 16 * 1024 * 1024) {
    throw new Error('config.storage.maxDatabaseBytes must be at least 16777216 bytes');
  }
  return {
    driver: 'sqlite',
    path: resolveEnv(optionalString(storage, 'path') ?? './raiflow.db'),
    maxDatabaseBytes,
    maxDepositsPerAccount,
  };
}

function parseReceiving(obj: Record<string, unknown>): ReceivingConfig {
  if (obj.receiving !== undefined && !isObject(obj.receiving)) {
    throw new Error('config.receiving must be an object');
  }
  const receiving = isObject(obj.receiving) ? obj.receiving : {};
  const minimumAmountXno = process.env['RAIFLOW_MINIMUM_RECEIVE_AMOUNT_XNO']
    ?? receiving.minimumAmountXno
    ?? DEFAULT_MINIMUM_RECEIVE_AMOUNT_XNO;
  if (typeof minimumAmountXno !== 'string') {
    throw new Error('config.receiving.minimumAmountXno must be a quoted decimal XNO string');
  }
  minimumReceiveAmountRaw(minimumAmountXno);
  return { minimumAmountXno };
}

function parseWebhooks(obj: Record<string, unknown>): WebhookConfig[] {
  const webhooks = Array.isArray(obj.webhooks) ? obj.webhooks : [];
  return webhooks.map((w, i) => {
    if (!isObject(w)) throw new Error(`config.webhooks[${i}] must be an object`);
    const wObj = w as Record<string, unknown>;
    return {
      url: resolveEnv(requireString(wObj, 'url')),
      secret: resolveEnv(requireString(wObj, 'secret')),
      events: isStringArray(wObj.events) ? wObj.events : ['*'],
    };
  });
}

function parseLogging(obj: Record<string, unknown>): LoggingConfig {
  const logging = isObject(obj.logging) ? obj.logging : {};
  const level = optionalString(logging, 'level') ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error(`config.logging.level must be one of debug, info, warn, error`);
  }
  const format = optionalString(logging, 'format') ?? 'pretty';
  if (!['json', 'pretty'].includes(format)) {
    throw new Error(`config.logging.format must be one of json, pretty`);
  }
  return { level: level as LoggingConfig['level'], format: format as LoggingConfig['format'] };
}

export function loadConfig(path: string): RaiFlowConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  if (!isObject(parsed)) {
    throw new Error('config file must be a YAML object');
  }
  const resolved = resolveEnvValue(parsed) as RawConfig;

  const obj = resolved as Record<string, unknown>;

  return {
    daemon: parseDaemon(obj),
    nano: parseNano(obj),
    custody: parseCustody(obj),
    invoices: parseInvoices(obj),
    receiving: parseReceiving(obj),
    storage: parseStorage(obj),
    webhooks: parseWebhooks(obj),
    logging: parseLogging(obj),
  };
}
