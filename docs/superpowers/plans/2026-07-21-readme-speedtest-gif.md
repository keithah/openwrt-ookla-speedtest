# README Speedtest GIF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact animated GIF of a real Router → Internet test to the web package README.

**Architecture:** Drive the already-authenticated GL.iNet application through its existing Chromium CDP session and capture only the application iframe as numbered PNG frames. Sample the real run every 250 ms, play those frames at 8 fps to condense the test, hold the opening and final states with repeated frames, then use ffmpeg's palette pipeline to create an optimized looping GIF.

**Tech Stack:** Chromium DevTools Protocol, Node.js WebSocket client, PNG frames, ffmpeg GIF palette generation, Markdown.

## Global Constraints

- The capture must come from the real application running on `100.66.177.126`; do not synthesize measurements.
- Show GO, ping, download, upload, final summary, and the separate result details.
- Capture the application iframe only, excluding GL.iNet navigation and browser chrome.
- Target 12–15 seconds, approximately 900 pixels wide, and a practical GitHub README file size.
- Keep the three existing static screenshots.
- Publish directly to `main` only after visual inspection and repository checks pass.

---

### Task 1: Capture and encode the real application run

**Files:**
- Create: `docs/screenshots/speedtest-demo.gif`
- Temporary: `/tmp/ookla-readme-gif-*/frame-*.png`

**Interfaces:**
- Consumes: Chromium CDP page containing the GL.iNet app iframe and `window.SpeedtestWeb.state`.
- Produces: `docs/screenshots/speedtest-demo.gif`, a looping 8 fps GIF with ordered live states.

- [ ] **Step 1: Confirm the capture prerequisites**

Run:

```bash
test -n "$(curl -fsS http://127.0.0.1:9223/json/list | python3 -c 'import json,sys; print(next((x["webSocketDebuggerUrl"] for x in json.load(sys.stdin) if "100.66.177.126" in x.get("url", "")), ""))')"
ffmpeg -version | head -1
```

Expected: the first command succeeds and ffmpeg prints its version.

- [ ] **Step 2: Capture numbered PNG frames through CDP**

Create a temporary Node.js capture script that:

```javascript
const FRAME_INTERVAL_MS = 300;
const IDLE_HOLD_FRAMES = 8;
const FINAL_TOP_HOLD_FRAMES = 6;
const FINAL_RESULTS_HOLD_FRAMES = 16;

// 1. Connect to the page selected by URL marker 100.66.177.126.
// 2. Clear browser cache and reload the page.
// 3. Resolve the iframe from document.querySelector('iframe').
// 4. Set a 1440x1200 browser viewport and a 900px iframe height.
// 5. Capture the iframe's getBoundingClientRect() with Page.captureScreenshot.
// 6. Repeat the idle frame IDLE_HOLD_FRAMES times.
// 7. Click [data-mode="router-internet"], then #go-control.
// 8. Capture every FRAME_INTERVAL_MS until state.status is done/error/cancelled.
// 9. Reject unless phases include ping, download, upload, and complete and status is done.
// 10. Hold the top final state, scroll the iframe window to the result cards,
//     and hold the lower final state.
```

Save frames as zero-padded `frame-%05d.png` files in a directory created with
`mktemp -d /tmp/ookla-readme-gif-XXXXXX`.

Expected: at least 96 frames and a logged phase sequence containing
`ping`, `download`, `upload`, and `complete`.

- [ ] **Step 3: Encode an optimized looping GIF**

Run from the repository root, replacing `$CAPTURE_DIR` with the explicit
temporary directory printed by the capture script:

```bash
ffmpeg -y -framerate 8 -i "$CAPTURE_DIR/frame-%05d.png" \
  -vf "fps=8,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 docs/screenshots/speedtest-demo.gif
```

Expected: ffmpeg exits zero and creates a looping GIF.

- [ ] **Step 4: Verify duration, dimensions, frames, and size**

Run:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,nb_frames:format=duration,size \
  -of default=noprint_wrappers=1 docs/screenshots/speedtest-demo.gif
```

Expected: width `900`, duration between `12` and `15` seconds, at least `96`
frames, and size below `12000000` bytes. If the file is larger, re-encode with
`max_colors=64` and `scale=800:-1`; do not remove required states.

- [ ] **Step 5: Inspect representative frames and the finished loop**

Run:

```bash
ffmpeg -y -i docs/screenshots/speedtest-demo.gif \
  -vf "select='eq(n,0)+eq(n,12)+eq(n,40)+eq(n,75)+eq(n,105)',scale=450:-1,tile=5x1" \
  -frames:v 1 /tmp/ookla-readme-gif-contact-sheet.png
```

Expected: the contact sheet visibly includes idle/GO, an active gauge, and a
final result state. Inspect both the contact sheet and GIF before continuing.

- [ ] **Step 6: Commit the verified animation**

```bash
git add docs/screenshots/speedtest-demo.gif
git commit -m "docs: add animated speedtest demo"
```

### Task 2: Add the animation to the README and publish

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `docs/screenshots/speedtest-demo.gif` from Task 1.
- Produces: a README hero animation followed by the existing static gallery.

- [ ] **Step 1: Add the GIF before the static screenshots**

Insert this Markdown immediately before “These screenshots are from…”:

```markdown
![Real Router to Internet speed test running in the GL.iNet application](docs/screenshots/speedtest-demo.gif)
```

Expected: all three existing PNG references remain unchanged below it.

- [ ] **Step 2: Run documentation and package checks**

Run:

```bash
python3 -m unittest tests.test_package_layout.PackageLayoutContractTests.test_readme_documents_supported_web_entrypoints
bash tests/goodcloud-contract-test.sh
git diff --check
```

Expected: all commands pass.

- [ ] **Step 3: Commit the README integration**

```bash
git add README.md
git commit -m "docs: feature animated demo in README"
```

- [ ] **Step 4: Push directly to main and verify GitHub Actions**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
gh run list --repo keithah/openwrt-ookla-speedtest --branch main --limit 3
```

Expected: the push fast-forwards `main`; watch the new Test run with `gh run
watch <run-id> --repo keithah/openwrt-ookla-speedtest --exit-status` and require
a successful conclusion.
