// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

/** /api/getLog returns a raw text block; only an empty string means end of pages. */
export const RuleLogBlockResponse = z.string();
