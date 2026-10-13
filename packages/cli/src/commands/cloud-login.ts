// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AuthRequiredError,
  type CloudLoginPending,
  ConfigError,
  cloudLoginComplete,
  cloudLoginStart,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import QRCode from 'qrcode';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';
import { renderNextCommand } from './_next-command.js';

interface CloudLoginOpts {
  authFile?: string;
  timeout?: string;
  pretty?: boolean;
  complete?: boolean;
  restart?: boolean;
  waitMs?: string;
}

function positiveMs(raw: string, flag: string, maximum: number): number {
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum) {
    throw new ConfigError(`${flag} must be between 1 and ${maximum} milliseconds`, {
      domain: 'cloud',
    });
  }
  return value;
}

function qrDirectory(authFile?: string): string {
  return `${resolve(authFile ?? join(homedir(), '.config', 'mijia-api', 'auth.json'))}.qr`;
}

/** Remove only this CLI's named artifacts; never recursively remove the containing directory. */
export async function removeCloudLoginQr(authFile?: string, keepImage?: string): Promise<void> {
  const directory = qrDirectory(authFile);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ConfigError('Unable to list private cloud login QR images', { domain: 'cloud' });
  }
  for (const name of files) {
    if (name !== 'login.png' && !/^login-[a-f0-9]{24}\.png$/.test(name)) continue;
    const path = join(directory, name);
    if (path === keepImage) continue;
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ConfigError('Unable to remove the private cloud login QR image', {
          domain: 'cloud',
        });
      }
    }
  }
  if (keepImage) return;
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      throw new ConfigError('Unable to remove the private cloud login QR directory', {
        domain: 'cloud',
      });
    }
  }
}

function nextLoginCommand(options: {
  authFile?: string;
  timeoutMs: number;
  waitMs: number;
  pretty: boolean;
}) {
  const argv = ['xgg', 'cloud'];
  // Capture the chosen account even when it came from the environment. Absolute
  // paths keep completion attached to the same pending file after a cwd change.
  if (options.authFile !== undefined) argv.push('--auth-file', resolve(options.authFile));
  if (options.timeoutMs !== 15000) argv.push('--timeout', String(options.timeoutMs));
  if (options.pretty) argv.push('--pretty');
  argv.push('login', '--complete');
  if (options.waitMs !== 20000) argv.push('--wait-ms', String(options.waitMs));
  return renderNextCommand(argv);
}

async function renderPending(
  pending: CloudLoginPending,
  options: { authFile?: string; timeoutMs: number; waitMs: number; pretty: boolean },
) {
  const { authFile } = options;
  const directory = qrDirectory(authFile);
  // Image renderers cache by path. A new authorization attempt must have a new
  // image URL; continuation of the same pending attempt deliberately keeps it.
  const id = createHash('sha256')
    .update(JSON.stringify([pending.loginUrl, pending.qrUrl, pending.expiresAt]))
    .digest('hex')
    .slice(0, 24);
  const image = join(directory, `login-${id}.png`);
  const temporary = join(directory, `${randomBytes(8).toString('hex')}.tmp`);
  try {
    // Encode the login payload locally. It is never sent to a QR image service.
    const png = await QRCode.toBuffer(pending.loginUrl, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 320,
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, png, { mode: 0o600, flag: 'wx' });
    await rename(temporary, image);
    await removeCloudLoginQr(authFile, image);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new ConfigError('Unable to create the private cloud login QR image', {
      domain: 'cloud',
    });
  }
  return {
    ...pending,
    ...nextLoginCommand(options),
    qrImagePath: image,
    qrMarkdown: `![米家扫码登录](<${image.replaceAll('>', '%3E').replaceAll('<', '%3C')}>)`,
    instructions:
      '请展示此二维码，并引导用户在到期前用米家 App 扫码、确认登录。等待期间继续运行 nextAction；pending 状态不需要重新生成二维码。',
  };
}

export function cloudLoginCommand(): Command {
  const command = new Command('login')
    .description('Show a Mi Home QR image or complete pending authorization with bounded waiting')
    .option('--complete', 'wait for the existing QR authorization; return pending if still waiting')
    .option('--restart', 'replace pending QR authorization or recover a damaged credential file')
    .option('--wait-ms <ms>', 'scan wait per --complete call, from 1 to 60000 ms', '20000');
  command.action(
    wrap('cloud.login', async () => {
      const opts = command.optsWithGlobals<CloudLoginOpts>();
      if (opts.complete && opts.restart) {
        throw new ConfigError('--complete and --restart cannot be used together', {
          domain: 'cloud',
        });
      }
      const authFile = opts.authFile ?? (process.env.XGG_CLOUD_AUTH_FILE || undefined);
      const runtime = {
        ...(authFile !== undefined && { authFile }),
        timeoutMs: positiveMs(opts.timeout ?? '15000', '--timeout', 120_000),
      };
      const waitMs = positiveMs(opts.waitMs ?? '20000', '--wait-ms', 60_000);
      try {
        if (opts.restart) await removeCloudLoginQr(authFile);
        const result = opts.complete
          ? await cloudLoginComplete({ ...runtime, waitMs })
          : await cloudLoginStart({ ...runtime, ...(opts.restart && { restart: true }) });
        if (result.authenticated) {
          await removeCloudLoginQr(authFile);
          emit({ ok: true, ...result }, { pretty: opts.pretty === true });
        } else {
          const rendered = await renderPending(result, {
            ...runtime,
            waitMs,
            pretty: opts.pretty === true,
          });
          emit({ ok: true, ...rendered }, { pretty: opts.pretty === true });
        }
      } catch (error) {
        if (error instanceof AuthRequiredError && error.details?.reason === 'qr-expired') {
          await removeCloudLoginQr(authFile);
        }
        throw error;
      }
    }),
  );
  return command;
}
