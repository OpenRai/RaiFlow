import { type RaiFlowConfig } from '@openrai/config';
import { Runtime } from './runtime.js';
import type { AccountStateSync } from './account-state-sync.js';
import type { SubscriptionManager } from './subscription-manager.js';
export declare function createHandler(runtime: Runtime, config: RaiFlowConfig, version?: string, accountStateSync?: AccountStateSync, subscriptionManager?: SubscriptionManager): (req: Request) => Promise<Response>;
