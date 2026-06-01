// Faithful 1:1 port of the official gateway's arithmetic-expression validator —
// the same parser the web rule-editor runs when you press "保存" on a 数值运算
// (varSetNumber) card. It validates the assembled element template (const →
// value, var → "$"). The official save() flow shows `运算式不合法` and blocks
// the save when this throws.
//
// PARITY CONTRACT (verified against the real gateway, 2026-05-29): this MUST
// accept/reject exactly what the gateway parser does — no stricter, no looser.
// Do not "improve" the grammar. Quirks deliberately preserved for fidelity:
//   - leading unary +/- works via the "empty left operand counts as 1" rule;
//   - `String.charAt(-1)` returns "" (not undefined), so a +/- at index 0 is
//     treated as a binary op whose left side is empty → valid;
//   - `Number("Infinity")`/hex/scientific pass because `Number(token)` is used
//     verbatim; only the literal `$` placeholder bypasses the numeric parse;
//   - `check` returns an "arg count" (comma sums children); a bare top-level
//     comma list does NOT throw, matching the gateway (the per-card check only
//     cares whether it throws, never inspects the returned count).

// Distinct failure modes the parser can report. Mirrors the gateway's throw
// sites 1:1 — every `throw new Error(...)` in checkExpr maps to one kind. The
// two `'Impossible'` defensive branches map to `internal` (they cannot fire
// for real input but are kept for parity with the gateway control flow).
export type ExprErrorKind =
  | 'bracket' // unbalanced parentheses
  | 'expression' // a binary operator's operand is not a single value
  | 'function' // unknown function name
  | 'argCount' // wrong number of arguments for a function
  | 'number' // an operand is empty or not a number / `$`
  | 'internal'; // defensive branch (should be unreachable)

// Thrown by checkExpr. Carries the failure kind so callers can render a
// specific, localized diagnostic instead of a generic "运算式不合法".
export class ExprSyntaxError extends Error {
  readonly kind: ExprErrorKind;
  constructor(kind: ExprErrorKind, message: string) {
    super(message);
    this.name = 'ExprSyntaxError';
    this.kind = kind;
  }
}

interface OpDef {
  name: 'comma' | 'add' | 'substract' | 'multiply' | 'devide' | 'modulo' | 'func' | 'number';
  pri: number;
}

const OPS: Record<OpDef['name'], OpDef> = {
  comma: { name: 'comma', pri: 0 },
  add: { name: 'add', pri: 1 },
  substract: { name: 'substract', pri: 1 },
  multiply: { name: 'multiply', pri: 2 },
  devide: { name: 'devide', pri: 2 },
  modulo: { name: 'modulo', pri: 2 },
  func: { name: 'func', pri: 3 },
  number: { name: 'number', pri: 4 },
};

// Gateway built-in function table. `""` (empty function name) is the plain
// grouping-paren case (argc 1). `max`/`min` are variadic (minArgc 1); the rest
// are fixed-arity.
const FUNCS: Record<string, { argc?: number; minArgc?: number }> = {
  '': { argc: 1 },
  abs: { argc: 1 },
  pow: { argc: 2 },
  log: { argc: 2 },
  sin: { argc: 1 },
  cos: { argc: 1 },
  tan: { argc: 1 },
  asin: { argc: 1 },
  acos: { argc: 1 },
  atan: { argc: 1 },
  max: { minArgc: 1 },
  min: { minArgc: 1 },
  round: { argc: 1 },
  floor: { argc: 1 },
  ceil: { argc: 1 },
  rand: { argc: 0 },
  randint: { argc: 2 },
  now: { argc: 0 },
  year: { argc: 0 },
  month: { argc: 0 },
  date: { argc: 0 },
  day: { argc: 0 },
  hours: { argc: 0 },
  minutes: { argc: 0 },
  seconds: { argc: 0 },
  pi: { argc: 0 },
  e: { argc: 0 },
};

const BINARY_OPS: Record<string, OpDef> = {
  ',': OPS.comma,
  '+': OPS.add,
  '-': OPS.substract,
  '*': OPS.multiply,
  '/': OPS.devide,
  '%': OPS.modulo,
};

const UNARY_PRECEDERS = ['e', '+', '-', '*', '/', '%'];

