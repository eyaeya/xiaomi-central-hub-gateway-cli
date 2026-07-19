// SPDX-License-Identifier: GPL-3.0-or-later
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };

/** Runtime version of the installed `@eyaeya/xgg-core` package. */
export const VERSION = packageMetadata.version;

export {
  DEFAULT_MAX_INNER_COMPRESSED_BYTES,
  DEFAULT_MAX_INNER_JSON_BYTES,
} from './crypto/deflate.js';
export type { InnerJsonLimits } from './crypto/deflate.js';
export * from './agent/index.js';
export * from './resources/index.js';
export * from './session/index.js';
export * from './transport/errors.js';
export * from './usecases/index.js';
export { nodeSchemaForType } from './schemas/nodes/registry.js';
export {
  VARIABLE_IDENTIFIER_CONSTRAINT,
  VARIABLE_IDENTIFIER_PATTERN,
  isValidVariableIdentifier,
} from './schemas/variable-identifier.js';
export {
  MIOT_COMPARISON_CONTRACT,
  hasMiotValueList,
  isMiotEventWireOperator,
  isMiotWireOperator,
  miotNumericOperandDomainError,
  miotShortcutOperatorToWire,
  parseFiniteDecimalLiteral,
  projectMiotComparisonDtype,
} from './schemas/miot-comparison.js';
export type {
  MiotComparisonDtype,
  MiotComparisonShortcutOperator,
  MiotComparisonWireOperator,
} from './schemas/miot-comparison.js';
export {
  JsonRpcRouter,
  SessionChannel,
  StubGatewayServer,
  connectWs,
  makeFakeTransportPair,
  runPasscodeHandshake,
  toWsUrl,
} from './transport/index.js';
export type { SessionChannelOptions } from './transport/index.js';
