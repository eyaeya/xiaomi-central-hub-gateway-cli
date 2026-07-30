import {
  type HabitLearningDeviceInput,
  XggError,
  getDeviceSpec,
  type listDevices,
} from '@eyaeya/xgg-core';

export interface SpecFetchFailure {
  did: string;
  name: string;
  urn: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type DeviceInventory = Awaited<ReturnType<typeof listDevices>>;
export type DeviceSpec = Awaited<ReturnType<typeof getDeviceSpec>>;

type SpecLoad =
  | { ok: true; spec: DeviceSpec }
  | {
      ok: false;
      error: unknown;
    };

function describeSpecFailure(
  did: string,
  name: string,
  urn: string,
  error: unknown,
): SpecFetchFailure {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'Unknown MIoT spec fetch failure';
  if (error instanceof XggError) {
    return {
      did,
      name,
      urn,
      code: error.code,
      message,
      ...(error.details !== undefined && { details: error.details }),
    };
  }
  return { did, name, urn, code: 'UNKNOWN', message };
}

/**
 * Load every distinct MIoT spec once while retaining a per-device failure.
 *
 * This function deliberately returns the private inventory-derived input to
 * its caller. Public commands must persist it only below the guarded study
 * directory and must not include it in their stdout payload.
 */
export async function collectHabitLearningPlannerInputs(
  inventory: DeviceInventory,
  timeoutMs: number,
): Promise<{
  devices: HabitLearningDeviceInput[];
  specsByUrn: Map<string, DeviceSpec>;
  attemptedDeviceCount: number;
  loadedDeviceCount: number;
  specFailures: SpecFetchFailure[];
}> {
  const entries = Object.entries(inventory).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const specLoads = new Map<string, Promise<SpecLoad>>();
  const loadSpec = (urn: string): Promise<SpecLoad> => {
    const existing = specLoads.get(urn);
    if (existing !== undefined) return existing;
    const pending = getDeviceSpec(urn, { timeoutMs }).then(
      (spec): SpecLoad => ({ ok: true, spec }),
      (error: unknown): SpecLoad => ({ ok: false, error }),
    );
    specLoads.set(urn, pending);
    return pending;
  };

  const resolved = await Promise.all(
    entries.map(async ([did, device]) => {
      const visibleDevice = { ...device, did };
      if (!device.specV2Access && !device.specV3Access) {
        return {
          input: { device: visibleDevice } satisfies HabitLearningDeviceInput,
          attempted: false,
          loaded: false,
        };
      }

      const result = await loadSpec(device.urn);
      if (result.ok) {
        return {
          input: {
            device: visibleDevice,
            spec: result.spec,
            // `getDeviceSpec` returns the raw registry document. No curated
            // semantic catalog was applied, so privacy classification may
            // additionally consult display descriptions and fail closed.
            semanticCatalogFallback: true,
          } satisfies HabitLearningDeviceInput,
          attempted: true,
          loaded: true,
          urn: device.urn,
          spec: result.spec,
        };
      }

      const failure = describeSpecFailure(did, device.name, device.urn, result.error);
      return {
        input: {
          device: visibleDevice,
          specError: failure.message,
        } satisfies HabitLearningDeviceInput,
        attempted: true,
        loaded: false,
        failure,
      };
    }),
  );

  const specsByUrn = new Map<string, DeviceSpec>();
  for (const item of resolved) {
    if (item.loaded && item.urn !== undefined && item.spec !== undefined) {
      specsByUrn.set(item.urn, item.spec);
    }
  }

  return {
    devices: resolved.map(({ input }) => input),
    specsByUrn,
    attemptedDeviceCount: resolved.filter(({ attempted }) => attempted).length,
    loadedDeviceCount: resolved.filter(({ loaded }) => loaded).length,
    specFailures: resolved.flatMap(({ failure }) => (failure === undefined ? [] : [failure])),
  };
}
