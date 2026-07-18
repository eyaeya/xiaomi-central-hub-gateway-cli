import {
  isValidVariableIdentifier,
  readVariableIdentifierPrefix,
  variableIdentifierMessage,
} from '../schemas/variable-identifier.js';

export type VariableReferenceScan =
  | { kind: 'escape'; consumed: 2 }
  | { kind: 'reference'; consumed: number; scope: string; id: string }
  | { kind: 'invalid'; consumed: number; raw: string; message: string };

function isReferenceCandidateChar(ch: string): boolean {
  return /[A-Za-z0-9_.-]/.test(ch);
}

// A hyphen immediately after an identifier is ambiguous: in a number
// expression it is normally subtraction, while in `$bad-id` it is commonly a
// mistyped variable id. Preserve established compact arithmetic when the RHS
// unambiguously starts an operand; otherwise keep the hyphen in the candidate
// so the invalid identifier gets an early diagnostic.
function hyphenStartsSubtraction(input: string, index: number): boolean {
  const tail = input.slice(index + 1);
  if (/^\s/.test(tail)) return true;
  if (/^[0-9$()+-]/.test(tail)) return true;
  // The gateway's arithmetic checker delegates scalar tokens to Number(), so
  // compact subtraction must preserve its accepted number spellings too.
  if (/^\.\d/.test(tail)) return true;
  if (/^Infinity(?=$|[\s,+*/%)-])/.test(tail)) return true;
  return /^[A-Za-z][A-Za-z0-9]*\s*\(/.test(tail);
}

function readReferenceCandidate(input: string, start: number): string {
  let end = start;
  while (end < input.length) {
    const ch = input[end] as string;
    if (!isReferenceCandidateChar(ch)) break;
    if (ch === '-' && end > start && hyphenStartsSubtraction(input, end)) break;
    end += 1;
  }
  return input.slice(start, end);
}

/**
 * Scan one `$` token in the user-facing expression DSL.
 *
 * Every unescaped `$` must introduce `$id` or `$scope.id`; a literal dollar
 * is always `$$`. Invalid identifier-looking tokens are rejected as a unit so
 * `$bad_id` cannot silently become variable `bad` plus literal `_id` on the
 * varSetString path.
 */
export function scanVariableReference(
  input: string,
  offset: number,
  defaultScope = 'global',
): VariableReferenceScan {
  if (input[offset] !== '$') {
    throw new TypeError(`scanVariableReference expected "$" at offset ${offset}`);
  }
  if (input[offset + 1] === '$') return { kind: 'escape', consumed: 2 };

  const candidate = readReferenceCandidate(input, offset + 1);
  if (candidate.length === 0) {
    return {
      kind: 'invalid',
      consumed: 1,
      raw: '$',
      message: `invalid variable reference at offset ${offset}: ${variableIdentifierMessage('id')}; use "$$" for a literal "$"`,
    };
  }

  const parts = candidate.split('.');
  let scope: string;
  let id: string;
  if (parts.length === 1) {
    scope = defaultScope;
    id = parts[0] as string;
  } else if (parts.length === 2) {
    scope = parts[0] as string;
    id = parts[1] as string;
  } else {
    return {
      kind: 'invalid',
      consumed: 1 + candidate.length,
      raw: `$${candidate}`,
      message: `invalid variable reference "$${candidate}" at offset ${offset}: use exactly $id or $scope.id; ${variableIdentifierMessage('id')}`,
    };
  }

  if (!isValidVariableIdentifier(scope)) {
    return {
      kind: 'invalid',
      consumed: 1 + candidate.length,
      raw: `$${candidate}`,
      message: `invalid variable reference "$${candidate}" at offset ${offset}: ${variableIdentifierMessage('scope')}`,
    };
  }
  if (!isValidVariableIdentifier(id)) {
    return {
      kind: 'invalid',
      consumed: 1 + candidate.length,
      raw: `$${candidate}`,
      message: `invalid variable reference "$${candidate}" at offset ${offset}: ${variableIdentifierMessage('id')}`,
    };
  }

  // The candidate scanner and exact validator intentionally share the same
  // grammar fact source. This assertion also guards future scanner edits from
  // accidentally consuming only part of an otherwise-valid identifier.
  const first = readVariableIdentifierPrefix(candidate);
  if (first === null) {
    return {
      kind: 'invalid',
      consumed: 1 + candidate.length,
      raw: `$${candidate}`,
      message: `invalid variable reference "$${candidate}" at offset ${offset}: ${variableIdentifierMessage('id')}`,
    };
  }

  return { kind: 'reference', consumed: 1 + candidate.length, scope, id };
}
