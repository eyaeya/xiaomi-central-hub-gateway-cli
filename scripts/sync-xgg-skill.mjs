#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKER_PREFIX = '<!-- xgg-skill-content-build:';
const MARKER_PATTERN = /^<!-- xgg-skill-content-build: sha256-([0-9a-f]{64}) -->\r?$/gm;
const MARKER_LINE_PATTERN = /^<!-- xgg-skill-content-build: sha256-[0-9a-f]{64} -->\r?\n?/gm;

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultSourceDir = path.join(repositoryRoot, 'skills', 'xgg-rule-authoring');
const defaultPackageTargetDir = path.join(
  repositoryRoot,
  'packages',
  'cli',
  'skills',
  'xgg-rule-authoring',
);

async function validateSkillRoot(root, label, { mustExist }) {
  const resolved = path.resolve(root);
  if (path.basename(resolved) !== 'xgg-rule-authoring') {
    throw new Error(`${label} must end in an exact xgg-rule-authoring directory`);
  }
  try {
    const info = await lstat(resolved);
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  } catch (error) {
    if (
      mustExist !== true &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return resolved;
    }
    throw error;
  }
  return resolved;
}

function rootsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function validateRoots({ sourceDir, packageTargetDir, installedTargetDir }) {
  const roots = {
    sourceDir: await validateSkillRoot(sourceDir, 'Canonical Skill source', { mustExist: true }),
    packageTargetDir: await validateSkillRoot(packageTargetDir, 'Package Skill target', {
      mustExist: false,
    }),
  };
  if (installedTargetDir !== undefined) {
    roots.installedTargetDir = await validateSkillRoot(
      installedTargetDir,
      'Explicit installed Skill target',
      { mustExist: false },
    );
  }

  const entries = Object.entries(roots);
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftLabel, leftRoot] = entries[leftIndex];
      const [rightLabel, rightRoot] = entries[rightIndex];
      if (rootsOverlap(leftRoot, rightRoot) || rootsOverlap(rightRoot, leftRoot)) {
        throw new Error(`${leftLabel} and ${rightLabel} must not overlap`);
      }
    }
  }
  return roots;
}

