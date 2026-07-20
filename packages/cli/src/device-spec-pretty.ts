import type {
  SemanticDeviceAction,
  SemanticDeviceEvent,
  SemanticDeviceProperty,
  SemanticDevicePropertyReference,
  SemanticDeviceSpecProjection,
} from '@eyaeya/xgg-core';
import stringWidth from 'string-width';
import { wrapDisplayText } from './terminal-text.js';

export const DEVICE_SPEC_PRETTY_MAX_LINE_WIDTH = 120;

interface Purpose {
  title: string;
  nodeTypes: string;
  propertyLabel: string;
  properties: SemanticDeviceProperty[];
  events: SemanticDeviceEvent[];
  actions: SemanticDeviceAction[];
}

interface ServiceCapabilities {
  siid: number;
  urn: string;
  description: string;
  properties: SemanticDeviceProperty[];
  events: SemanticDeviceEvent[];
  actions: SemanticDeviceAction[];
}

function shortName(urn: string): string {
  return urn.split(':')[3] ?? urn;
}

function scalar(value: number | boolean): string {
  return JSON.stringify(value);
}

function propertyDomain(property: SemanticDeviceProperty): string {
  const parts: string[] = [];
  if (property.valueList !== undefined) {
    parts.push(
      `enum[${property.valueList
        .map((entry) => `${scalar(entry.value)}=${JSON.stringify(entry.description)}`)
        .join(', ')}]`,
    );
  }
  if (property.valueRange !== undefined) {
    parts.push(
      `range[${scalar(property.valueRange.min)}..${scalar(property.valueRange.max)} step ${scalar(property.valueRange.step)}]`,
    );
  }
  return parts.join('; ') || '—';
}

function appendWrapped(lines: string[], prefix: string, value: string): void {
  if (value.length === 0) {
    lines.push(prefix);
    return;
  }
  const prefixWidth = stringWidth(prefix);
  const room = Math.max(1, DEVICE_SPEC_PRETTY_MAX_LINE_WIDTH - prefixWidth);
  const continuation = ' '.repeat(prefixWidth);
  for (const [index, wrapped] of wrapDisplayText(value, room).split('\n').entries()) {
    lines.push(`${index === 0 ? prefix : continuation}${wrapped}`);
  }
}

function appendPropertyDetails(
  lines: string[],
  property: SemanticDeviceProperty,
  indent: string,
): void {
  appendWrapped(lines, `${indent}URN: `, property.urn);
  appendWrapped(lines, `${indent}type: `, `format=${property.format} dtype=${property.dtype}`);
  appendWrapped(lines, `${indent}access: `, property.access.join(', ') || 'none');
  if (property.unit !== undefined) {
    const rawSuffix = property.rawUnit === property.unit ? '' : ` (raw=${property.rawUnit})`;
    appendWrapped(lines, `${indent}unit: `, `${property.unit}${rawSuffix}`);
  }
  appendWrapped(lines, `${indent}domain: `, propertyDomain(property));
}

function appendPropertyReference(
  lines: string[],
  reference: SemanticDevicePropertyReference,
  index: number,
  indent: string,
): void {
  if (!reference.resolved) {
    lines.push(`${indent}- [${index}] piid=${reference.piid} unresolved`);
    return;
  }
  const property = reference.property;
  appendWrapped(
    lines,
    `${indent}- [${index}] `,
    `piid=${reference.piid} selector=${shortName(property.urn)} name=${JSON.stringify(property.description)}`,
  );
  appendPropertyDetails(lines, property, `${indent}  `);
}

function appendPropertyReferences(
  lines: string[],
  references: readonly SemanticDevicePropertyReference[],
  indent: string,
): void {
  if (references.length === 0) {
    lines.push(`${indent}none`);
    return;
  }
  for (const [index, reference] of references.entries()) {
    appendPropertyReference(lines, reference, index, indent);
  }
}

function appendProperties(
  lines: string[],
  label: string,
  properties: SemanticDeviceProperty[],
): void {
  lines.push(`      ${label}:`);
  for (const property of properties) {
    appendWrapped(
      lines,
      '        - ',
      `piid=${property.piid} selector=${shortName(property.urn)} name=${JSON.stringify(property.description)}`,
    );
    appendPropertyDetails(lines, property, '          ');
  }
}

function appendEvents(lines: string[], events: SemanticDeviceEvent[]): void {
  lines.push('      Events:');
  for (const event of events) {
    appendWrapped(
      lines,
      '        - ',
      `eiid=${event.eiid} selector=${shortName(event.urn)} name=${JSON.stringify(event.description)}`,
    );
    appendWrapped(lines, '          URN: ', event.urn);
    lines.push('          arguments:');
    appendPropertyReferences(lines, event.arguments, '            ');
  }
}

function appendActions(lines: string[], actions: SemanticDeviceAction[]): void {
  lines.push('      Actions:');
  for (const action of actions) {
    appendWrapped(
      lines,
      '        - ',
      `aiid=${action.aiid} selector=${shortName(action.urn)} name=${JSON.stringify(action.description)}`,
    );
    appendWrapped(lines, '          URN: ', action.urn);
    lines.push('          inputs:');
    appendPropertyReferences(lines, action.inputs, '            ');
    lines.push('          MIoT action.out metadata (not bindable; no rule-graph output pin):');
    appendPropertyReferences(lines, action.outMetadata, '            ');
  }
}

