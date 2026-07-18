import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { GcmStream } from '../dist/crypto/gcm.js';
import {
  ConfigError,
  KNOWN_GATEWAY_WRITE_METHODS,
  NetworkError,
  NotConfirmedError,
  agentCall,
  resolveAgentCallKind,
  runAgent,
} from '../dist/index.js';
import { makeFakeTransportPair } from '../dist/transport/fake.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('known write methods stay synchronized with typed core write call sites', async () => {
  const discovered = await discoverTypedWriteMethods(join(repositoryRoot, 'packages/core/src'));
  assert.deepEqual([...KNOWN_GATEWAY_WRITE_METHODS].sort(), [...discovered].sort());
  assert.equal(Object.isFrozen(KNOWN_GATEWAY_WRITE_METHODS), true);
});

test('known writes require explicit write intent before session access', async () => {
  for (const method of KNOWN_GATEWAY_WRITE_METHODS) {
    assert.throws(
      () => resolveAgentCallKind(method),
      (error) =>
        error instanceof ConfigError && /requires explicit write intent/.test(error.message),
    );
    assert.throws(
      () => resolveAgentCallKind(method, 'read'),
      (error) =>
        error instanceof ConfigError && /requires explicit write intent/.test(error.message),
    );
    assert.equal(resolveAgentCallKind(method, 'write'), 'write');
  }

  let storeReads = 0;
  await assert.rejects(
    agentCall({
      baseUrl: 'http://intent.test',
      method: '/api/setVarValue',
      params: {},
      store: {
        read: async () => {
          storeReads += 1;
          throw new Error('store must not be read');
        },
      },
    }),
    ConfigError,
  );
  assert.equal(storeReads, 0);
});

test('unknown future methods remain open to explicit read or write intent', () => {
  assert.equal(resolveAgentCallKind('/api/futureMethod'), 'read');
  assert.equal(resolveAgentCallKind('/api/futureMethod', 'read'), 'read');
  assert.equal(resolveAgentCallKind('/api/futureMethod', 'write'), 'write');
  assert.throws(
    () => resolveAgentCallKind('/api/futureMethod', 'delete'),
    (error) => error instanceof ConfigError && /either "read" or "write"/.test(error.message),
  );
});

test('daemon router timeouts classify write as unconfirmed and read as network', async (t) => {
  const [transport] = makeFakeTransportPair();
  let handler;
  const agent = await runAgent({
    createServer: async (options) => {
      handler = options.handler;
      return { close: async () => {} };
    },
    handshake: handshakeFixture(),
    host: 'http://intent-daemon.test',
    idleMs: 60_000,
    socketPath: '/unused/intent-daemon.sock',
    transport,
  });
  t.after(async () => {
    await agent.stop();
  });
  assert.equal(typeof handler, 'function');

  await assert.rejects(
    handler({
      kind: 'write',
      method: '/api/futureDaemonWrite',
      params: {},
      timeoutMs: 50,
    }),
    (error) => error instanceof NotConfirmedError,
  );
  await assert.rejects(
    handler({
      kind: 'read',
      method: '/api/futureDaemonRead',
      params: {},
      timeoutMs: 50,
    }),
    (error) => error instanceof NetworkError,
  );
});

function handshakeFixture() {
  const key = Buffer.alloc(16, 1);
  const clientSalt = Buffer.alloc(8, 2);
  const serverSalt = Buffer.alloc(8, 3);
  return {
    clientKey: key,
    clientRecv: new GcmStream({ key, salt: serverSalt, direction: 'recv' }),
    clientSalt,
    clientSend: new GcmStream({ key, salt: clientSalt, direction: 'send' }),
    serverKey: key,
    serverSalt,
  };
}

async function discoverTypedWriteMethods(root) {
  const methods = new Set();
  for (const file of await sourceFiles(root)) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = calledName(node.expression);
      if (name === 'callBackup') {
        if (node.arguments.some((argument) => stringValue(argument) === 'write')) {
          const method = stringValue(node.arguments[1]);
          if (method !== undefined) methods.add(method);
        }
        return;
      }
      if (name !== 'agentCall') return;
      const options = node.arguments[0];
      if (!ts.isObjectLiteralExpression(options)) return;
      const kind = objectStringProperty(options, 'kind');
      const method = objectStringProperty(options, 'method');
      if (kind === 'write' && method !== undefined) methods.add(method);
    });
  }
  return methods;
}

function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function objectStringProperty(object, name) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (propertyName === name) return stringValue(property.initializer);
  }
  return undefined;
}

function stringValue(node) {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;
}

function visit(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}
