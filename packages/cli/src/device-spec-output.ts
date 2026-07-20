import { type SemanticDeviceSpecProjection, projectDeviceSpecSemantics } from '@eyaeya/xgg-core';
import { renderDeviceSpecPretty } from './device-spec-pretty.js';

type DeviceSpec = Parameters<typeof projectDeviceSpecSemantics>[0];

export type PreparedDeviceSpecOutput =
  | { format: 'json'; payload: { ok: true; spec: DeviceSpec } }
  | { format: 'pretty'; projection: SemanticDeviceSpecProjection; text: string };

/** Keep the default JSON path byte-shape compatible and free of semantic catalog requests. */
export async function prepareDeviceSpecOutput(
  spec: DeviceSpec,
  pretty: boolean,
  timeoutMs: number,
  semanticProjector: typeof projectDeviceSpecSemantics = projectDeviceSpecSemantics,
): Promise<PreparedDeviceSpecOutput> {
  if (!pretty) return { format: 'json', payload: { ok: true, spec } };
  const projection = await semanticProjector(spec, { timeoutMs });
  return { format: 'pretty', projection, text: renderDeviceSpecPretty(projection) };
}
