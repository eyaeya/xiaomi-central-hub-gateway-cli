# MIoT Geek light-formula source audit — 2026-10-15

## Evidence and scope

- Requested tool: <https://lzj.ac.cn/tools/iot/miot-geek> (redirected/localized HTML contains all three calculator tabs).
- Calculator implementation: <https://lzj.ac.cn/_next/static/chunks/21-udk--9nypo.js>.
- HTML SHA-256: `49fdd285c2504284c9c1aa5c0b4216da85b9860b733deebc9a15f790f08ae728`.
- Calculator chunk SHA-256: `ce1b19b7d4f188ed30f10520e2b0c10c2866c7234d110d9bcc392c7b8876b594`.
- Source downloaded to temporary files only. No vendor bundle is added to this repository.
- Audited minified components: `xY` (temperature output), `xF` (temperature chart), `x2` (brightness output), `xZ` (brightness chart), `wb` (beta output), `x5` (beta chart). Computation is entirely client-side; no calculation RPC is involved.
- The page footer asserts copyright; no reuse license or source-repository link was found on the calculator page. The about page links <https://github.com/JimmyKmi>, but no calculator source license was established. Decision: independently implement the mathematical behavior with attribution; do not vendor the website code, UI, or assets.
- This audit establishes website computation, not gateway execution. Gateway expression support and `month()` semantics require the separate local/protocol probe.

## Mathematical model reconstructed from all three calculators

Use degrees for latitude and convert before trigonometry. Define:

```text
D = month * 30 + day
declination = 23.44 * sin(2*pi/365 * (D - 81))        # degrees
A = -tan(latitude*pi/180) * tan(declination*pi/180)
H = acos(A) * 43200/pi                              # half daylight length, seconds
M = min(abs(43200 - H), H)
t = hours*3600 + minutes*60 + seconds - 43200
range = high - low
```

The browser chart uses `30*(Date.getMonth()+1)+Date.getDate()`; the exported expression uses `month()*30+date()`. Neither is a true day-of-year model. Longitude, timezone offset, refraction, elevation and equation-of-time corrections are absent. The model is symmetric around fixed local-clock 12:00 and must not be described as precise astronomical sunrise/sunset.

Standard temperature and brightness share the same intended weight:

```text
k = 4.5/M
weight = 1/(1+exp(k*(abs(t)-H)))
output = floor(low + range*weight)
```

The original output spells this as two logistic branches selected by `(t-abs(t))/(2*t)` and `(t+abs(t))/(2*t)`. Both temperature and brightness expressions are balanced and apply the range to both branches. The simplified absolute-time form is mathematically equivalent away from noon and extends it continuously to noon.

Beta brightness:

```text
k = transitionSpeed * smoothness / M^0.7
u = t + timeOffsetMinutes*60
dayWeight = 1/(1+exp(k*(abs(u)-H)))
weight = invert ? 1-dayWeight : dayWeight
output = floor(low + range*weight)
```

Positive time offsets move the bright interval earlier; negative offsets move it later. The original implementation does not wrap the shifted time across midnight. Speed and smoothness multiply one another, so their effects are not independent; increasing either steepens the transition despite the label “smoothness”.

Gateway output uses `floor`, `pow(e(), ...)`, `min`, `abs`, `acos`, `tan`, `sin`, `pi`, and clock/date functions; it contains no JavaScript variable declarations or `Math.*` calls. Whitespace is stripped before display. Recommended update intervals on the page are 30 seconds for standard modes and 60 seconds for beta.

## Original defaults and validation

| Parameter | Temperature | Brightness | Brightness beta |
| --- | --- | --- | --- |
| Low / high | 3200 / 5400 K | 10 / 100 percent | 60 / 100 percent |
| Latitude | 23.129 degrees | 23.129 degrees | 23.129 degrees |
| Allowed value range | 2000–8000 | 1–100 | 0–100 |
| Minimum high-minus-low | 400 | 5 | 1 |
| Latitude range | −75 to 75 | −75 to 75 | −75 to 75 |
| Transition speed | — | — | 0.3; range 0.1–20; UI step 0.1 |
| Smoothness | — | — | 0.9; range 0.1–5; UI step 0.1 |
| Offset minutes | — | — | 0; range −180 to 180; UI step 1 |
| Invert | — | — | false |

The website explicitly labels beta as AI-generated and untested by its author. It must not be presented as hardware-validated. The numeric input widgets truncate low/high with `parseInt`; latitude uses permissive `parseFloat`. A CLI should reject malformed numeric strings and non-finite numbers instead of silently truncating or accepting suffixes.

## Findings and decision lanes

