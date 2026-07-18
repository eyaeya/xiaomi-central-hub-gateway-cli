// SPDX-License-Identifier: GPL-3.0-or-later
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };

/** Runtime version of the installed `@eyaeya/xgg-core` package. */
export const VERSION = packageMetadata.version;

export * from './agent/index.js';
export * from './resources/index.js';
export * from './session/index.js';
export * from './transport/errors.js';
export * from './usecases/index.js';
export { nodeSchemaForType } from './schemas/nodes/registry.js';
export {
  JsonRpcRouter,
  SessionChannel,
  StubGatewayServer,
  connectWs,
  makeFakeTransportPair,
  runPasscodeHandshake,
  toWsUrl,
} from './transport/index.js';
