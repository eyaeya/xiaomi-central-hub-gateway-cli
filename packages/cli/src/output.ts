import Table from 'cli-table3';

export interface OutputOptions {
  pretty: boolean;
}

export function emit(value: unknown, opts: OutputOptions): void {
  const text = opts.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  process.stdout.write(`${text}\n`);
}

export interface TableColumn<T> {
  header: string;
  get: (row: T) => string;
}

export interface ListEmit<T> {
  jsonPayload: unknown; // serialized verbatim when !pretty
  columns: TableColumn<T>[];
  rows: T[];
}

export function emitList<T>(spec: ListEmit<T>, opts: OutputOptions): void {
  if (!opts.pretty) {
    process.stdout.write(`${JSON.stringify(spec.jsonPayload)}\n`);
    return;
  }
  const table = new Table({
    head: spec.columns.map((c) => c.header),
    style: { head: [], border: [] }, // disable color
  });
  for (const row of spec.rows) {
    table.push(spec.columns.map((c) => c.get(row)));
  }
  process.stdout.write(`${table.toString()}\n`);
}
