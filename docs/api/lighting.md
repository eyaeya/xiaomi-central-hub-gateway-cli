# Local lighting formula calculator

This is a local computation contract, not an HTTP/WS API. Authentication: none.
There is no device mutation, automatic update, location lookup or gateway call.

```bash
xgg light formula temperature --latitude 23.129 --min 3200 --max 5400 \
  --date 2026-10-15
xgg light formula brightness --latitude 23.129 --min 10 --max 100
xgg light formula brightness --latitude 23.129 --min 10 --max 100 \
  --speed 0.5 --offset-minutes 30 --invert
xgg light formula temperature --latitude 23.129 --min 3200 --max 5400 \
  --expression-only
```

Latitude and requested minimum/maximum are required. Kelvin limits are integers
in [2000,8000], percent limits are integers in [0,100], and min must be below
max. Latitude is [-75,75]. These calculator limits do not establish a lamp's
supported range. Brightness-only controls are speed [0.1,20], offset minutes
[-180,180] and inversion. Defaults are 1, 0 and false. Speed is a dimensionless
factor: less than 1 is gentler, greater than 1 is steeper; it is not a duration
or polling interval. Temperature rejects these controls. There are exactly two
modes: temperature and brightness; no separate experimental brightness mode.
Positive offset advances the curve; it does not wrap the curve across midnight.

Default stdout is a single JSON result with `ok`, `mode`, `unit`, `parameters`,
`expression`, `recommendedIntervalSeconds`, `sourceUrl` and `warnings`.
`--pretty` renders the same calculation for people. `--expression-only` emits
only the expression and a newline for safe argv/file use, and cannot combine
with `--pretty`. Invalid inputs return CONFIG / exit 5.

`--date YYYY-MM-DD` adds `preview`: date, samples (`time`, `value`), sampled
minimum/maximum, solarDayState and approximateSunrise/approximateSunset (seconds
since midnight; null in polar cases). `--sample-minutes` defaults to 30 and must
be an integer divisor of 1440; explicitly supplying it requires `--date`.
Samples stay within the supplied day and never substitute the host's timezone.
The expression remains dynamic; the preview date is not embedded in it.

Core: `generateLightingFormula()` in
[`lighting-formula.ts`](../../packages/core/src/usecases/lighting-formula.ts).
Validation: local parameter checks and `checkVarSetNumberExprString`.
Regression vectors and expression/preview equivalence tests are in core's
lighting-formula tests; there is no remote response fixture or new API schema.

## Numerical model and limits

The seasonal day index is the source's `month()*30+date()` approximation, with
noon fixed at 12:00 on the gateway clock. Longitude, actual day of year,
timezone, daylight saving and the equation of time are not modeled. Sunrise and
sunset are approximate model metadata, not an astronomical forecast.

Both curves use a logistic day/night blend. With half-day H and
M=max(1,min(H,43200-H)), temperature uses k=4.5/M and brightness uses
k=4.5*speed/M. Default brightness therefore preserves the original standard
curve. Brightness also supports offset and inversion. Xgg removes the source's noon division by zero, clamps
acos input and the logistic exponent, and applies a one-second denominator
floor. Polar calculations remain finite but may have artificial noon/midnight
features; inspect the preview and do not treat them as validated polar-day or
polar-night lighting. All outputs use floor, matching the exported expression
rather than the website chart's round. See
[source audit](../superpowers/probes/2026-10-15-miot-geek-source-audit.md) and
[ADR 0018](../adr/0018-offline-lighting-formulas.md).

The unpublished three-mode prototype was simplified before the first lighting
release (v3.2.0). `brightness-beta` and `smoothness` are rejected rather than
silently mapped to a different formula. The former alternative seasonal slope
and two multiplicative shape knobs are not part of the published API.

The 30-second recommendation is xgg's common starting interval, not evidence
of gateway timing or physical lamp behavior. It can be adjusted in the rule.
Use a numeric variable and `varSetNumber --expr`, then the existing device
output reference mechanism. Percent must be scaled when the target property
uses a different native range; respect the spec's step and dynamic-ref support.
Run the existing spec-aware validation, lint and readback workflow when applying.
