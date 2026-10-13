# Rule runtime log API

## `/api/getLog` (read; rule runtime evidence)

| | |
|---|---|
| Transport / auth | Gateway JSON-RPC over the authenticated daemon session |
| Request params | `{ num: number }`, page index starting at 0 |
| Response | Raw newline-delimited string; `""` ends pagination |
| Schema | `packages/core/src/schemas/rule-logs.ts` → `RuleLogBlockResponse` |
| Fixtures | [`fixtures/responses/rule-logs/`](../../fixtures/responses/rule-logs/) — synthetic positive/negative contract cases |
| CLI | `xgg rule logs <id> [--json] [--follow]` |

Rows use `3|<epoch-ms>|<r/l/i/e>|<graphId>|...`. The CLI reads at most
`--max-blocks` pages per poll (default 8), stops on empty/exactly repeated full blocks,
and filters by rule, inclusive `--since` / `--until`, level and `--tail`.
Only text is accepted: a non-string response raises `SchemaError` (exit 4),
including drift on a later page, rather than returning a partial or empty
success. Malformed rows, including timestamps outside JavaScript's date
range, remain in core's `unparsed` collection and do not abort valid rows.

`--follow --json` retains the existing output contract: an initial
`{ok,count,entries}` snapshot line, then one raw parsed entry per NDJSON line.
`--tail` applies only to that initial dump. `--max-events N` counts **new
matching entries only**, excluding the initial snapshot (as with `variable
watch`); `--max-events 0` emits the initial dump and exits. A partial last
batch is truncated exactly at N. `--duration-ms N` stops scheduling polls
after N milliseconds even if no entries arrive. It does not cancel an
in-flight paged read; each RPC remains bounded by `--timeout`. Both bounds
can be combined, and either bound ending the observation stops the loop.
Follow-only flags require `--follow`; interval, duration, timeout and
max-blocks must be positive decimal integers.

Authentication (exit 3), schema (exit 4), configuration (exit 5), and other
non-network errors propagate immediately with the normal command error
context. `NetworkError` reads permit three consecutive retries, with
exponential delay starting at the larger of the poll interval and 250 ms,
capped at 30 seconds. Each retry is reported on stderr without mixing it
into the data stream. A successful poll resets the retry count; exhausting
retries, or reaching the duration during an outage, returns the network
error rather than implying successful observation. No device writes are
replayed. Without either bound, following continues until Ctrl-C or error.

```bash
xgg rule logs <RULE_ID> --follow --json --duration-ms 30000 --max-events 20
```