function serviceCapabilities(purpose: Purpose, proprietary: boolean): ServiceCapabilities[] {
  const byService = new Map<string, ServiceCapabilities>();
  const bucketFor = (siid: number, urn: string, description: string): ServiceCapabilities => {
    const key = `${siid}|${urn}`;
    const existing = byService.get(key);
    if (existing !== undefined) return existing;
    const created: ServiceCapabilities = {
      siid,
      urn,
      description,
      properties: [],
      events: [],
      actions: [],
    };
    byService.set(key, created);
    return created;
  };

  for (const property of purpose.properties) {
    if (property.proprietary !== proprietary) continue;
    bucketFor(property.siid, property.sUrn, property.sDescription).properties.push(property);
  }
  for (const event of purpose.events) {
    if (event.proprietary !== proprietary) continue;
    bucketFor(event.siid, event.sUrn, event.sDescription).events.push(event);
  }
  for (const action of purpose.actions) {
    if (action.proprietary !== proprietary) continue;
    bucketFor(action.siid, action.sUrn, action.sDescription).actions.push(action);
  }
  return [...byService.values()];
}

function appendCapabilityGroup(
  lines: string[],
  purpose: Purpose,
  proprietary: boolean,
  label: string,
): boolean {
  const services = serviceCapabilities(purpose, proprietary);
  if (services.length === 0) return false;
  lines.push(`  ${label}:`);
  for (const service of services) {
    appendWrapped(lines, `    Service ${service.siid}: `, service.description);
    appendWrapped(lines, '      URN: ', service.urn);
    if (service.properties.length > 0) {
      appendProperties(lines, purpose.propertyLabel, service.properties);
    }
    if (service.events.length > 0) appendEvents(lines, service.events);
    if (service.actions.length > 0) appendActions(lines, service.actions);
  }
  return true;
}

function appendPurpose(lines: string[], purpose: Purpose): void {
  lines.push(`Automation purpose: ${purpose.title}`);
  appendWrapped(lines, '  Rule nodes: ', purpose.nodeTypes);
  const hasStandard = appendCapabilityGroup(lines, purpose, false, 'Standard capabilities');
  const hasProprietary = appendCapabilityGroup(
    lines,
    purpose,
    true,
    'Proprietary/vendor capabilities',
  );
  if (!hasStandard && !hasProprietary) lines.push('  (no matching automation capabilities)');
  lines.push('');
}

function appendCatalogStatus(lines: string[], projection: SemanticDeviceSpecProjection): void {
  appendWrapped(
    lines,
    'Semantic labels: ',
    'best-effort zh_cn; Bundle-compatible precedence varies by context',
  );
  appendWrapped(
    lines,
    'Label precedence: ',
    'values=multiLanguage -> normalization -> raw; service/property/event=multiLanguage -> template -> raw; action=multiLanguage -> raw -> template; action-input=multiLanguage -> raw',
  );
  appendWrapped(
    lines,
    'Catalog status: ',
    projection.catalogs
      .map((entry) => {
        if (entry.status === 'loaded') return `${entry.catalog}=loaded`;
        const httpStatus = entry.httpStatus === undefined ? '' : `:${entry.httpStatus}`;
        return `${entry.catalog}=fallback(${entry.reason ?? 'unknown'}${httpStatus})`;
      })
      .join(', '),
  );
  if (projection.catalogs.some((entry) => entry.status === 'fallback')) {
    lines.push('Raw instance labels are retained wherever a semantic catalog was unavailable.');
  }
}

/**
 * Render the best-effort MIoT semantic projection as rule-authoring choices.
 * Long URNs, labels, and enum domains wrap instead of truncating.
 */
export function renderDeviceSpecPretty(projection: SemanticDeviceSpecProjection): string {
  const lines: string[] = [];
  appendWrapped(lines, 'Device: ', projection.description);
  appendWrapped(lines, 'URN: ', projection.urn);
  appendCatalogStatus(lines, projection);
  if (projection.excludedServices.length > 0) {
    lines.push('Excluded from automation:');
    for (const service of projection.excludedServices) {
      appendWrapped(
        lines,
        '  - ',
        `siid=${service.siid} selector=${shortName(service.urn)} name=${JSON.stringify(service.description)} (MIoT device-information metadata)`,
      );
    }
  }
  lines.push('');

  const purposes: Purpose[] = [
    {
      title: 'event/state updates',
      nodeTypes: 'deviceInput, deviceInputSetVar',
      propertyLabel: 'Notify properties',
      properties: projection.propertyNotify,
      events: projection.events,
      actions: [],
    },
    {
      title: 'current-state query',
      nodeTypes: 'deviceGet, deviceGetSetVar',
      propertyLabel: 'Readable properties',
      properties: projection.propertyGet,
      events: [],
      actions: [],
    },
    {
      title: 'write/action execution',
      nodeTypes: 'deviceOutput',
      propertyLabel: 'Writable properties',
      properties: projection.propertySet,
      events: [],
      actions: projection.actions,
    },
  ];
  for (const purpose of purposes) appendPurpose(lines, purpose);
  return `${lines.join('\n')}\n`;
}
