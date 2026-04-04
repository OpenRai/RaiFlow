// @openrai/config — YAML config loader with env: resolution and validation

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface DaemonConfig {
  host: string;
  port: number;
  apiKey?: string;
}

export interface NanoConfig {
  rpc: string[];
  ws: string[];
  work: string[];
}

export interface CustodyConfig {
  seed: string;
  representative: string;
}

export interface InvoicesConfig {
  defaultExpirySeconds: number;
  autoSweep: boolean;
  sweepDestination: string | null;
}

export interface StorageConfig {
  driver: 'sqlite';
  path: string;
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
  storage: StorageConfig;
  webhooks: WebhookConfig[];
  logging: LoggingConfig;
}

interface RawConfig {
  daemon?: unknown;
  nano?: unknown;
  custody?: unknown;
  invoices?: unknown;
  storage?: unknown;
  webhooks?: unknown;
  logging?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number';
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

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (!isNumber(val)) throw new Error(`config.${key} must be a number`);
  return val;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const val = obj[key];
  if (!isBoolean(val)) throw new Error(`config.${key} must be a boolean`);
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
  if (!isNumber(val)) throw new Error(`config.${key} must be a number`);
  return val;
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const val = obj[key];
  if (val === undefined) return undefined;
  if (!isBoolean(val)) throw new Error(`config.${key} must be a boolean`);
  return val;
}

function requireObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const val = obj[key];
  if (!isObject(val)) throw new Error(`config.${key} must be an object`);
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

function parseDaemon(obj: Record<string, unknown>): DaemonConfig {
  const daemon = isObject(obj.daemon) ? obj.daemon : {};
  const apiKey = optionalString(daemon, 'apiKey');
  return {
    host: optionalString(daemon, 'host') ?? '0.0.0.0',
    port: optionalNumber(daemon, 'port') ?? 3100,
    apiKey: apiKey ? resolveEnv(apiKey) : undefined,
  };
}

function parseNano(obj: Record<string, unknown>): NanoConfig {
  const nano = isObject(obj.nano) ? obj.nano : {};
  const rpc = Array.isArray(nano.rpc)
    ? (resolveEnvValue(nano.rpc) as unknown[]).filter(isString)
    : [];
  const ws = Array.isArray(nano.ws)
    ? (resolveEnvValue(nano.ws) as unknown[]).filter(isString)
    : [];
  const work = Array.isArray(nano.work)
    ? (resolveEnvValue(nano.work) as unknown[]).filter(isString)
    : [];
  return {
    rpc,
    ws,
    work,
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
  return {
    seed: resolveEnv(requireString(custody, 'seed')),
    representative: resolveEnv(requireString(custody, 'representative')),
  };
}

function parseInvoices(obj: Record<string, unknown>): InvoicesConfig {
  const invoices = isObject(obj.invoices) ? obj.invoices : {};
  const autoSweep = optionalBoolean(invoices, 'autoSweep') ?? false;
  const sweepDestination = optionalString(invoices, 'sweepDestination');
  if (autoSweep && !sweepDestination) {
    throw new Error('config.invoices.sweepDestination is required when autoSweep is true');
  }
  return {
    defaultExpirySeconds: optionalNumber(invoices, 'defaultExpirySeconds') ?? 3600,
    autoSweep,
    sweepDestination: sweepDestination ? resolveEnv(sweepDestination) : null,
  };
}

function parseStorage(obj: Record<string, unknown>): StorageConfig {
  const storage = isObject(obj.storage) ? obj.storage : {};
  const driver = optionalString(storage, 'driver') ?? 'sqlite';
  if (driver !== 'sqlite') {
    throw new Error(`config.storage.driver must be 'sqlite' for now`);
  }
  return {
    driver: 'sqlite',
    path: resolveEnv(optionalString(storage, 'path') ?? './raiflow.db'),
  };
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
    storage: parseStorage(obj),
    webhooks: parseWebhooks(obj),
    logging: parseLogging(obj),
  };
}
