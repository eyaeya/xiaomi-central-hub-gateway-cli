# Offline dynamic lighting formulas

Historical first implementation. The current interface, mathematics and release
scope are superseded by [the unified v3.2.0 design](2026-10-15-lighting-unification-release-design.md).

Date: 2026-10-15. User request: understand Jimmy Website's MIoT Geek calculator
and integrate its calculation capability into xgg and the authoring Skill.

## Evidence and scope

Source: https://lzj.ac.cn/tools/iot/miot-geek and its deployed JavaScript. The
source audit and read-only gateway discovery are recorded under `../probes/`.
Implement the mathematical behavior independently; do not vendor the website's
React components, bundle, or assets. No new runtime dependencies or gateway API.
Keep root and Public implementations synchronized without overwriting their
different existing rule-authoring capabilities. No remote publication in this task.

## Interface

`xgg light formula <temperature|brightness|brightness-beta>` is entirely local,
requires no authorization, does not auto-update or write to devices/rules/files.
Required options: `--latitude`, `--min`, `--max`; never silently assume household
location or lamp limits. Optional Beta controls: `--speed` (0.3), `--smoothness`
(0.9), `--offset-minutes` (0), `--invert`. Reject these controls in other modes.

JSON is default. `--expression-only` emits exactly one expression plus newline;
`--pretty` renders the result for humans; these options are mutually exclusive.
`--date YYYY-MM-DD` adds deterministic local-wall-clock preview samples for that
calendar date; `--sample-minutes` defaults to 30, must be an integer divisor of
1440 in [1,1440], and requires `--date` when explicitly supplied. Samples cover
00:00 through 23:59 according to the chosen interval, excluding next-day 24:00.
Never infer a date/timezone from the execution host for preview.

Core public API: `generateLightingFormula(options: LightingFormulaOptions)`.
Options fields: mode, latitude, min, max, speed?, smoothness?, offsetMinutes?,
invert?, date?, sampleMinutes?. Result fields: mode, unit (`kelvin`|`percent`),
parameters (normalized), expression, recommendedIntervalSeconds=30,
warnings: string[], sourceUrl; optional preview containing date, samples
({time: HH:MM, value: number}[]), minimum, maximum, solarDayState
(`normal`|`polar-day`|`polar-night`), approximateSunrise/approximateSunset
(seconds since midnight, or null for polar states). CLI adds ok:true.
Errors are ConfigError; reject NaN, Infinity, malformed decimal input, bad dates,
unknown mode, unsupported options, and non-integer bounds. Latitude [-75,75],
Kelvin [2000,8000], percent [0,100], min < max; Beta speed [.1,20], smoothness
[.1,5], offset minutes [-180,180]. UI-only minimum span restrictions and the
standard brightness UI's 1% floor are deliberately relaxed and documented.

## Mathematics and numerical corrections

Retain the source approximation D=month()*30+date(), declination
23.44*sin(2*pi()/365*(D-81)) degrees, and noon=43200 seconds on the gateway clock.
This is not astronomical sunrise/sunset: no longitude, equation of time, real
day-of-year, timezone or daylight-saving correction is added.

H=acos(clamp(-tan(latitude*pi()/180)*tan(declination*pi()/180),-1,1))*43200/pi().
M=max(1,min(H,43200-H)). Standard modes use k=4.5/M. Beta uses
k=speed*smoothness/pow(M,0.7) and t=clockSeconds-43200+offsetMinutes*60.
Standard t=clockSeconds-43200. S=1/(1+pow(e(),clamp(k*(abs(t)-H),-60,60))).
Beta invert uses 1-S. Output=floor(min+(max-min)*S), clamped to requested limits.

The abs(t) form removes the original t=0 sign-mask division by zero while
preserving the curve elsewhere. Clamped acos, a one-second denominator floor,
and bounded logistic exponent keep polar/transition previews and formulas
finite. Polar output is a documented bounded extension, not verified astronomy.
Use the gateway's existing expression grammar checker before returning output.
No eval or arbitrary expression execution in runtime code.

## Skill and acceptance

Add a focused lighting-formulas reference, linked from both development and
canonical Public Skill entrypoints. When configuring dynamic lighting, briefly
offer this capability and collect latitude, actual device property/range and
requested min/max; collect Beta shape/offset/inversion only if useful. Reuse
provided answers. Do not interrupt unrelated simple light on/off requests.
The generated number still needs a number variable, varSetNumber --expr,
onLoad/loop timing and a spec-verified device output. Percent and raw brightness
must not be confused; device step/access/value-list constraints still apply.
Calculation alone does not authorize applying or enabling a lighting rule.

Verify reference vectors, original-curve parity away from singularities,
noon/polar/season/negative-latitude boundaries, preview/formula agreement,
gateway syntax, CLI output/errors and no-network behavior. Run root/Public
checks, pack and install tarballs, smoke the local calculator and packaged Skill,
inspect package contents, and commit with leak guards. A read-only gateway probe
does not prove physical lamp behavior; no physical write is needed for this scope.
