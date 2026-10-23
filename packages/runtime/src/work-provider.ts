import { NanoClient, type PowEngine, type WorkProvider } from '@openrai/nano-core';

/** Create RaiFlow's shared work provider: configured peers first, isolated CPU fallback. */
export function createRuntimeWorkProvider(
  workEndpoints: string[],
  localEngine: PowEngine,
): WorkProvider {
  const hasRemoteWork = workEndpoints.length > 0 || Boolean(process.env['NANO_WORK_URL']);
  const client = NanoClient.initialize({
    ...(workEndpoints.length > 0 ? { work: workEndpoints } : {}),
    powEngine: localEngine,
    workRouting: {
      selectRoute: () => hasRemoteWork ? 'remote' : 'local',
      onRemoteFailure: 'local',
    },
  });

  return client.workProvider;
}
