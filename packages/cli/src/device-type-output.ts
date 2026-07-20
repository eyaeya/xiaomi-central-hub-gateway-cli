import {
  type DeviceSpecSemanticCatalogStatus,
  type SemanticDeviceType,
  type SemanticDeviceTypesProjection,
  projectDeviceTypesSemantics,
} from '@eyaeya/xgg-core';
import Table from 'cli-table3';
import stringWidth from 'string-width';
import { wrapDisplayText } from './terminal-text.js';

export const DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH = 120;

export interface DeviceTypeSource {
  urn: string;
}

export interface DeviceListPrettyRow extends DeviceTypeSource {
  id: string;
  name: string;
  model: string;
  roomName?: string;
  availability: string;
}

type DeviceTypeProjector = typeof projectDeviceTypesSemantics;

export async function prepareDeviceTypeProjection(
  devices: readonly DeviceTypeSource[],
  pretty: boolean,
  timeoutMs: number,
  projector: DeviceTypeProjector = projectDeviceTypesSemantics,
): Promise<SemanticDeviceTypesProjection | undefined> {
  if (!pretty) return undefined;
  return projector(
    devices.map((device) => device.urn),
    { timeoutMs },
  );
}

function catalogStatusText(status: DeviceSpecSemanticCatalogStatus): string {
  if (status.status === 'loaded') return `${status.catalog}=loaded`;
  const httpStatus = status.httpStatus === undefined ? '' : `:${status.httpStatus}`;
  return `${status.catalog}=fallback(${status.reason ?? 'unknown'}${httpStatus})`;
}

function appendWrapped(lines: string[], prefix: string, value: string): void {
  const prefixWidth = stringWidth(prefix);
  const room = Math.max(1, DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH - prefixWidth);
  const continuation = ' '.repeat(prefixWidth);
  for (const [index, wrapped] of wrapDisplayText(value, room).split('\n').entries()) {
    lines.push(`${index === 0 ? prefix : continuation}${wrapped}`);
  }
}

function catalogStatusLine(projection: SemanticDeviceTypesProjection): string {
  return projection.catalogs.map(catalogStatusText).join(', ');
}

function matchingDeviceType(
  row: DeviceTypeSource,
  projection: SemanticDeviceTypesProjection,
  index: number,
): SemanticDeviceType {
  const projected = projection.deviceTypes[index];
  if (projected !== undefined && projected.urn === row.urn) return projected;
  const deviceType = row.urn.split(':')[3] ?? '';
  return { urn: row.urn, deviceType, deviceTypeDescription: deviceType };
}

export function renderDeviceListPretty(
  rows: readonly DeviceListPrettyRow[],
  projection: SemanticDeviceTypesProjection,
): string {
  const colWidths = [11, 12, 12, 10, 13, 23, 21, 9];
  const cell = (value: string, column: number): string => {
    const width = colWidths[column];
    if (width === undefined) throw new RangeError(`invalid device list column: ${column}`);
    return wrapDisplayText(value, width - 2);
  };
  const table = new Table({
    head: [
      'id',
      'name',
      'model',
      'roomName',
      'deviceType',
      'deviceTypeDescription',
      'urn',
      'avail',
    ],
    colWidths,
    wordWrap: true,
    style: { head: [], border: [] },
  });
  for (const [index, row] of rows.entries()) {
    const semantic = matchingDeviceType(row, projection, index);
    table.push([
      cell(row.id, 0),
      cell(row.name, 1),
      cell(row.model, 2),
      cell(row.roomName ?? '', 3),
      cell(semantic.deviceType, 4),
      cell(semantic.deviceTypeDescription, 5),
      cell(row.urn, 6),
      cell(row.availability, 7),
    ]);
  }
  const lines: string[] = [];
  appendWrapped(lines, 'Catalog status: ', catalogStatusLine(projection));
  lines.push(table.toString());
  const output = `${lines.join('\n')}\n`;
  if (output.split('\n').some((line) => stringWidth(line) > DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH)) {
    throw new Error(
      `device list pretty output exceeded ${DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH} columns`,
    );
  }
  return output;
}

function jsonScalar(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded ?? String(value);
}

export function renderDeviceGetPretty(
  device: DeviceTypeSource & Record<string, unknown>,
  projection: SemanticDeviceTypesProjection,
): string {
  const semantic = matchingDeviceType(device, projection, 0);
  const lines: string[] = [];
  appendWrapped(lines, 'Device type: ', semantic.deviceType);
  appendWrapped(lines, 'Device type description: ', semantic.deviceTypeDescription);
  appendWrapped(lines, 'Catalog status: ', catalogStatusLine(projection));
  lines.push('Device metadata:');
  for (const [key, value] of Object.entries(device)) {
    appendWrapped(lines, '  ', `${key}=${jsonScalar(value)}`);
  }
  return `${lines.join('\n')}\n`;
}
