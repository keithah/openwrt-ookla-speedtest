# Speedtest Reference UI Redesign

## Goal

Redesign the OpenWrt Ookla Speedtest frontend so its visual hierarchy, gauge
geometry, transitions, and result presentation closely follow the current
Speedtest.net experience without copying Ookla source code, logos, artwork,
advertising, or survey content. The application remains clearly marked
**Unofficial** and preserves the product's router-specific value: Router →
Internet, Device → Router, and Both tests; server selection; history;
analytics; settings; connection and VPN-path identification; LuCI, GL.iNet,
and GoodCloud access; and first-run Ookla terms acceptance.

The redesign replaces the current gauge rather than layering more animation
onto it. Success means the installed application feels like a coherent,
ad-free router edition of the reference UI, the needle tracks genuine live
measurements fluidly, and every result makes the measured path unambiguous.

## Reference and Originality Boundary

The implementation may reproduce observable interaction patterns and general
layout proportions from the public Speedtest.net interface. In particular it
will use a 270-degree dial, nonlinear speed labels, a tapered hubless needle,
phase-specific gradients, and the reference transition cadence.

All SVG, CSS, icons, layout code, gradients, copy, and animation logic will be
authored in this repository. The package will not include Speedtest.net web
assets, minified application code, logos, advertisements, surveys, or tracking.
Ookla attribution and license handling remain those required by the separately
packaged official CLI. The visible title and About view identify this web UI as
"OpenWrt Ookla Speedtest (Unofficial)."

## Overall Layout

The application uses an edge-to-edge near-black canvas with a restrained top
bar. The top bar contains the product title, the explicit path label, and icon
buttons for History, Analytics, Settings, and About. It does not reserve empty
space for ads.

The test view is a centered result stage with three vertical zones:

1. A metrics strip for ping, download, and upload. During a test, completed
   metrics remain visible while the active metric is emphasized.
2. A 286 × 286 pixel primary control or gauge. On narrow screens it scales down
   without changing its aspect ratio or geometry.
3. Network context: source and destination labels, ISP, connection type, VPN
   path when detected, and selected test server with a Change Server action.

An idle state shows a large circular `GO` control. Beside or immediately above
it, a segmented control selects Router → Internet, Device → Router, or Both.
The Router → Internet choice is the default. Mode labels are never reduced to
ambiguous icons.

The running state morphs the GO control into the active gauge. The completed
state follows the reference result composition: a compact GO/retest ring at
the left of the result group, large download and upload numbers, ping details,
and network/server information. History and analytics are part of the same
visual system rather than looking like an unrelated admin page.

## Gauge Geometry and Scale

The active gauge uses a 286 × 286 SVG viewport with these reference-derived
proportions:

- dial radius: 130 px;
- active arc width: 23 px;
- sweep: 270 degrees;
- needle length: 85 px;
- needle width: 20 px at its base and 10 px at its tip; and
- no circular center pin or decorative hub.

The needle is an original tapered SVG path whose rotation origin is exactly the
SVG center. Geometry is expressed from one shared center constant so resizing,
CSS transforms, labels, and test assertions cannot disagree about the pivot.
The live number is placed at the bottom center of the gauge, with its unit on a
separate line. Neither overlaps the needle base.

The throughput scale is the fixed nonlinear sequence
`0, 5, 10, 50, 100, 250, 500, 750, 1000 Mbps`. Values are converted to angles
by linear interpolation between adjacent labeled positions. Values above 1000
Mbps clamp the needle to the end of the arc while the numeric readout continues
to show the actual value. Ping uses the fixed nonlinear sequence
`0, 5, 10, 20, 50, 100, 250, 500 ms` with the same interpolation and clamping
rules and a clearly displayed `ms` unit.

Inactive track strokes are muted gray. Download uses an original teal/cyan
gradient; upload uses an original violet/pink gradient; ping uses a cool blue
gradient. Labels fade in with a short stagger when the ring becomes a gauge.
Color is reinforced by the phase label and unit, so it is never the only state
indicator.

## Motion and Live Measurement

The animation model follows the observed reference UI rather than a simulated
spring:

- the GO disc morphs to a ring in about 200 ms and the ring to an arc in about
  150 ms;
- each real needle target is tracked over 200 ms with ease-out;
- between phases, the needle returns to the start over 500 ms with ease-in-out;
- label stagger and fades use approximately 80 ms intervals; and
- the final layout transition is short and does not delay access to results.

Router → Internet invokes the Ookla CLI with progress JSONL and a 100 ms
progress update interval. The frontend polls the active job at 100 ms while the
page is visible. Each response contains only the newest validated measurement
and bounded trace data.

The gauge renderer uses `requestAnimationFrame`, normally updating at the
browser refresh rate (about every 16.7 ms at 60 Hz), to interpolate from the
currently rendered angle to each new real target. This produces the requested
fluidity without a 10 ms network or service polling loop. It does not generate
fake throughput samples, overshoot, bounce, or continue moving after the real
target has settled. If responses arrive late, the current animation is
retargeted from its on-screen angle rather than jumping from its previous
endpoint.

Device → Router continues to calculate samples from completed browser/router
payload batches. Its controller publishes the newest measured target through
the same gauge interface. Both mode runs Device → Router and Router → Internet
sequentially so the two measurements cannot contend for bandwidth.

When `prefers-reduced-motion` is active, morphs and needle sweeps become direct
state changes while numeric measurements continue to update.

## Test States

The shared state machine remains:

`idle → ping → download → upload → complete`