// Recursive-descent split-on-lowest-precedence checker. Returns the "arg
// count" of the (sub)expression; throws on any malformed input. Mirrors the
// gateway control flow byte-for-byte.
function checkExpr(input: string): number {
  let splitIdx: number | undefined;
  const e = input.trim();
  let chosen: OpDef = OPS.number;
  let depth = 0;

  for (let a = 0; a < e.length; a += 1) {
    const ch = e.charAt(a);
    if (ch === '(') {
      if (depth === 0 && chosen.pri > OPS.func.pri) {
        chosen = OPS.func;
        splitIdx = a;
      }
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (ch === '-' || ch === '+') {
      let t2 = a - 1;
      while (t2 >= 0 && e.charAt(t2) === ' ') t2 -= 1;
      // charAt(-1) === "" — not in UNARY_PRECEDERS → treated as a binary op
      // whose left side is empty (handled by the add/substract case below).
      if (UNARY_PRECEDERS.includes(e.charAt(t2))) continue;
    }
    const op = BINARY_OPS[ch];
    if (op !== undefined && op.pri <= chosen.pri) {
      chosen = op;
      splitIdx = a;
    }
  }

  if (depth !== 0) throw new ExprSyntaxError('bracket', 'Bracket error');

  let result = Number.NaN;
  switch (chosen.name) {
    case 'comma': {
      if (splitIdx === undefined) throw new ExprSyntaxError('internal', 'Impossible');
      return checkExpr(e.slice(0, splitIdx)) + checkExpr(e.slice(splitIdx + 1));
    }
    case 'add':
    case 'substract': {
      if (splitIdx === undefined) throw new ExprSyntaxError('internal', 'Impossible');
      const left = e.slice(0, splitIdx);
      const lc = left.trim().length === 0 ? 1 : checkExpr(left);
      const rc = checkExpr(e.slice(splitIdx + 1));
      if (lc !== 1) throw new ExprSyntaxError('expression', 'Invalid expression');
      if (rc !== 1) throw new ExprSyntaxError('expression', 'Invalid expression');
      result = 1;
      break;
    }
    case 'multiply':
    case 'devide':
    case 'modulo': {
      if (splitIdx === undefined) throw new ExprSyntaxError('internal', 'Impossible');
      const lc = checkExpr(e.slice(0, splitIdx));
      const rc = checkExpr(e.slice(splitIdx + 1));
      if (lc !== 1) throw new ExprSyntaxError('expression', 'Invalid expression');
      if (rc !== 1) throw new ExprSyntaxError('expression', 'Invalid expression');
      result = 1;
      break;
    }
    case 'func': {
      if (splitIdx === undefined) throw new ExprSyntaxError('internal', 'Impossible');
      const fname = e.slice(0, splitIdx).trim();
      const fdef = FUNCS[fname];
      if (fdef === undefined) throw new ExprSyntaxError('function', 'Invalid function');
      let argCount = 0;
      const inner = e.slice(splitIdx + 1, e.length - 1);
      if (!/^\s*$/.test(inner)) argCount = checkExpr(inner);
      if (fdef.argc !== undefined && argCount !== fdef.argc) {
        throw new ExprSyntaxError('argCount', 'Invalid arg count');
      }
      if (fdef.minArgc !== undefined && argCount < fdef.minArgc) {
        throw new ExprSyntaxError('argCount', 'invalid arg count');
      }
      result = 1;
      break;
    }
    case 'number': {
      if (/^\s*$/.test(e)) throw new ExprSyntaxError('number', 'Invalid number');
      if (e !== '$' && Number.isNaN(Number(e)))
        throw new ExprSyntaxError('number', 'Invalid number');
      result = 1;
      break;
    }
  }

  if (Number.isNaN(result)) throw new ExprSyntaxError('internal', 'Math error');
  return result;
}

// varSetNumber element → template fragment. Match the gateway's own assembly
// EXACTLY: `elements.map(e => "const" === e.type ? e.value : "$").join("")` —
// a `const` contributes its value; EVERY other element (a `var`, an unknown
// future type, or even a non-object entry) collapses to the `$` placeholder. An
// earlier else→"" diverged from the gateway for non-const/non-var elements,
// breaking the parity contract (no stricter / no looser).
function assembleExprTemplate(elements: unknown[]): string {
  let template = '';
  for (const el of elements) {
    const isConst =
      el !== null &&
      typeof el === 'object' &&
      !Array.isArray(el) &&
      (el as Record<string, unknown>).type === 'const';
    template += isConst ? String((el as Record<string, unknown>).value ?? '') : '$';
  }
  return template;
}

// Localized, actionable diagnostic per failure kind. The gateway only ever
// shows the blanket `运算式不合法`; the CLI can do better because it owns the
// faithful parser. Kept terse so it fits one stderr line + the JSON `message`.
const DIAGNOSTICS: Record<ExprErrorKind, string> = {
  bracket: '括号不匹配（检查 ( 与 ) 是否成对）',
  expression: '运算符两侧的操作数不合法（每个 + - * / % 左右须各是一个值）',
  function: '未知函数（检查拼写与大小写；无参函数也要带括号，如 rand()）',
  argCount: '函数参数个数不对（用 ASCII 逗号分隔；固定参数函数参数数须精确匹配）',
  number: '存在空操作数或非数字 token（变量请用 $id / $scope.id 引用）',
  internal: '表达式解析内部错误',
};

export interface ExprCheckResult {
  /** true when the gateway parser would accept this expression. */
  ok: boolean;
  /** failure kind (only present when `ok` is false). */
  kind?: ExprErrorKind;
  /** localized, actionable diagnostic (only present when `ok` is false). */
  message?: string;
  /** the raw gateway error message preserved verbatim (only when `ok` false). */
  rawMessage?: string;
  /**
   * the assembled expression string the parser actually saw — `var` elements
   * collapse to `$`, so this is what the gateway evaluates. Helps the author
   * see why a fragment-built expression failed.
   */
  template: string;
}

// Run the faithful parser over an already-assembled expression string and map
// any ExprSyntaxError to a structured, localized result. Shared by both the
// element-array path (varSetNumber) and the raw-string CLI path.
function runCheck(template: string): ExprCheckResult {
  try {
    checkExpr(template);
    return { ok: true, template };
  } catch (err) {
    const kind: ExprErrorKind = err instanceof ExprSyntaxError ? err.kind : 'internal';
    const rawMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, kind, message: DIAGNOSTICS[kind], rawMessage, template };
  }
}

