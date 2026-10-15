# ADR 0018: Generate lighting expressions locally

- Date: 2026-10-15
- Status: Accepted

## Context

Agents can already author `varSetNumber` expressions and send numeric variable
references to compatible device properties. Constructing daily color-temperature
and brightness curves repeatedly is error-prone. Jimmy Website's MIoT Geek tool
provides three useful curve models, but deployed code inspection reveals noon
division by zero, polar-domain errors and a preview/export rounding mismatch.

## Decision

Implement the observed mathematics independently as a pure TypeScript core
usecase, exposed by `xgg light formula`. It returns a gateway-grammar-checked
expression, normalized parameters, model warnings and an optional deterministic
preview. It does not execute user code, access the network, create rules, discover
location or control lamps. No new dependency, RPC schema or mutation is needed.

Preserve the original approximate seasonal model and Beta curve controls. Correct
the noon singularity with an equivalent absolute-time expression and protect
numeric domains/overflow. Previews use the generated formula's floor semantics.
Polar protection is only a bounded numerical extension; it is not a verified
astronomical polar-lighting model. Record intentional differences from the
website, with deployed source hashes and test vectors in the discovery probe.

Require latitude and desired limits explicitly. Keep device-specific property
units, value ranges and steps in the existing spec-aware authoring workflow.
Recommend the capability from Skill when relevant to dynamic lighting, then
collect missing parameters before generating an applied configuration.

## Consequences

The calculator works offline without a daemon or cloud credentials. Existing
rule authoring/validation/export behavior remains the integration path. Formula
syntax and local numerical tests do not prove a gateway executor or physical
lamp's response. Applying a formula requires the existing snapshot, validation,
enable and readback workflow and the user's lighting configuration intent.

Source attribution: https://lzj.ac.cn/tools/iot/miot-geek (Zijing Li / Jimmy
Website). No website source files or assets are redistributed. Formula models
and the new implementation are documented in
[the design](../superpowers/specs/2026-10-15-lighting-formula-design.md).
