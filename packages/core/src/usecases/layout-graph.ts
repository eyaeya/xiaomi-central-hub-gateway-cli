// Flow-aware layered layout for a wired rule graph (Sugiyama-lite).
//
// The per-node auto-layout in card-geometry.ts flows cards by INSERTION order —
// it runs at `rule node add` time, before edges exist, so it can't know the
// data flow. Once a rule is fully wired, `rule layout` re-positions every card
// by its connections instead.
//
// Conventions reverse-engineered from how a human arranged a complex rule
// (`样例：手动创建复杂案例`, 2026-05-29 — see docs/api/nodes.md §Card geometry):
//   1. each WEAKLY-CONNECTED COMPONENT (independent sub-automation) is a
//      horizontal band; components stack vertically.
//   2. within a component, X grows with DATA-FLOW DEPTH (longest-path layering):
//      triggers/sources leftmost, every node strictly right of ALL its inputs.
//   3. branches in the same layer STACK VERTICALLY; within-layer order follows
//      the predecessor barycenter to reduce edge crossings.

export interface LayoutGraphNode {
  id: string;
  width: number;
  height: number;
}
export interface LayoutGraphEdge {
  from: string;
  to: string;
}
export interface LayoutGraphInput {
  nodes: LayoutGraphNode[];
  edges: LayoutGraphEdge[];
}

// Spacing. COL_GAP separates flow layers (edges need horizontal room); ROW_GAP
// separates stacked branches; COMPONENT_GAP separates independent automations.
const MARGIN = 40;
const COL_GAP = 80;
const ROW_GAP = 40;
const COMPONENT_GAP = 120;

/**
 * Compute a flow-aware position for every node. Pure + deterministic. Cycles
 * (which the gateway permits) are handled without infinite recursion by
 * treating a back-edge's target as a layering source. Isolated nodes (no edges)
 * each form their own single-card component. Returns `{ [id]: {x, y} }`.
 */
export function layoutGraph(input: LayoutGraphInput): Record<string, { x: number; y: number }> {
  const { nodes, edges } = input;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const order = new Map(nodes.map((node, i) => [node.id, i]));

  const pred = new Map<string, string[]>();
  for (const node of nodes) pred.set(node.id, []);
  for (const e of edges) {
    if (e.from !== e.to && byId.has(e.from) && byId.has(e.to)) {
      pred.get(e.to)?.push(e.from);
    }
  }

  // 1. weakly-connected components via union-find.
  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const e of edges) {
    if (byId.has(e.from) && byId.has(e.to)) parent.set(find(e.from), find(e.to));
  }
  const components = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node.id);
    const list = components.get(root) ?? [];
    list.push(node.id);
    components.set(root, list);
  }

  // 2. longest-path layer, cycle-safe (back-edge → treated as source).
  const layer = new Map<string, number>();
  const onStack = new Set<string>();
  const computeLayer = (id: string): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (onStack.has(id)) return 0;
    onStack.add(id);
    let depth = 0;
    for (const p of pred.get(id) ?? []) depth = Math.max(depth, computeLayer(p) + 1);
    onStack.delete(id);
    layer.set(id, depth);
    return depth;
  };
  for (const node of nodes) computeLayer(node.id);

  // process components top-to-bottom in a stable order (by their earliest node).
  const compList = [...components.values()].sort(
    (a, b) =>
      Math.min(...a.map((id) => order.get(id) ?? 0)) -
      Math.min(...b.map((id) => order.get(id) ?? 0)),
  );

  const pos: Record<string, { x: number; y: number }> = {};
  let bandTop = MARGIN;

  for (const compIds of compList) {
    const maxLayer = Math.max(0, ...compIds.map((id) => layer.get(id) ?? 0));
    const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
    for (const id of compIds) layers[layer.get(id) ?? 0]?.push(id);

    // within-layer order: layer 0 by node order; deeper layers by the mean
    // position of their predecessors in the layer above (barycenter heuristic).
    const layerIndex = new Map<string, number>();
    const orderLayer = (ids: string[], depth: number) => {
      if (depth === 0) {
        ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      } else {
        const bary = (id: string): number => {
          const ps = (pred.get(id) ?? [])
            .filter((p) => layer.get(p) === depth - 1)
            .map((p) => layerIndex.get(p) ?? 0);
          return ps.length > 0 ? ps.reduce((s, v) => s + v, 0) / ps.length : (order.get(id) ?? 0);
        };
        ids.sort((a, b) => bary(a) - bary(b));
      }
      ids.forEach((id, i) => layerIndex.set(id, i));
    };
    for (let depth = 0; depth < layers.length; depth += 1) orderLayer(layers[depth] ?? [], depth);

    // X per layer = running sum of each prior layer's widest card + COL_GAP.
    const colX: number[] = [];
    let cursorX = 0;
    for (let depth = 0; depth < layers.length; depth += 1) {
      colX[depth] = cursorX;
      const widest = Math.max(0, ...(layers[depth] ?? []).map((id) => byId.get(id)?.width ?? 0));
      cursorX += widest + COL_GAP;
    }

    // Y per layer = stack from the band top; track the band's bottom for the
    // next component.
    let compBottom = bandTop;
    for (let depth = 0; depth < layers.length; depth += 1) {
      let cursorY = bandTop;
      for (const id of layers[depth] ?? []) {
        const node = byId.get(id);
        if (node === undefined) continue;
        pos[id] = { x: MARGIN + (colX[depth] ?? 0), y: cursorY };
        compBottom = Math.max(compBottom, cursorY + node.height);
        cursorY += node.height + ROW_GAP;
      }
    }
    bandTop = compBottom + COMPONENT_GAP;
  }

  return pos;
}