Any active phase may transition to `cancelled` or `error`. For Both mode, the
complete Device → Router sequence runs first, then the complete Router →
Internet sequence. A path transition screen briefly identifies which path has
finished and which is starting.

During ping, the central dial shows live latency. During download and upload,
the metrics strip retains completed latency and throughput values, the central
gauge emphasizes the active phase, and the active numeric readout changes with
the real sample. A cancel control stays keyboard reachable without competing
visually with the gauge.

Transient polling failures retain the last valid measurement and retry with
bounded backoff. A persistent failure stops animation at the last real target,
names the failed phase, presents the stable service error, and offers Retry.
Cancellation stops new browser batches or terminates the owned CLI process,
then returns to a result-like cancelled state without recording an analytics
point.

## Final Results

Router → Internet results display:

- download and upload Mbps;
- idle latency, download latency, upload latency, jitter, and loss when supplied
  by the CLI;
- selected server, sponsor, and location;
- detected public-facing ISP;
- active router WAN type; and
- VPN or overlay path context.

VPN detection is explicit and cautious. Known interfaces and routing state may
identify Tailscale, a Tailscale exit node, Speedify, WireGuard, OpenVPN, or
another tunnel. The result calls this out as the route under test—for example,
`Router → Internet via Tailscale exit node`—and does not imply that the measured
speed is the raw ISP line rate. If a VPN is suspected from a public ISP mismatch
but cannot be named reliably, the UI says `Possible VPN/proxy path` rather than
guessing a product.

Device → Router results display latency, download, and upload separately and
state that no public internet speed was measured. They identify the browser's
connection to the router when known, but do not label that connection as the
router's WAN.

Both results share one reference-style result surface but contain two distinct,
clearly headed sections: `Device → Router` and `Router → Internet`. Values are
never merged or averaged. The compact GO ring reruns the selected mode. Save,
history, and analytics behavior uses the existing local data model.

## Server, Terms, and Supporting Views

The first Router → Internet launch requires acceptance of the Ookla terms and
privacy policy before the CLI is invoked. Acceptance is persisted through the
existing settings mechanism. Device → Router alone does not require Ookla terms
because it does not invoke the Ookla service. Declining leaves local testing
available.

The main view always exposes the chosen server and a Change Server action. The
server picker keeps automatic selection, search, and explicit selection. A
manual server persists until changed or reset to automatic.

History uses compact result rows with mode/path badges and opens a full result
view. Analytics never mixes local and internet values in one series. Settings
contains mode defaults, server preference, retention, units/display options,
and terms status. About explains that the package is unofficial; that the web
package depends on the separately installed CLI and does not bundle its binary;
that Router → Internet executes on the router; that Device → Router measures
the browser-to-router path; and that GoodCloud exposes the same authenticated
router UI rather than a separate public service.

## Component Boundaries

The current monolithic shared frontend will be divided along behavior boundaries
without adding a build-time framework:

- test controller: state transitions, mode sequencing, cancellation, and API
  polling;
- gauge model: value-to-angle mapping and phase configuration;
- gauge renderer: SVG construction, animation, and reduced-motion handling;
- results renderer: single-path and Both result composition;
- network context renderer: ISP, connection, server, and VPN-path explanation;
- supporting views: history, analytics, settings, server picker, and About; and
- API bridge: unchanged LuCI/GL.iNet transport interface with the faster status
  cadence hidden behind it.

These remain dependency-free browser modules suitable for the router package.
The router worker remains responsible for process ownership, JSONL validation,
bounded traces, job expiry, and persistent history. The browser never receives
or constructs arbitrary command arguments.

## Accessibility and Responsiveness

All icon controls have visible tooltips and accessible names. Mode, phase, and
path are expressed in text. Phase transitions are announced once; rapidly
changing samples are not announced every 100 ms. A throttled polite live region
reports the active numeric value at a usable cadence. The GO/retest control,
cancel action, mode selector, server picker, and navigation are keyboard
operable with visible focus.

At narrow widths the metrics strip wraps, the 286 px gauge scales to the
available width, and final result sections stack vertically. There is no
horizontal page overflow in LuCI, GL.iNet Applications, or GoodCloud's embedded
view. High-contrast text and non-color phase cues remain legible in dark mode.

## Verification and Release

Automated coverage will verify:

- nonlinear value-to-angle interpolation, clamping, and exact shared pivot;
- SVG dimensions, needle geometry, readout placement, and phase gradients;
- retargetable 200 ms needle interpolation and reduced-motion behavior using a
  deterministic animation clock;
- 100 ms CLI progress configuration and 100 ms visible-page polling;
- state transitions, cancellation, transient retry, and stale-job behavior;
- separate local and internet samples and results in Both mode;
- terms gating only for Router → Internet;
- named, generic, and absent VPN-path presentations;
- accessible names, live-region throttling, keyboard behavior, and responsive
  layout contracts;
- package contents, package-version consistency, and LuCI/GL.iNet registration;
  and
- history and analytics separation by test path.

Release verification will build the packages, install them on
`100.66.177.126`, and exercise Router → Internet, Device → Router, and Both
through the real GL.iNet Applications route. Browser inspection will confirm
the pivot, motion cadence, live sample retargeting, mobile layout, server
selection, VPN wording, result mapping, and GoodCloud-compatible authenticated
route. Fresh screenshots and a new animated README GIF will be captured only
from this installed, working interface; the interrupted GIF from the previous
gauge will not be published. After all checks pass, the versioned packages,
signed feed, repository README, and release artifacts will be updated and
pushed directly to `main` as previously requested.
