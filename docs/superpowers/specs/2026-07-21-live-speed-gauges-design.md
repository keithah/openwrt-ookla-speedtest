# Live Speed Gauges Design

## Goal

Replace the static running state with an Ookla-inspired, live measurement
experience for Router → Internet and Device → Router tests. The interface must
show genuine ping, download, and upload samples, animate a dial needle as the
measured value changes, and finish in a result layout modeled on the supplied
macOS Speedtest screenshots. Both mode must run the paths sequentially and map
their results separately.

This remains an unofficial interface. It continues to label internet tests as
Router → Internet and local tests as Device → Router so users cannot mistake
the measurement scope.

## Visual Model

The test surface uses the existing deep navy theme and adopts the reference
application's state progression:

1. The idle screen centers a large cyan GO ring.
2. The ping phase replaces the GO ring with a wide semicircular dial and a live
   latency value in milliseconds.
3. The download phase uses a cyan-to-green dial arc, a moving needle, a live
   Mbps value, and a cyan throughput trace.
4. The upload phase uses violet emphasis, the same moving dial, a live Mbps
   value, and a violet throughput trace.
5. The completed screen restores the GO ring while retaining download and
   upload values at the top, followed by ping, jitter, loss, traces, server,
   ISP, connection type, and VPN-path context.

The dial scale adapts using rounded 1/2/5 multiples of powers of ten. It grows
when a sample approaches the current maximum and does not shrink during a
phase. This makes the needle useful for cellular and VPN results as well as
fast LAN links. Download is cyan and upload is violet throughout. Numeric
values remain the source of truth; motion is decorative and respects
`prefers-reduced-motion`.

In Both mode, one dial is reused for each phase. Device → Router runs first,
then Router → Internet. The completed screen includes two clearly labeled
result panels beneath the primary result area. The tests never run
simultaneously because they would compete for bandwidth and corrupt each
other's measurements.

## Router → Internet Data Flow

The service adds a live asynchronous job interface while retaining the current
synchronous `start` method for compatibility:

- `start_live` validates the optional server ID, terms acceptance, and global
  test lock, starts a detached worker, and immediately returns a random job ID.
- The worker invokes Ookla CLI 1.2 with `--format=jsonl`, `--progress=yes`, and
  `--progress-update-interval=500`.
- Each JSONL `testStart`, `ping`, `download`, `upload`, and `result` object is
  validated and reduced to the fields needed by the UI. Raw unbounded command
  output is never returned to the browser or retained in history.
- `live_status` accepts the job ID and returns the current phase, progress,
  latest measurements, bounded trace arrays, server and network context, and
  terminal state.
- `cancel_live` accepts the job ID, terminates only that job's process, records
  the cancelled terminal state, and releases the lock.

Runtime job files live beneath `/var/run/ookla-speedtest-webd`. Writes are
atomic. Job IDs are cryptographically random, and every status/cancel request
must match the active job. Terminal runtime files expire after ten minutes.
Successful final results are added to history and analytics. A cancelled job
adds a history entry with outcome `cancelled`, which history can display but
analytics must exclude.

The existing LuCI rpcd adapter, ACL, GL.iNet Lua `oui-httpd` adapter, and
frontend bridge expose the three new methods. No listener or additional port
is introduced; local and GoodCloud access continue through the router's
authenticated web session.

## Device → Router Data Flow

Device → Router remains a browser-to-router measurement over the authenticated
RPC path. Instead of waiting for one aggregate Promise, it runs bounded
parallel payload batches for a fixed measurement window and emits a sample
after each batch. Each sample is calculated from bytes completed over elapsed
wall time and updates the same gauge state model used by internet tests.

The sequence is latency, download, then upload. Payload sizes stay within the
existing service and GL.iNet request limits. The test controller can stop
scheduling new batches immediately when cancelled. The final aggregate is
recorded with `record_local` only after every phase completes successfully.

## Frontend State and Polling

The shared frontend owns one explicit test state machine:

`idle → ping → download → upload → complete`

Any active phase can transition to `cancelled` or `error`. Both mode runs the
complete local state machine and then the complete internet state machine.

During Router → Internet testing, the frontend polls `live_status` every 500
milliseconds. A transient polling failure preserves the last visible sample
and retries with bounded backoff. Repeated failures end in an actionable error
state. The UI never invents progress or throughput between received samples;
CSS interpolation only smooths the needle from the previous real value to the
new real value.

Trace arrays are bounded in both the service and browser. The dial component,
trace renderer, metric strip, path metadata, and final result cards are kept as
separate rendering functions so their behavior can be tested independently.

## Errors and Cancellation

The running screen includes an X control. Cancelling a router test terminates
the active child process and safely releases the shared lock. Cancelling a
local test stops scheduling further requests. Cancellation retains completed
phase values for the current screen, records a cancelled history entry, and
does not create an analytics point.

Timeout, malformed JSONL, oversized output, process failure, and stale job
states produce stable error codes with user-facing messages. The dial retains
the most recent valid sample, identifies the failed phase, and offers Retry.
An interrupted GoodCloud poll is retried before the test is declared failed.

## Accessibility and Responsive Behavior

The live numeric value is exposed through a throttled `aria-live` region.
Phase changes are announced once. The dial and traces have textual labels and
do not rely on color alone. Keyboard users can start and cancel tests, change
mode, and choose a server. Narrow layouts retain one large dial rather than
placing multiple dials side by side. Reduced-motion mode disables needle
sweeps and trace drawing animations while preserving live values.

## Verification

Automated tests will cover:

- JSONL event parsing and rejection of malformed or oversized records;
- asynchronous job start, polling, successful completion, cancellation,
  timeout, lock release, and stale-job cleanup;
- LuCI ACL/RPC and GL.iNet Lua bridge exposure for all live methods;
- adaptive scale selection and monotonically non-shrinking phase scales;
- frontend state transitions, trace bounds, polling retries, and cancellation;
- sequential Both mode and separate final/history result mapping;
- reduced-motion and accessible live-region contracts; and
- deterministic IPK contents and package-version consistency.

Final verification will build the IPKs, install them on `100.66.177.126`, run
both live test paths through the actual GL.iNet Applications view, confirm the
GoodCloud-compatible authenticated route, capture fresh screenshots from the
installed interface, and publish the incremented release and signed feed only
after local and GitHub checks pass.