1. **Noon singularity.** Phenomenon: standard modes evaluate `0/0` at exactly 12:00:00. Root cause: sign masks divide by `2*t`. CLI impact: a 30-second automation can encounter the failure daily. Decision: use the equivalent `abs(t)` weight above, with no division by `t`.
2. **Polar failure despite accepted latitude.** Phenomenon: latitude 75, June 21 yields `A=-1.4048293362823367`; December 21 yields `A=1.4391317920509126`. Both exceed the `acos` domain and the original result is NaN. Root cause: UI permits polar latitudes without a polar-day/night branch. CLI impact: finite accepted arguments can generate unusable year-round formulas. Decision: clamp `A` to [-1,1], use `M=max(1,min(H,43200-H))`, and bound the sigmoid exponent to [-60,60]. This is explicit xgg numerical hardening, not behavior established in the website.
3. **Preview and output differ.** Phenomenon: standard charts use `Math.round`, whereas emitted formulas use `floor`; beta charts round to two decimals. Root cause: chart formatting is independent from emitted expression. CLI impact: a chart value can disagree with the real integer output. Decision: preview the exact floor output; optionally expose raw values separately.
4. **Approximate calendar and fixed noon.** Phenomenon: October 15 uses `D=315`, rather than actual day-of-year. Root cause: the source deliberately/implicitly uses `month*30+day`. CLI impact: silently “correcting” it would alter all existing results. Decision: preserve it and label the model approximate. Require explicit date for reproducible offline preview.
5. **Midnight offset discontinuity.** Phenomenon: beta with speed/smoothness 0.1/0.1, offset +180 minutes, range 60–100, latitude 23.129, October 15 jumps from raw 76.6429201749726 at 23:59:59 to 78.74466961441566 at 00:00:00 (holding the same model date). Root cause: `abs(t+offset*60)` is not periodic. Decision: preserve source offset semantics and document this limitation; do not silently claim seamless daily cycling.
6. **UI-only restrictions.** Phenomenon: the website uses minimum low/high gaps even though the math needs only ordered bounds; brightness beta allows zero while standard brightness forbids it. Root cause: UI validation policy. CLI impact: source UI restrictions unnecessarily exclude valid device bounds. Decision: xgg may explicitly relax gaps to `low < high` and brightness to 0–100, while still checking the actual device specification before deployment. Latitude and light bounds must be supplied explicitly rather than inferred from website defaults.
7. **Stale formula on invalid input.** Phenomenon: the displayed code is selected with `generatedCode || validationError`; generated code starts nonempty and remains unchanged when validation fails. Root cause: invalid input returns before clearing the old output. CLI impact: copying this pattern could deliver a previous formula for rejected parameters. Decision: reject invalid arguments atomically and return no formula.

## Reproducible source-derived vectors

These values were calculated directly from the source arithmetic in an isolated Node process, not inferred from the chart. Latitude is 23.129; low/high are the original defaults; beta uses speed 0.3, smoothness 0.9, offset 0, invert false. Values below use the emitted formula's `floor`. At noon the standard columns show the continuous, corrected value; the original expressions return NaN there.

| Model date | Clock | Temperature K | Brightness percent | Beta percent |
| --- | --- | ---: | ---: | ---: |
| 2026-06-21 | 00:00 | 3224 | 10 | 60 |
| 2026-06-21 | 06:00 | 4577 | 66 | 85 |
| 2026-06-21 | 09:00 | 5297 | 95 | 98 |
| 2026-06-21 | 12:00 | 5391 | 99 | 99 |
| 2026-06-21 | 18:00 | 4577 | 66 | 85 |
| 2026-10-15 | 00:00 | 3210 | 10 | 60 |
| 2026-10-15 | 06:00 | 4060 | 45 | 74 |
| 2026-10-15 | 09:00 | 5144 | 89 | 96 |
| 2026-10-15 | 12:00 | 5375 | 99 | 99 |
| 2026-10-15 | 18:00 | 4060 | 45 | 74 |
| 2026-12-21 | 00:00 | 3208 | 10 | 60 |
| 2026-12-21 | 06:00 | 4015 | 43 | 74 |
| 2026-12-21 | 09:00 | 5134 | 89 | 96 |
| 2026-12-21 | 12:00 | 5375 | 99 | 99 |
| 2026-12-21 | 18:00 | 4015 | 43 | 74 |

October 15 intermediate references: declination `-18.163281929643432` degrees, `H=19666.691693997876` seconds, raw standard brightness `45.20594822500174` at 06:00, `99.01095136782835` at 11:59:59, NaN at original 12:00, and corrected `99.01117516324662` at 12:00. The model asymptotically approaches its bounds, so 100 is not guaranteed to be reached at noon.

## Verification boundary

This source audit does not claim real-device application, gateway acceptance, or measured light output. The website's advisory fixture ranges are not a substitute for MIoT device specifications. Integration should produce an offline formula/preview first; applying it to a rule remains a separate authorized graph mutation with snapshot, validation, and existing e2e requirements.
