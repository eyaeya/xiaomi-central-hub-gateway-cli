// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

/** Real router-integrated gateway responses, verified during the cloud discovery probe. */
export const CloudGatewayPasscode = z.object({ passcode: z.string().regex(/^\d{6}$/) });
export const CloudGatewayUrl = z.object({ url: z.string().url() });
