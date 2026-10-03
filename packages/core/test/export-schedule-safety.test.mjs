import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, addNode, exportRuleFromView } from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-10-03T00:00:00.000Z';

function summary() {
  return {
    id: 'scheduleRule',
    enable: true,
    uiType: 'rule',
    userData: {
      name: 'schedule export safety',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function scheduleNode(form, filter) {
  const type = form === 'timeRange' ? 'timeRange' : 'alarmClock';
  return {
    id: 'schedule',
    type,
    cfg: {
      pos: { x: 0, y: 0, width: 320, height: 120 },
      name: type,
      version: 1,
      ...(type === 'alarmClock' && { happenType: 'now', tempOffset: 0 }),
    },
    inputs: {},
    outputs: { output: [] },
    props:
      form === 'timeRange'
        ? {
            start: { hour: 6, minute: 0, second: 0 },
            end: { hour: 7, minute: 0, second: 0 },
            filter,
          }
        : form === 'sunset'
          ? { type: 'sunset', isSunset: true, offset: 0, latitude: 30, longitude: 114, filter }
          : { type: 'periodicAlarm', isSunset: false, hour: 6, minute: 0, second: 0, filter },
  };
}

function exportNode(node, strictRoundtrip, cfg = summary()) {
  return exportRuleFromView(
    { id: cfg.id, cfg, nodes: [node] },
    { baseUrl, store: {} },
    undefined,
    strictRoundtrip,
  );
}

test('strict and permissive export refuse empty weekday schedules before producing replay', async () => {
  for (const form of ['periodicAlarm', 'sunset', 'timeRange']) {
    for (const strict of [false, true]) {
      const node = scheduleNode(form, { day: [] });
      await assert.rejects(
        exportNode(node, strict),
        (error) =>
          error instanceof ConfigError &&
          /props\.filter\.day is empty/.test(error.message) &&
          /every day/.test(error.message) &&
          error.details.nodeId === node.id,
        `${form}, strict=${strict}`,
      );
    }
  }
});

test('supported day filters preserve the saved schedule through export and typed replay', async () => {
  const state = { cfg: { ...summary(), enable: false }, nodes: [] };
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-schedule-export-unused.sock',
        agentStartedAt: startedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: startedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
        if (method === '$mutation.acquire') return { leaseId: 'schedule-export-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        if (method === '/api/getGraphList') return [structuredClone(state.cfg)];
        if (method === '/api/getGraph')
          return { id: state.cfg.id, nodes: structuredClone(state.nodes) };
        if (method === '/api/setGraph') {
          state.cfg = structuredClone(params.cfg);
          state.nodes = structuredClone(params.nodes);
          return null;
        }
        throw new Error(`unexpected RPC: ${method}`);
      },
      close: () => {},
    }),
  };

  for (const form of ['periodicAlarm', 'sunset', 'timeRange']) {
    for (const filter of [{}, { inHoliday: false }, { inHoliday: true }, { day: [0, 2, 6] }]) {
      const node = scheduleNode(form, filter);
      const exported = await exportNode(node, true);
      assert.deepEqual(exported.warnings, []);
      const command = exported.commands.find((candidate) => candidate.kind === 'node-add');
      const flags = new Map(command.flags.map((flag) => [flag.name, flag.value]));
      const shortcut = {
        id: node.id,
        type: node.type,
        ...(form === 'periodicAlarm' && { at: flags.get('--at') }),
        ...(form === 'sunset' && {
          sunset: flags.has('--sunset'),
          latitude: Number(flags.get('--latitude')),
          longitude: Number(flags.get('--longitude')),
          offsetMin: Number(flags.get('--offset-min')),
        }),
        ...(form === 'timeRange' && { start: flags.get('--start'), end: flags.get('--end') }),
        ...(flags.has('--weekday-only') && { weekdayOnly: true }),
        ...(flags.has('--holiday-only') && { holidayOnly: true }),
        ...(flags.has('--days') && { days: flags.get('--days').split(',').map(Number) }),
      };
      state.nodes = [];
      await addNode({ ruleId: state.cfg.id, shortcut, varCheck: false }, deps);
      assert.deepEqual(state.nodes[0].props, node.props, `${form}: ${JSON.stringify(filter)}`);
    }
  }
});

test('export retains rule config extensions while staging replay disabled', async () => {
  const cfg = {
    ...summary(),
    firmwareMetadata: { revision: 2, nested: ['retained', false] },
  };
  const original = structuredClone(cfg);
  const exported = await exportNode(scheduleNode('periodicAlarm', { day: [1] }), true, cfg);
  const command = exported.commands.find((candidate) => candidate.kind === 'rule-set-body');
  assert.deepEqual(JSON.parse(command.bodyJson).cfg, { ...cfg, enable: false });
  assert.equal(
    exported.commands.some((candidate) => candidate.kind === 'rule-enable'),
    true,
  );
  assert.deepEqual(cfg, original);
});
