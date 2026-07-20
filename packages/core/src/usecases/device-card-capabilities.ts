import type { MiotProperty } from '../schemas/device-spec.js';
import { ConfigError } from '../transport/errors.js';

export type DevicePropertyCardType =
  | 'deviceInput'
  | 'deviceInputSetVar'
  | 'deviceGet'
  | 'deviceGetSetVar'
  | 'deviceOutput';

export type DevicePushSourceCardType = 'deviceInput' | 'deviceInputSetVar';

export type DevicePropertyAccess = 'notify' | 'read' | 'write';

const REQUIRED_PROPERTY_ACCESS: Readonly<Record<DevicePropertyCardType, DevicePropertyAccess>> = {
  deviceInput: 'notify',
  deviceInputSetVar: 'notify',
  deviceGet: 'read',
  deviceGetSetVar: 'read',
  deviceOutput: 'write',
};

export function requiredDevicePropertyAccess(type: DevicePropertyCardType): DevicePropertyAccess {
  return REQUIRED_PROPERTY_ACCESS[type];
}

export function devicePropertyAccessCapabilityMessage(
  type: DevicePropertyCardType,
  property: MiotProperty,
): string | null {
  const required = requiredDevicePropertyAccess(type);
  if (property.access.includes(required)) return null;
  return `${type} property ${property.type} requires MIoT access "${required}"; declared access is [${property.access.join(', ')}]`;
}

export function assertDevicePropertyAccessCapability(
  type: DevicePropertyCardType,
  property: MiotProperty,
  context: string,
): void {
  const message = devicePropertyAccessCapabilityMessage(type, property);
  if (message === null) return;
  throw new ConfigError(`${context}: ${message}`, {
    cardType: type,
    property: property.type,
    requiredAccess: requiredDevicePropertyAccess(type),
    access: property.access,
  });
}

export function isDevicePushSourceCard(type: string): type is DevicePushSourceCardType {
  return type === 'deviceInput' || type === 'deviceInputSetVar';
}

export function devicePushCapabilityMessage(
  type: DevicePushSourceCardType,
  did: string,
  pushAvailable: boolean,
): string | null {
  if (pushAvailable) return null;
  return `${type} source requires device push availability, but device ${did} reports pushAvailable=false`;
}

export function assertDevicePushCapability(
  type: DevicePushSourceCardType,
  device: { did: string; pushAvailable: boolean },
  allowNoPush: boolean,
): void {
  const message = devicePushCapabilityMessage(type, device.did, device.pushAvailable);
  if (message === null || allowNoPush) return;
  throw new ConfigError(
    `${message}. Use deviceGet/deviceGetSetVar for an active read, or pass --allow-no-push only for an explicit target-gateway runtime probe. That override does not bypass missing property notify/read/write access and does not prove the source will emit.`,
    {
      cardType: type,
      did: device.did,
      pushAvailable: device.pushAvailable,
      probeOverride: '--allow-no-push',
    },
  );
}
