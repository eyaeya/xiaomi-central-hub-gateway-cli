// Per-card-type canvas geometry for synthesized nodes.
//
// WHY: the web canvas renders a card at the `cfg.pos.width`/`height` saved in
// the graph — it does NOT recompute the size on load. The CLI used to emit a
// single tiny default (`200×120` for every non-device card, a few fixed sizes
// for device cards), so most cards rendered too small and their parameter rows
// overflowed; and every non-device card shared `(200,200)`, so they all stacked
// on top of each other. This module gives each node type a box ≥ its real
// content, and flows consecutive nodes tightly so they neither overflow nor
// overlap.
//
// SIZES: each card has an EDITING size (shows params) and a SIMPLIFIED size
// (name + endpoints only). UI-authored rules save cards in the editing state
// (`cfg.simplified` unset), so we emit the editing size. Values come from the
// canvas node `size` defs (static cards) and from the observed editing
// dimensions of UI-authored rules (dynamic device/var/expr cards). Chosen ≥ the
// largest real value so content never overflows; a slightly-too-large box only
// leaves blank space (harmless). Values are derived from the official
// gateway rule-editor web canvas node `size:` defs (reverse-engineered)
// plus an aggregation over 53 UI-authored rules.
//
// LAYOUT: the web UI does NOT auto-arrange cards (it drops them at the cursor /
// viewport centre — no inter-card gap constant exists in the bundle), so the
// flow layout below is purely the CLI's own affordance. It packs each new card
// immediately to the right of the previous one (prev.x + prev.width + GAP),
// wrapping to a new row past MAX_X. This replaces a fixed 800×280 grid cell that
// left ~600px of blank space beside narrow cards.

export interface CardSize {
  width: number;
  height: number;
  // varSetNumber / varSetString carry the expr-editor pane height inside pos.
  exprHeight?: number;
}

export const CARD_SIZE: Record<string, CardSize> = {
  // device cards — editing size is content-dependent; use the observed max.
  deviceInput: { width: 584, height: 206 },
  deviceGet: { width: 700, height: 240 },
  deviceOutput: { width: 684, height: 204 },
  deviceInputSetVar: { width: 554, height: 206 },
  deviceGetSetVar: { width: 566, height: 200 },
  // time cards
  alarmClock: { width: 512, height: 152 },
  timeRange: { width: 524, height: 152 },
  delay: { width: 320, height: 120 },
  statusLast: { width: 340, height: 140 },
  // flow-control cards
  condition: { width: 320, height: 140 },
  loop: { width: 510, height: 160 },
  onlyNTimes: { width: 382, height: 160 },
  counter: { width: 328, height: 160 },
  // logic cards (narrow)
  signalOr: { width: 340, height: 180 },
  logicOr: { width: 240, height: 120 },
  logicAnd: { width: 240, height: 120 },
  logicNot: { width: 240, height: 120 },
  // other cards
  onLoad: { width: 200, height: 120 },
  nop: { width: 320, height: 60 },
  eventSequence: { width: 524, height: 180 },
  register: { width: 340, height: 140 },
  modeSwitch: { width: 280, height: 160 },
  // variable cards
  varChange: { width: 532, height: 160 },
  varGet: { width: 532, height: 200 },
  varSetNumber: { width: 740, height: 220, exprHeight: 30 },
  varSetString: { width: 712, height: 220, exprHeight: 30 },
};

// Generous fallback for a node type we haven't sized yet (forward-compat) —
// matches the UI's own unsized-card fallback (pe=400, fe=150).
const FALLBACK_SIZE: CardSize = { width: 400, height: 150 };

// Flow-layout constants. GAP/ROW_GAP are tight (the user found 800px-per-card
// spacing far too large); MAX_X wraps a row at a screen-friendly width. Two of
// the widest cards (740) plus a gap (740+24+740 = 1504) still fit one row.
const LAYOUT = { margin: 40, gap: 24, rowGap: 24, maxX: 1600 };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isFiniteRect(r: unknown): r is Rect {
  if (r === null || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    Number.isFinite(o.x) &&
    Number.isFinite(o.y) &&
    Number.isFinite(o.width) &&
    Number.isFinite(o.height)
  );
}

/**
 * Tight flow position for a new card given the cards already on the canvas.
 * Packs the new card immediately to the right of the last-placed card
 * (`prev.x + prev.width + gap`, same row); when that would run past `maxX`,
 * wraps to a new row below everything (`max bottom edge + rowGap`). With an
 * empty canvas the first card sits at the top-left margin.
 *
 * Sizes drive the spacing (the gap is added to the *previous card's actual
 * width*), so narrow cards pack densely and wide cards still clear each other —
 * no overlap for any sequence (within-row cards are gap-separated; rows clear
 * the tallest card above them). Deterministic; users can re-drag in the web UI.
 */
export function nextCardPosition(
  existing: readonly unknown[],
  size: { width: number; height: number },
): { x: number; y: number } {
  const rects = existing.filter(isFiniteRect);
  if (rects.length === 0) return { x: LAYOUT.margin, y: LAYOUT.margin };

  const prev = rects[rects.length - 1] as Rect;
  let x = prev.x + prev.width + LAYOUT.gap;
  let y = prev.y;
  if (x + size.width > LAYOUT.maxX) {
    const maxBottom = Math.max(...rects.map((r) => r.y + r.height));
    x = LAYOUT.margin;
    y = maxBottom + LAYOUT.rowGap;
  }
  return { x, y };
}

/**
 * A `cfg.pos` with the correct width/height (and `exprHeight` for expr cards)
 * for `type`, and a placeholder `{x:0,y:0}` origin. Callers that auto-layout
 * overwrite x/y via {@link nextCardPosition}; callers with an explicit position
 * pass their own pos and never call this.
 */
export function sizedPos(type: string): {
  x: number;
  y: number;
  width: number;
  height: number;
  exprHeight?: number;
} {
  const size = CARD_SIZE[type] ?? FALLBACK_SIZE;
  return {
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    ...(size.exprHeight !== undefined && { exprHeight: size.exprHeight }),
  };
}
