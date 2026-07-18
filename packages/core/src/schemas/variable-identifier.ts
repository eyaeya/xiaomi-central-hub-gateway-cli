// Gateway variable scope/id grammar. Keep this module dependency-free so
// write schemas, rule shortcut parsers and local-only expression checks all
// consume the exact same fact source.
export const VARIABLE_IDENTIFIER_PATTERN = '[A-Za-z0-9]+';
export const VARIABLE_IDENTIFIER_CONSTRAINT =
  'must be non-empty ASCII alphanumeric [A-Za-z0-9]+ (no underscore, hyphen, dot, whitespace, or Unicode)';

const VARIABLE_IDENTIFIER_RE = new RegExp(`^${VARIABLE_IDENTIFIER_PATTERN}$`);
const VARIABLE_IDENTIFIER_PREFIX_RE = new RegExp(`^${VARIABLE_IDENTIFIER_PATTERN}`);

export function isValidVariableIdentifier(value: string): boolean {
  return VARIABLE_IDENTIFIER_RE.test(value);
}

export function readVariableIdentifierPrefix(value: string): string | null {
  return VARIABLE_IDENTIFIER_PREFIX_RE.exec(value)?.[0] ?? null;
}

export function variableIdentifierMessage(label: 'scope' | 'id'): string {
  return `${label} ${VARIABLE_IDENTIFIER_CONSTRAINT}`;
}
