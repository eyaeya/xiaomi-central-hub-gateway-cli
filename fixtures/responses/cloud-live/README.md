# Redacted live cloud response contracts

Capture date: **2026-10-13**. These samples originate from successful, read-only
requests made through the native xgg cloud transport with an already authorized
account. The original six-file capture explicitly blocked login/refresh URLs and performed no
physical writes. The later source-comparison reads followed a separate reversible-device test;
their shape evidence is described below. They are separate from `../cloud/*-synthetic.json`.

| Sample | Actual response source | Redaction / selection |
| --- | --- | --- |
| `homes-redacted-live.json` | `/v2/homeroom/gethome_merged` result | One actual home and room; IDs, UID and names replaced; location/network metadata omitted |
| `devices-redacted-live.json` | `/home/home_device_list` result | One actual lamp from the selected home; DID/name/cursor replaced; token, MAC, SSID, location and other private fields omitted |
| `property-get-redacted-live.json` | `/miotspec/prop/get` result | One actual lamp property read; only DID replaced; siid/piid/code/value preserve actual wire values |
| `scenes-redacted-live.json` | `GetSimpleSceneList` result | One actual manual scene; scene ID/name replaced; payloads, device references, timestamps and account metadata omitted |
| `consumables-redacted-live.json` | `/v2/home/standard_consumable_items` result | One actual device in one response group; DID/name replaced; detail identifiers, timestamps, URLs and other metadata omitted |
| `spec-public-live.json` | Public MIoT instance previously fetched by gateway `device spec` | Unmodified outer public spec fields and one actual light service selected; other services omitted; no household or account fields |
| `property-auto-redacted-live.json` | `/miotspec/prop/get`, `datasource:1`, read after restoration | Selected actual result shape; identity/instance IDs replaced; `updateTime:100` is synthetic; boolean/code retain the observed stale-cache outcome |
| `property-device-redacted-live.json` | Same target property, `datasource:2`, direct device read | Same projection; `updateTime:200` is synthetic; boolean/code retain the observed restored-device outcome |

The first five files preserve the **actual cloud `result` container shape**; they
are not reconstructed envelopes around earlier flattened API/CLI output. Raw
results were captured before schema parsing and retained privately in ignored
`.xgg-local/cloud-probe/contracts-raw/`. The transport checks and removes the
outer HTTP/API envelope, so these files do not claim to include that envelope.

Allow-list projection intentionally omits private and unrelated fields. Arrays
are reduced for reviewability, and illustrative IDs (`101`, `201`, `device-demo`,
`scene-demo`) replace live identities. Consumable detail IDs are omitted rather
than changing their observed numeric type into string placeholders. Response
field presence and remaining types reflect the capture; pagination status is
retained from the original response although device arrays are shortened.

These captures establish actual response-shape evidence for the listed reads.
They do not establish live scene execution, speaker actions, statistics support,
or compatibility with every device. Synthetic fixtures remain useful for errors,
accepted-but-unconfirmed writes, shared pagination and other controlled cases.

The later source-comparison pair comes from ignored
`.xgg-local/cloud-review/curtain-source-1.json` and `curtain-source-2.json`.
It preserves real response shape with synthetic identifying/time values, not exact
production snapshots. Extra device timing and instance-key fields are omitted.
The earlier cache read and later direct RPC both reported code zero yet returned
different values and server timestamps. This illustrates why protocol success
does not establish freshness. It does not mean every device supports direct RPC.
