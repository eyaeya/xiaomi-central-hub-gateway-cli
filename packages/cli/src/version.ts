// SPDX-License-Identifier: GPL-3.0-or-later
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };

/** Runtime version of the installed `@eyaeya/xgg-cli` package. */
export const VERSION = packageMetadata.version;
