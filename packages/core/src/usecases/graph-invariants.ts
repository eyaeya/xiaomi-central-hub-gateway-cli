export interface GraphInvariantIssue {
  severity: 'warn' | 'error';
  path: string;
  message: string;
}

export interface DuplicateNodeIdGroup {
  id: string;
  indices: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function findDuplicateNodeIds(nodes: unknown[]): DuplicateNodeIdGroup[] {
  const indicesById = new Map<string, number[]>();
  for (let index = 0; index < nodes.length; index += 1) {
    const raw = nodes[index];
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) continue;
    const indices = indicesById.get(raw.id) ?? [];
    indices.push(index);
    indicesById.set(raw.id, indices);
  }
  return [...indicesById.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([id, indices]) => ({ id, indices }));
}

export function duplicateNodeIdIssues(groups: DuplicateNodeIdGroup[]): GraphInvariantIssue[] {
  return groups.map(({ id, indices }) => ({
    severity: 'error',
    path: `nodes[${indices[1]}].id`,
    message: `duplicate node id "${id}" at ${indices.map((index) => `nodes[${index}]`).join(', ')}; node ids must be unique within a graph`,
  }));
}

const STATIC_REQUIRED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  condition: ['trigger'],
  eventSequence: ['input1', 'input2'],
};

/**
 * Return only inputs whose absence prevents every intended node output.
 * Control pins such as loop.stop, counter.zero, and onlyNTimes.zero are
 * deliberately absent. condition.condition is also optional: its unwired
 * gateway default is false, so condition.unmet remains useful. logicOr/signalOr
 * permit unused declared inputs; logicAnd requires every declared state input
 * because an unwired pin remains false and prevents the AND output from
 * becoming true.
 */
export function requiredInputPins(node: Record<string, unknown>): string[] {
  const type = typeof node.type === 'string' ? node.type : '';
  const staticPins = STATIC_REQUIRED_INPUTS[type];
  if (staticPins !== undefined) return [...staticPins];
  if (type !== 'logicAnd' || !isRecord(node.inputs)) return [];
  return Object.keys(node.inputs)
    .filter((pin) => /^input\d+$/.test(pin))
    .sort((a, b) => Number(a.slice('input'.length)) - Number(b.slice('input'.length)));
}

export function missingRequiredInputIssues(
  nodes: Array<{ node: Record<string, unknown>; idx: number }>,
  incomingTargets: ReadonlySet<string>,
  strict: boolean,
): GraphInvariantIssue[] {
  const issues: GraphInvariantIssue[] = [];
  for (const { node, idx } of nodes) {
    const id = typeof node.id === 'string' ? node.id : '';
    const type = typeof node.type === 'string' ? node.type : 'node';
    for (const pin of requiredInputPins(node)) {
      const endpoint = `${id}.${pin}`;
      if (incomingTargets.has(endpoint)) continue;
      issues.push({
        severity: strict ? 'error' : 'warn',
        path: `nodes[${idx}].inputs.${pin}`,
        message: `required input "${endpoint}" has no incoming edge — ${type} cannot produce its intended output until this pin is wired`,
      });
    }
  }
  return issues;
}