/**
 * Structured validation of a varSetNumber element array. Returns the specific
 * failure kind + a localized diagnostic + the assembled template, instead of
 * just a boolean. Use this when you want to tell the author *why* the
 * expression is rejected (CLI `rule expr-check`, validate-graph diagnostics).
 */
export function checkVarSetNumberExpr(elements: unknown[]): ExprCheckResult {
  return runCheck(assembleExprTemplate(elements));
}

/**
 * Structured validation of a raw expression *string* (the form a human types,
 * e.g. `abs($x - 100) + 5`). `$id` / `$scope.id` variable references collapse
 * to the gateway's `$` placeholder before checking, so the grammar verdict
 * matches what `varSetNumber` would get after `parseVarSetExpr`. Powers the
 * `xgg rule expr-check '<expr>'` command.
 */
export function checkVarSetNumberExprString(input: string): ExprCheckResult {
  // Collapse `$id` / `$scope.id` (and escaped `$$`) to the gateway's bare `$`
  // operand, matching parseVarSetExpr → assembleExprTemplate. Everything else
  // (numbers, operators, function names, parens) is passed through untouched.
  let template = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== '$') {
      template += ch;
      i += 1;
      continue;
    }
    if (input[i + 1] === '$') {
      template += '$';
      i += 2;
      continue;
    }
    const m = input.slice(i + 1).match(/^([A-Za-z][A-Za-z0-9]*)(?:\.([A-Za-z][A-Za-z0-9]*))?/);
    if (m === null) {
      // bare `$` not followed by an identifier → keep it; the parser accepts a
      // lone `$` as a number-placeholder operand.
      template += '$';
      i += 1;
      continue;
    }
    template += '$';
    i += 1 + m[0].length;
  }
  return runCheck(template);
}

/**
 * Returns true when the assembled varSetNumber element template is a valid
 * arithmetic expression per the gateway's parser (i.e. the parser does not
 * throw). The UI rejects a save with `运算式不合法` when this is false.
 * Thin boolean wrapper over {@link checkVarSetNumberExpr} for existing callers.
 */
export function isValidVarSetNumberExpr(elements: unknown[]): boolean {
  return checkVarSetNumberExpr(elements).ok;
}
