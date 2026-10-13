# Cloud contract fixtures

Every `*-synthetic.json` file is a **synthetic contract sample**, not a raw cloud capture.
It contains invented device, home, user and scene identifiers. Sentinel token/network
fields intentionally test removal of private fields.

The device/home item shapes were compared with live read-only discovery on 2026-10-13;
scene/consumable item shapes were also inspected live. Their enclosing `result` objects
follow the upstream request implementation. The public MIoT spec, property, action,
scene-run and statistics examples model the documented/upstream protocol. Unit tests
exercise negative responses and accepted-but-unconfirmed writes independently.

The review follow-up adds invented room membership, a synthetic update timestamp,
public spec comments, and `property-batch-synthetic.json`. The batch deliberately
combines reordered success, failure and accepted items. It tests identity matching
and partial-result semantics, not device or network behavior. Timestamp `100` is
synthetic epoch seconds, not a capture of household activity.

Private raw discovery files live under ignored `.xgg-local/cloud-probe/`. Successful
fixture parsing establishes schema compatibility with these samples; it does not
establish live support for every device or endpoint. See the dated discovery probe and
`docs/api/cloud.md` for evidence limits.

Companion `../cloud-live/` samples preserve redacted result containers captured
from actual read-only cloud requests; see its README for provenance and limits.
