import { z } from 'zod';

/** Updates follow the stable release channel only; reject ambiguous numeric versions. */
export const StableVersion = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine((value) => value.split('.').every((part) => Number.isSafeInteger(Number(part))));

export const UpdateHttpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      );
    } catch {
      return false;
    }
  });

/** The version endpoint is a package manifest, not the complete registry packument. */
export const UpdatePackageMetadata = z
  .object({
    name: z.literal('@eyaeya/xgg-cli'),
    version: StableVersion,
    dependencies: z.object({ '@eyaeya/xgg-core': z.string().max(80) }),
    engines: z.object({ node: z.string().min(1).max(200) }).optional(),
    dist: z.object({
      tarball: UpdateHttpsUrl,
      integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
    }),
  })
  .refine(
    (manifest) =>
      [manifest.version, `^${manifest.version}`, `~${manifest.version}`].includes(
        manifest.dependencies['@eyaeya/xgg-core'],
      ),
    { message: 'The CLI and core dependency must use the same stable release version' },
  );

export type UpdatePackageMetadata = z.infer<typeof UpdatePackageMetadata>;