async function listTree(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listTree(root, child)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Skill trees may contain only regular files: ${child}`);
    }
    files.push(child);
  }
  return files.sort();
}

function stripBuildMarker(bytes, relativePath) {
  if (relativePath !== 'SKILL.md') return bytes;
  const content = bytes.toString('utf8');
  const matches = [...content.matchAll(MARKER_PATTERN)];
  if (matches.length !== 1) {
    throw new Error('SKILL.md must contain exactly one lowercase SHA-256 build marker');
  }
  return Buffer.from(content.replace(MARKER_LINE_PATTERN, ''), 'utf8');
}

async function readTree(root, { stripMarker = false } = {}) {
  const files = await listTree(root);
  return Promise.all(
    files.map(async (relativePath) => {
      const bytes = await readFile(path.join(root, ...relativePath.split('/')));
      return {
        bytes: stripMarker ? stripBuildMarker(bytes, relativePath) : bytes,
        relativePath,
      };
    }),
  );
}

export async function computeSkillTreeDigest(sourceDir) {
  const entries = await readTree(sourceDir, { stripMarker: true });
  const digest = createHash('sha256');
  for (const { bytes, relativePath } of entries) {
    digest.update(relativePath, 'utf8');
    digest.update('\0');
    digest.update(String(bytes.length), 'utf8');
    digest.update('\0');
    digest.update(bytes);
  }
  return digest.digest('hex');
}

async function readStoredDigest(sourceDir) {
  const skill = await readFile(path.join(sourceDir, 'SKILL.md'), 'utf8');
  const matches = [...skill.matchAll(MARKER_PATTERN)];
  if (matches.length !== 1) {
    throw new Error('SKILL.md must contain exactly one lowercase SHA-256 build marker');
  }
  return matches[0][1];
}

async function compareTrees(sourceDir, targetDir, label) {
  const [sourceEntries, targetEntries] = await Promise.all([
    readTree(sourceDir),
    readTree(targetDir),
  ]);
  const sourceFiles = sourceEntries.map(({ relativePath }) => relativePath);
  const targetFiles = targetEntries.map(({ relativePath }) => relativePath);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) {
    throw new Error(`${label} file list differs from the canonical Skill tree`);
  }
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const source = sourceEntries[index];
    const target = targetEntries[index];
    if (!source.bytes.equals(target.bytes)) {
      throw new Error(`${label} differs from the canonical Skill at ${source.relativePath}`);
    }
  }
}

async function copyTree(sourceDir, targetDir) {
  const sourceEntries = await readTree(sourceDir);
  const sourceFiles = new Set(sourceEntries.map(({ relativePath }) => relativePath));

  await mkdir(targetDir, { recursive: true });
  const targetFiles = await listTree(targetDir);
  for (const relativePath of targetFiles) {
    if (sourceFiles.has(relativePath)) continue;
    await rm(path.join(targetDir, ...relativePath.split('/')), { force: true });
  }

  for (const { bytes, relativePath } of sourceEntries) {
    const destination = path.join(targetDir, ...relativePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

export async function checkSkillSync({
  sourceDir = defaultSourceDir,
  packageTargetDir = defaultPackageTargetDir,
  installedTargetDir,
} = {}) {
  ({ sourceDir, packageTargetDir, installedTargetDir } = await validateRoots({
    sourceDir,
    packageTargetDir,
    installedTargetDir,
  }));
  const [storedDigest, computedDigest] = await Promise.all([
    readStoredDigest(sourceDir),
    computeSkillTreeDigest(sourceDir),
  ]);
  if (storedDigest !== computedDigest) {
    throw new Error(
      `Skill build marker is stale: stored sha256-${storedDigest}, expected sha256-${computedDigest}`,
    );
  }

  await compareTrees(sourceDir, packageTargetDir, 'Packaged Skill mirror');
  if (installedTargetDir !== undefined) {
    await compareTrees(sourceDir, installedTargetDir, 'Explicit installed Skill target');
  }
  return computedDigest;
}

export async function writeSkillSync({
  sourceDir = defaultSourceDir,
  packageTargetDir = defaultPackageTargetDir,
  installedTargetDir,
} = {}) {
  ({ sourceDir, packageTargetDir, installedTargetDir } = await validateRoots({
    sourceDir,
    packageTargetDir,
    installedTargetDir,
  }));
  const computedDigest = await computeSkillTreeDigest(sourceDir);
  const skillPath = path.join(sourceDir, 'SKILL.md');
  const skill = await readFile(skillPath, 'utf8');
  const markerMatches = [...skill.matchAll(MARKER_PATTERN)];
  if (markerMatches.length !== 1) {
    throw new Error('SKILL.md must contain exactly one lowercase SHA-256 build marker');
  }
  const nextMarker = `${MARKER_PREFIX} sha256-${computedDigest} -->`;
  await writeFile(skillPath, skill.replace(MARKER_PATTERN, nextMarker));

  await copyTree(sourceDir, packageTargetDir);
  if (installedTargetDir !== undefined) {
    await copyTree(sourceDir, installedTargetDir);
  }
  await checkSkillSync({ sourceDir, packageTargetDir, installedTargetDir });
  return computedDigest;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/sync-xgg-skill.mjs --check [--installed-target <directory>]',
    '  node scripts/sync-xgg-skill.mjs --write [--installed-target <directory>]',
    '',
    'The repository Skill is canonical. The package mirror is always checked or updated.',
    'An installed Skill is touched only when --installed-target is supplied explicitly.',
    'Every target must end in an exact xgg-rule-authoring directory.',
  ].join('\n');
}

function parseArguments(args) {
  let mode;
  let installedTargetDir;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check' || argument === '--write') {
      if (mode !== undefined) throw new Error('Choose exactly one of --check or --write');
      mode = argument.slice(2);
      continue;
    }
    if (argument === '--installed-target') {
      if (installedTargetDir !== undefined || args[index + 1] === undefined) {
        throw new Error('--installed-target requires exactly one directory');
      }
      installedTargetDir = path.resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') return { help: true };
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (mode === undefined) throw new Error('Choose exactly one of --check or --write');
  return { installedTargetDir, mode };
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const digest =
        options.mode === 'write'
          ? await writeSkillSync({ installedTargetDir: options.installedTargetDir })
          : await checkSkillSync({ installedTargetDir: options.installedTargetDir });
      process.stdout.write(`xgg-rule-authoring Skill ${options.mode} ok: sha256-${digest}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
    process.exitCode = 1;
  }
}
