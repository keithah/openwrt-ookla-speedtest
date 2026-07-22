# README Speedtest GIF Design

## Goal

Add an animated GIF to the web package README that demonstrates the real
GL.iNet application running a Router → Internet test on `100.66.177.126`.

## Capture

- Capture the application iframe only; exclude browser chrome and the GL.iNet
  navigation shell.
- Use a real Ookla run rather than mocked values or generated frames.
- Show the complete story: idle GO control, ping, live download, live upload,
  and final results.
- Keep ISP, interface, server, and detected VPN-path details visible when the
  application naturally displays them.

## Editing

- Condense the run to a 12–15 second loop by sampling slow sections more
  aggressively while preserving the order and visible motion of the gauge.
- Hold the opening and final states long enough to read.
- Scale to approximately 900 pixels wide and use a generated GIF palette with
  a modest frame rate so the asset remains practical for GitHub README use.
- Do not synthesize measurements, alter result values, or add decorative UI
  that did not appear in the captured application.

## README Placement

Place the animation immediately before the existing real-router screenshot
gallery. Keep the static screenshots because they preserve fine text and the
full final result cards more clearly than an optimized GIF.

## Verification

- Inspect the GIF visually for all five states and a clean loop.
- Confirm its dimensions, duration, frame count, and file size.
- Confirm the README references the committed asset with useful alt text.
- Run the repository documentation/package contract checks and `git diff
  --check` before publishing directly to `main`.
