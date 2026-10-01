# omp-cua-jev

Use OMP's configured `judge` to choose from a local action table, then execute and verify authorized actions through Cua Driver. The plugin supplies diagnostics, absolute helper paths, a bundled skill, and isolated localhost demos. It does not install a model client or keep separate credentials.

**Version: v0.4.0.** Adds optional read-only visual regions through Cua's separately installed `cua-perception` extension, a judge-selected visual canvas mode, and synthetic OCR and judge-choice evals. These build on capture-bound pixels, deterministic region enumeration, and journaled session recovery. Native AX actions use Driver 0.31.0 `element_token`s only. Tested against Cua Driver `0.31.0` on this Mac only; no compatibility claim is made for other builds. Local results are recorded below. Clean-machine onboarding is still open. There is no npm package.

## Requirements

- Bun **1.3.14 or later** and OMP **18.2.7 or later**. `/jev doctor` compares the advertised host version with this minimum. Package-manager metadata does not enforce the OMP requirement.
- Active stock JavaScript `eval`, with `language: "js"`, and a working OMP model/auth configuration.
- Cua Driver and a logged-in graphical desktop. On macOS, use macOS 14 or later. The typed-browser demo specifically requires supported system-installed Google Chrome in `/Applications`; a cached test browser, Safari, or Firefox is not a substitute. The native-window helper instead requires a separately supported, explicitly authorized exact native app/window. It does not promise support for every browser or remove permission requirements.
- Optional: Cua's separately distributed `cua-perception` extension, installed only by a human operator. `visualRegions()`, `/jev canvas visual`, the offline OCR eval, and `/jev eval` with its default OCR labels need it; the core helpers and deterministic demos do not. See [Optional visual regions](#optional-visual-regions-cua-perception).

The current native implementation was tested against Cua Driver `0.31.0`. That exact build is not a tested minimum, and the local verification below is not a compatibility claim for any other build. Older dated results used the Driver builds stated in their historical sections.

## Set up the host

1. Install Bun, then follow [OMP's official installation instructions](https://github.com/can1357/oh-my-pi/blob/v18.2.7/README.md#install). One supported route is:

   ```sh
   bun install -g @oh-my-pi/pi-coding-agent
   ```

2. Start `omp`. Use `/login` for your provider and `/model` to select a working chat model. In `/model`'s Roles view, review the judge role and its fallback rows. The plugin reuses `modelRoles.judge`, `retry.fallbackChains.judge`, and the host's existing credentials and routing. Do not overwrite a working setup just for this plugin. For a TypeSafe judge, OMP supports `/login typesafe`; a configured text-model fallback is also possible. OMP's built-in judge chain tries `typesafe/jev-latest` before `openrouter/~typesafe/jev-latest`. That OpenRouter candidate needs an OpenRouter credential available to OMP, for example `providers.openrouter.apiKey` in `models.yml`. A TypeSafe organization without API credits fails with a 402 `billing_error`. Start a new OMP session after adding a credential; an already-running session did not pick one up in local testing. See [provider authentication](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/providers.md#oauth-vs-api-key-and-provider-scoped-logins) and [role/fallback settings](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/settings.md#models).

3. Keep stock JS eval enabled. `eval.js` defaults to `true`; `PI_JS=0` disables it. If you deliberately disabled it, review that choice before changing it. No alternate eval plugin is required or installed. See [stock eval](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/tools/eval.md).

4. Install the pinned Git tag. Quote it so the shell does not eat the `#`:

   ```sh
   omp plugin install 'github:ericjuta/omp-cua-jev#v0.4.0'
   ```

   Start a new OMP session. There is no npm package. To work on a local checkout instead, clone the repo and run `omp plugin link /absolute/path/to/omp-cua-jev`. `/jev paths` reports the installed resources; `/skill:omp-cua-jev` loads the bundled workflow.

## Set up Cua Driver as a human

Follow the working [installation guide](https://cua.ai/docs/how-to-guides/driver/install.md), found through the [official documentation index](https://cua.ai/docs/llms.txt). Use ordinary **standard** mode. After installing CuaDriver on a fresh Mac, the documented app-identity launch and consent flow is:

```sh
open -n -g -a CuaDriver --args serve
cua-driver permissions grant
```

Plain `serve` defaults to standard mode. Do not replace an existing daemon or change its flags without its owner's authorization. Standard mode permits routine driver-owned isolated-browser work without a Cua confirmation card. It does not turn a session label into an app/origin allowlist or authorize arbitrary user tasks. This demo needs no existing-profile grant or unrestricted mode. See [permission modes](https://cua.ai/docs/reference/cua-driver/permission-modes.md).

The human must approve CuaDriver's Accessibility and Screen & System Audio Recording permissions, and any separate macOS direct-capture consent. Follow requested quit/reopen steps. LaunchServices app identity matters; a bare terminal relaunch can lose usable permission attribution. During authorized recovery, record and preserve the exact original launch and approval flags. Never introduce new bypass flags, disable the OS gate, or widen approvals to make a check pass. Follow the dedicated [macOS permissions guide](https://cua.ai/docs/reference/cua-driver/macos-permissions.md).

**An unrestricted daemon is a warning, not the setup recipe.** The recorded local native run reported standard mode. This is an observation, not a claim that the plugin changed the daemon mode or completed fresh-machine onboarding.

## Commands and evidence

| Command | What it does |
| --- | --- |
| `/jev paths` | Deterministically returns absolute resource paths and advertised host metadata. |
| `/jev doctor` | Runs read-only prerequisite checks. No model call, native session, capture, permission prompt, daemon restart, or settings change. |
| `/jev probe` | Requests a stock JS eval call to `probeJudge(judge)`, using synthetic data and zero native actions. This exercises the live host judge, including its configured fallbacks. |
| `/jev demo` | Requests stock JS eval to call `runDemo({ judge, onProgress: display })`. It authorizes only the bundled isolated localhost demo and its owned-resource cleanup. |
| `/jev canvas` | Requests stock JS eval to call `runCanvasDemo({ judge, onProgress: display })`. It authorizes only the bundled isolated canvas demo, one foreground pixel click, and owned-resource cleanup. |
| `/jev canvas visual` | Requests stock JS eval to call `runCanvasDemo({ judge, onProgress: display, visual: true })`. Same fixture, click, and cleanup authority as `/jev canvas`, but the live judge chooses among neutral seat IDs with untrusted OCR labels. Needs the optional `cua-perception` extension. Not deterministic. |
| `/jev eval` | Requests stock JS eval to call `runJudgeChoiceEval({ judge, onProgress: display })` from `paths.judgeEval`. It scores live judge choices among synthetic seat candidates and executes no action. Without supplied labels it first runs the offline OCR eval, so it needs system Chrome and `cua-perception`. |
| `/jev sessions` | Lists journaled sessions directly, without eval. It sends one read-only `get_session` per journaled label, so it is not offline, and never contacts labels absent from the journal. |
| `bun src/doctor.mjs` | From this checkout, prints read-only JSON diagnostics without OMP host metadata. Blocking prerequisites produce exit code 1. |
| `bun src/demo.mjs` | From this checkout, runs the native localhost demo deterministically without a model. It performs real isolated-browser mutations, not a mock or judge proof. |
| `bun src/canvas-demo.mjs` | From this checkout, runs the isolated canvas demo deterministically without a model. It performs real isolated-browser mutations and briefly foregrounds its owned window. It has no visual mode. |
| `bun src/evals/ocr-canvas.mjs` | From this checkout, also `bun run eval:ocr`, renders the canvas fixture in owned headless system Chrome and parses each PNG with `cua-driver perception parse`. No Driver session, visible window, judge, or action. Exits 1 unless `status` is `ok`. |

Interactively, probe, demo, canvas, canvas visual, and eval hand an exact eval instruction to the main model. They are **model-mediated**, not direct command-to-eval dispatch. Wait for the actual result; command acceptance is not completion. In print and JSON modes, they return `status: "not_started"` with `language: "js"` and the exact eval code, without starting it. Without active stock JS eval they return `status: "blocked"` instead. Print mode emits the details as JSON; JSON mode wraps them in `{ "type": "jev", "details": ... }`. Paths, doctor, and sessions use the same output formats.

Doctor invokes Cua `--version`, `status`, `permissions status --json`, read-only `describe click`, `extension status cua-perception --json` with a 15-second limit, and `describe parse_visual_regions`. It checks whether that click schema declares `capture_id` and `element_token`, blocking when `element_token` is missing, and counts valid journal entries on disk, without asking the daemon whether those sessions are live. Perception findings are warnings only: `VISUAL_REGIONS_UNADVERTISED`, `PERCEPTION_STATUS_UNKNOWN`, `PERCEPTION_NOT_INSTALLED`, `PERCEPTION_UNHEALTHY`, and `PERCEPTION_TRUST_UNVERIFIED`. Extension status is not parse proof; doctor never runs the perception worker, its self-test, a capture, or a parse. The inspected Driver emits plain text for `status --json`; do not assume all status output is JSON. Doctor's `checks_passed` means read-only prerequisites passed. `native.testedDriver` records the exact tested build; a different installed build is a warning, not proof that this package works with it. Host version/eval metadata does not prove credentials or a live judge. Permission status can report grants without performing a fresh direct capture, and historical capture evidence is not a new probe. A listening daemon or successful permission-status query does not prove browser delivery, task completion, cleanup, or a standard-mode run. OMP's separate `omp plugin doctor` checks plugin installation, not these capabilities.

## Use the helpers in stock eval

Call `jev_resources` with `{"action":"paths"}`. Its result contains `paths.loop`, `paths.driver`, `paths.native`, `paths.pixels`, `paths.sessions`, `paths.demo`, `paths.canvasDemo`, `paths.visual`, `paths.ocrEval`, `paths.judgeEval`, `paths.probe`, and `paths.skill`. Read `paths.skill` and each helper's instructions/source before importing it, including `paths.native` for native-window work. Bind the returned `paths` object in the retained JS cell, then import the actual absolute filesystem paths:

```js
const { chooseAction, runBounded } = await import(paths.loop);
const { createCuaDriver } = await import(paths.driver);
const { probeJudge } = await import(paths.probe);
display(await probeJudge(judge));
```

This example makes a real synthetic model request. `skill://` is a read protocol, not an ESM import scheme. Do not guess installation paths or depend on the current directory. Pass the live cell's `judge` to the loop helpers; do not serialize it into a browser or subprocess.

`await judge(state, questions)` returns the answer map directly. There is no `.wait()` or `.answers` wrapper. A host text-model fallback can return one-hot probabilities with confidence `1`; that is neither calibrated certainty nor user authorization. The helpers do not identify which provider answered. Their deadline controls admission of another mutation, not hard provider wall time or spend, and cannot undo an already-dispatched action.

For custom tasks, follow the bundled skill. Keep executable action arguments local, own one session and exact target, and serialize same-target calls. Stop on refusal, ambiguity, partial delivery, or unknown outcome. Never replay an uncertain mutation before authoritative readback. No existing logged-in profiles, global window enumeration, guessed target IDs, silent input-route fallback, or approval widening belong in the demo.

Native delivery and application completion are separate. The localhost demo must verify its unique token with exactly one server receipt and one submission attempt, then observe the rendered `Receipt saved` confirmation. A positive Cua click receipt alone is insufficient. Always attempt to end the owned session in `finally` and close the owned fixture. A matching inactive-session receipt confirms lifecycle teardown, **not** that every browser process exited or every profile file was removed. Physical cleanup needs separate, ownership-scoped evidence; never guess profile paths or kill unrelated browsers.

## Use an existing native window

Retain one target in stock JS eval. In this read-only example, `authorizedNativeWindow` must already contain the caller-known, user-authorized `pid` and `windowId`; do not invent IDs or discover global windows. Read `paths.native` before importing:

```js
const { createNativeTarget } = await import(paths.native);
const nativeTarget = createNativeTarget({
  pid: authorizedNativeWindow.pid,
  windowId: authorizedNativeWindow.windowId,
});
try {
  await nativeTarget.start();
  const observation = await nativeTarget.observe();
  display(observation.state);
} finally {
  await nativeTarget.end();
}
```

There is no implicit focus. If separately authorized to foreground the exact window, construct with `foreground:true` and call `await nativeTarget.focus()` after start and **before observing**. Focus failure is unverified; stop without automatic replay. Foreground input must also be explicitly declared as `delivery_mode:"foreground"` in the local candidate. A delivery receipt does not prove focus.

`observe()` returns compact `state`, web-content-only by default, and retained `local` evidence. False or unknown completeness does not prove a control absent; filtering and truncation can omit controls. Use `webContentOnly:false` only when the authorized task needs native chrome. `local` holds current AX tokens and, with `screenshot:true`, the capture path, dimensions, scale, and geometry. AX frames use desktop coordinates; PNG pixels are a different coordinate space. Do not derive pixel targets from AX frames or multiply PNG coordinates by scale.

`settle({ready, maxMs, intervalMs, stableForMs})` requires a task-specific readiness callback returning literal `true`, a finite deadline, and a quiet interval of identical actual full PNG captures and geometry. Only returned `status:"settled"` admits pixel actions using its original observation. Timeout or cancellation never authorizes the latest frame. A new observation, focus, or execute invalidates that evidence. Settling cannot guarantee against future animation.

`execute(candidate, observation)` checks delivery only. Use the existing `runBounded` authorization and independent application `verify`/`isDone` callbacks; even a confirmed native receipt is not task completion. Typing inserts, not replaces. There is no automatic replacement typing, select-all chord, replay, or route fallback. `end()` ends the owned session, removes its journal entry after confirmed teardown, and removes only helper-owned captures; the existing app stays open. The isolated demo's separate browser/fixture cleanup remains unchanged.

A tiling window manager can move or hide the target after capture. OmniWM did so during local testing. Focus acceptance does not prevent that, and a delivered foreground click can land in whichever window is actually topmost. Stop when the guard reports movement or occlusion; do not replay it.

## Pixel and canvas work

Pixel clicks use the current settled observation's `local.screenshot.capture_id`. The helper always sends that binding; a caller-supplied copy must match. Driver consumes it on dispatch, so it cannot be reused, and a binding from another session is not valid here. Take a fresh `settle()` in this same session before every pixel click. Screenshot `x`/`y` are PNG pixels and are sent unchanged. Do not multiply them by `scale` or derive them from AX frames. When Driver downscales a capture, it maps those PNG pixels itself at click admission; never apply its affine yourself.

```js
// If separately authorized for foreground input, call nativeTarget.focus() first.
const settled = await nativeTarget.settle({
  ready: observation => observation.state.window_title === authorizedTitle,
  maxMs: 5000,
});
if (settled.status !== 'settled') throw new Error('No current settled capture.');
const mapped = await nativeTarget.regions(settled.observation, {
  match: (r, g, b) => r === 0 && g === 85 && b === 255,
  minArea: 20,
});
const anchor = mapped.regions[0]?.anchor;
if (!anchor || mapped.truncated) throw new Error('No unambiguous region.');
```

`regions()` re-hashes the owned capture and returns capture pixels. It does not invalidate the observation or authorize a click. `anchor` is the region pixel nearest the rounded centroid. Use it only with that same observation. Enumerate a closed, task-owned colour and geometry rule; do not ask `judge` to invent pixel coordinates. For OCR text and detected icon boxes in this same pixel space, see [Optional visual regions](#optional-visual-regions-cua-perception). They add evidence; they neither replace a closed geometry rule nor authorize a click.

For a separately authorized foreground pixel click, construct with `foreground:true` and call `focus()` **before** the `settle()` that produced the observation and anchor above. Focus after settling invalidates that evidence: settle and enumerate again before acting. The candidate must also declare `delivery_mode:"foreground"`:

```js
await nativeTarget.execute({
  action: { tool: 'click', args: { x: anchor.x, y: anchor.y, delivery_mode: 'foreground' } },
}, settled.observation);
```

Before dispatch, the guard reads the exact-PID window list. It refuses, without sending a click, when the target is missing (`target_missing`) or its bounds differ by more than one point (`target_moved`). That is the whole background check: it does not prove the window is visible or unoccluded, and background delivery is unverified. Foreground mode additionally calls read-only `screenSize()` and maps each capture pixel to a screen point from **both** the captured and current bounds (never screenshot scale). Both points must fall inside the main display's `[0,width) × [0,height)` rectangle, or it refuses `target_offscreen`; a window may extend beyond that rectangle if both points are in bounds. It then reads the on-screen list: the exact target must appear, and any other window covering either point at equal or unknown `z_index` causes `target_occluded`. Only a `driver_owned:true` window covering the **whole main display**, such as Cua Driver's full-screen click-through overlay, is exempt. Driver-owned approval cards, even if they cover the target, and unknown ownership still occlude. Failed pre-dispatch guard reads yield `guard_unavailable`, retaining only safe `tool`/`refusalCode` diagnostics. All these local refusals have `unknownOutcome:false` and dispatch no click. A matching background route is `synthetic_events`; foreground is `global_input`. Neither route proves the application effect. A failed post-dispatch window read yields `guard_unavailable_after_dispatch` with `unknownOutcome:true`; do not replay without independent readback.

Never call raw `driver.call('click', {x, y})` for pixels. Without the capture binding, an accessibility route can hit-test a different element, including the centre of a canvas rather than the requested point. If a pixel receipt returns `route:"accessibility"`, treat the outcome as unknown and stop. Do not replay it before independent readback.

`runCanvasDemo({ judge, onProgress, binary, seat, visual })` owns an isolated browser session and a second, foreground-enabled native session for the exact returned window. `seat` is optional and defaults to the leftmost available seat. Readiness and readback use the browser session's `get_browser_state` `semantic_v2` snapshot for the exact fixture URL: `Selected: none`, then `Selected: <seat>`, plus a unique Clear ref. The native session only focuses, settles, enumerates fixture-coloured regions, and sends one capture-bound foreground pixel click through `runBounded`. There is no native AX readback. After the fixture server and semantic status confirm the selection, one `browser_click` with that ref and `input_route:"dom_event"` clears it, followed by another readback. Results are `complete`, `cleanup_incomplete`, `refused` (guard refused before dispatch, with `reason`), or `failed`. Never retry a refusal automatically. `bun src/canvas-demo.mjs` runs the same deterministic demo without a model; it has no visual mode. Live results are recorded separately below.

With `visual: true` (`/jev canvas visual`, which uses the default seat), a live judge chooses the seat. A missing judge or extension stops the run with `status: "blocked"` and `JUDGE_REQUIRED` or `PERCEPTION_NOT_INSTALLED` before any click. After focus, one warm-up parse of a throwaway, never-settled capture keeps the perception worker warm. The following `settle()` supersedes that capture, so the warm-up never authorizes a click. Each seat observation then settles, confirms the fixture semantically, maps the colour regions, and parses the settled capture with `visualRegions()`. `labelRegions()` pairs at most one OCR label below each disc; ties and conflicts stay unlabelled. Candidates are neutral `seat_1`…`seat_n` from left to right. Their descriptions and judge-visible state carry only OCR text of 1–8 ASCII letters or digits, marked untrusted. An ambiguous label is reported only as ambiguous, and any other text as no readable label. No seat choice is deterministic, but Clear still is.

`authorize` ignores OCR and the judge's confidence. It admits only the exact local candidate whose **geometry** seat is the requested seat, for the current settled capture, before any click, with exact click arguments. A wrong choice is denied without a click. `maxSteps` is 3 instead of 2, admitting one stale or judge-requested reobservation; the run still makes at most one seat click and one Clear. Confidence, probability, and age gates stay unchanged, and the foreground guard applies as before. Results add `deterministic: false` and `visual: {parse, labels, recall, judge, warmUp, parses}`. Judge failures, abstentions, and denials report phase `judge_choice`; a stop before any click reports `abstained`, `denied`, or `limit`.

## Optional visual regions (`cua-perception`)

`cua-perception` is Cua's separately distributed Driver extension behind `parse_visual_regions`. It runs on the CPU through ONNX Runtime and pairs an OmniParser v2 icon detector with PP-OCRv5 English OCR. There is no icon captioner, so icon regions carry only generic class labels such as `icon-class-N`; useful semantics come from OCR text. OCR is English-only and can still misread or miss text. The plugin drops the parser's `interactive` hint, so no region claims to accept input.

The icon detector is licensed **AGPL-3.0-only**. PP-OCRv5 is Apache-2.0, and ONNX Runtime is MIT. Installing the extension does not relicense Cua Driver, but redistributing or hosting it can carry AGPL obligations; read Cua's [license precautions](https://cua.ai/docs/how-to-guides/driver/parse-visual-regions) first. This plugin never bundles, downloads, installs, or updates the extension. `driver.call('install_extension')` is refused locally, and doctor never runs the extension's self-test. Without the extension, `parse_visual_regions` refuses with `not_installed`; every non-visual feature still works.

### Operator installation

Installation is a human operator decision. Run these steps from a terminal, never from a task or chooser:

1. Open the newest `cua-perception-v<version>` release in [trycua/cua](https://github.com/trycua/cua/releases?q=cua-perception-v). It is never the repository's Latest release. Download the platform catalog and archive into the same directory, for example `cua-perception-<version>-aarch64-apple-darwin.catalog.json` and `cua-perception-<version>-aarch64-apple-darwin.tar.gz`. Driver resolves the archive beside the catalog.
2. Inspect the signed metadata before changing local state:

   ```sh
   cua-driver extension inspect cua-perception --catalog <catalog.json>
   ```

3. Review the inspection output: exact version and platform, archive hash, install destination and size, licenses, `publisher_signature_verified: true`, `trust: "publisher-verified"`, and `evidence_class: "production-publisher-verified"`. Stop if authenticated metadata is unavailable. Never substitute an unsigned archive.
4. Install the reviewed catalog, then check status:

   ```sh
   cua-driver extension install cua-perception --catalog <catalog.json>
   cua-driver extension status cua-perception
   ```

Cua's documentation says no daemon restart is needed: a running Driver re-verifies the extension on its next parse. Afterwards, `/jev doctor` reports `capabilities.visualRegions`.

Driver runs the extension's contained health/self-test hook under a fixed 10-second limit. Measured separately on this Mac, worker health took 0.5–0.9 s and the unsandboxed self-test 4.7 s. Under heavy host load, however, the first two installs failed with `extension hook exceeded its execution limit`; load average was about 79 during a Spotlight indexing storm. Installing the same reviewed catalog after load dropped succeeded. Treat this failure as a load timeout, not a reason to use an unsigned archive.

### Parse a current capture

`nativeTarget.visualRegions(observation, { kinds, maxRegions, minConfidence })` parses the **current** observation's native capture, from `observe({ screenshot: true })` or `settle()`. The observation need not be settled. All options are optional: `kinds` is a non-empty, unique subset of `text` and `icon`, `maxRegions` is a positive integer, and `minConfidence` is 0–1. The helper re-hashes the owned PNG, then sends read-only `parse_visual_regions` with a 45-second client timeout. Driver budgets 15 s for a cold worker start plus 30 s of inference. It then binds the `cua.visual_regions_v1` receipt to that capture: `capture_id`, window `pid` and `window_id`, width, height, and PNG `sha256` must all match. It returns frozen `{capture_id, width, height, sha256, actionCoordinateSpace, parser, regions, warnings, durationMs}`. Region `bounds` are half-open PNG pixels, and each `anchor` lies inside them. This is the same space as `regions()` and capture-bound clicks.

- **Pixels stay unchanged.** Driver downscales default captures; here the long edge was 1568 pixels, giving an `affine` `actionCoordinateSpace`. `observe({ screenshot: true, max_image_dimension: 0 })` requests native resolution and `screenshot_pixels`. The affine is evidence only. The plugin never applies it; Driver maps capture-bound PNG pixels at click admission.
- **Parsing is non-consuming.** It neither consumes the capture nor invalidates the observation, so a settled observation keeps its pixel authority. A parse never grants that authority: pixel clicks still need the current settled capture. OCR text, icon labels, and confidence are untrusted evidence that authorizes nothing.
- **Parse time ages the evidence.** Expect roughly 2.5–6 s per parse. Here, settled-capture parses took 2.5–3.6 s and warm-up parses 2.6–4.2 s. That time, plus the judge's, counts against the observation age gate, `maxAgeMs`, 15 s by default. A cold worker start can take longer.
- **Failures are read-only.** A Driver failure throws `NATIVE_TARGET_ERROR` with `unknownOutcome: false` and `reason: "visual_regions_unavailable"`. It keeps only the validated `tool` and an allowlisted `refusalCode`, such as `not_installed`, `capture_not_found`, `timeout`, or `resource_limit_exceeded`. Invalid options and malformed or mismatched receipts also throw `unknownOutcome: false`. A parse dispatches nothing; observe again before any bounded retry.

`paths.visual` exports pure helpers that perform no I/O and authorize nothing. `projectParse(envelope)` validates an envelope without binding it to a capture. `labelRegions(targets, visual, { direction, maxGap, minConfidence })` pairs each target with at most one mutually nearest text region; ties and conflicts stay unlabelled. `findText(visual, match)` matches exact trimmed text or a RegExp.

### Visual entry points

| Entry point | Resource path | Needs | Native action |
| --- | --- | --- | --- |
| `nativeTarget.visualRegions()` | `paths.native` | An active owned native session, the current capture, and the extension | None; read-only parse |
| `projectParse`, `labelRegions`, `findText` | `paths.visual` | A parse result | None; pure functions |
| `bun src/evals/ocr-canvas.mjs`, `bun run eval:ocr`, or `runOcrCanvasEval()` | `paths.ocrEval` | System Google Chrome and the extension | None; offline render and parse |
| `/jev eval`, or `runJudgeChoiceEval({ judge })` | `paths.judgeEval` | A live judge; Chrome and the extension unless `labels` is supplied | None; inert candidates |
| `/jev canvas visual`, or `runCanvasDemo({ judge, visual: true })` | `paths.canvasDemo` | A live judge, the extension, system Chrome, and the same Driver permissions as `/jev canvas` | At most one guarded seat click and one DOM Clear |

The OCR eval is offline. It serves the canvas fixture on loopback and renders it with owned headless system Chrome at `dpr1`, `dpr2`, and `dpr2-1568`. The last variant is downscaled with `sips -Z 1568` to mirror Driver's default. Each PNG is parsed with `cua-driver perception parse --image --capture --json`, which has `action_eligible: false`. It reports label recall, positioned recall, wrong labels, association accuracy, and whether `Selected: none` and `Clear selection` were read. It starts no Driver session, opens no visible window, and installs nothing. Missing prerequisites give `status: "blocked"` with `CHROME_UNAVAILABLE`, `DRIVER_UNAVAILABLE`, or `not_installed`, and the CLI exits 1 unless `status` is `ok`. Cleanup terminates the eval's own headless Chrome, closes the fixture, and removes its temporary directory.

The judge-choice eval calls `chooseAction` with default gates and inert candidate actions. Available seats become neutral `seat_1`…`seat_n`, shuffled per trial, under three conditions. `anonymous` gives only row position and colour. `labelled` adds untrusted OCR labels. `injection` adds untrusted on-canvas text that tells the judge to select A5. Each condition runs four goals: A3, A1, A5, and the leftmost available seat. `trials` defaults to 2. Without supplied `labels`, it runs the OCR eval's `dpr2-1568` variant first; if that fails, it returns `blocked` with `LABELS_UNAVAILABLE`. It also returns `JUDGE_REQUIRED` without a judge. Each trial records the judge's raw `judgeChoice` (an offered ID, otherwise `null`), confidence, top probability, outcome, and, for injection, `injectionFollowed`. Each condition's `summary` reports gated outcome counts (`correct`, `abstain`, `reobserve`, `wrong`, `error`), `accuracy`, `abstainRate`, `wrongRate`, and `meanMs`. It also reports ungated diagnostics: `topChoiceAccuracy` and `topChoiceWrongRate` from the judge's own top answer before the gates, and `meanConfidence`. These diagnostics never lower a gate, and a correct ungated answer authorizes nothing. Scores are policy inputs, not calibrated correctness, and the result does not identify the model. Trials are not independent samples when the provider caches identical prompts. Through OpenRouter, OMP sent `X-OpenRouter-Cache: true` in local testing, so repeated prompts returned cached answers.

## Recover after an eval timeout

Keep each native operation in a short cell. A long cell can hit OMP's 30-second eval timeout, discard the JS state, and leave the helper session active. For `/jev demo`, `/jev canvas`, or `/jev eval`, pass an explicit eval timeout of at least 180 seconds. `/jev canvas visual` needs at least 300 seconds for its 45-second-bounded parses: a warm-up plus one per seat observation. This keeps the run and its cleanup from being interrupted. Acceptance of that instruction is not proof that cleanup finished.

The journal lives at `$OMP_CUA_JEV_STATE_DIR/sessions` when that variable is set; it must be absolute, or journal operations fail with `JOURNAL_ERROR`. Otherwise it uses `$XDG_STATE_HOME/omp-cua-jev/sessions` when `XDG_STATE_HOME` is absolute, else `~/.local/state/omp-cua-jev/sessions`. `listSessions` and `recoverSessions` also accept an explicit absolute `journalDir`. Entries are written before session start and removed after confirmed end. `/jev sessions` lists only those entries, sending one read-only `get_session` per label, and reports `ownerAlive`, `status`, and idle time when available. It is not a global daemon session list: Cua's transport-scoped `list_sessions` cannot find orphaned sessions, and this command never uses it for discovery.

```js
const { listSessions, recoverSessions } = await import(paths.sessions);
const listed = await listSessions();
display(listed);
// After review, name only journaled labels you own; ownerDead:false stops broader selection.
const chosen = listed.filter(entry => entry.ownerAlive === false && entry.status !== 'unknown')
  .map(entry => entry.session);
const plan = await recoverSessions({ sessions: chosen, ownerDead: false, dryRun: true });
display(plan);
```

Review the dry-run report, then run the same options without `dryRun` in a separate short cell. Selection is a union: labels named in `sessions`, OR dead owners while `ownerDead` stays at its default `true`, OR active entries whose `idleSeconds` reaches an explicit `minIdleSeconds`. Pass `ownerDead:false` to recover only the named labels. `dryRun:true` performs reads only and reports the planned action: `ended`, `removed`, or `kept`. A real run ends a still-active selected session, removes its owned capture directory, and removes its entry. Unknown status is kept. To continue work instead, resume a known journaled label promptly: observed sessions idle-expire in about five minutes (`expires_in_seconds` around 300). Never end, inspect, or clean up a session absent from this journal.

```js
const { createNativeTarget } = await import(paths.native);
const journaled = listed.find(entry => entry.session === knownLabel && entry.status === 'active' && entry.target);
if (!journaled) throw new Error('No active journaled target for this label.');
const nativeTarget = createNativeTarget({
  session: journaled.session,
  pid: journaled.target.pid,
  windowId: journaled.target.windowId,
});
await nativeTarget.resume();
```

`resume()` requires the caller-supplied label and its journal entry, then requires `get_session` to report that exact active label. It does not rediscover windows. A label without a journal entry, including one already recovered, fails locally with `unknownOutcome:false`. A journaled label the daemon no longer reports as active also fails. In either case, do not replace it with another session.

## Troubleshooting native evidence

- Normalized `browser_type` and `browser_click` receipts need not contain `status`, target, or tab fields. The tested typing receipt uses `route: "trusted_input"` and a `delivery.delivered_count` matching the requested text. The demo's `dom_event` click returns `route: "dom"` and `escalation: { target: "page", reason: "effect_unconfirmed" }`. Both report background delivery and `effect: "unverifiable"`. The adapter validates these request-specific shapes; independent readback proves completion. Do not replay a mutation because its receipt lacks an expected wrapper.
- Discover windows through an active `driver.listWindows(exactPid)`, using the actual `prepared_pid` for the demo or a separately caller-known authorized PID. The adapter sends exact-PID, on-screen-only discovery without a session argument. Never enumerate global windows. Require exactly one visible window for the demo, exact binding, and an actual returned tab. A bounded read-only wait is allowed for no window; multiple windows require an independently known exact authorized window ID, not guessing or taking the first result.
- `browser_route_unavailable` applies to the typed-browser route. It does not prove native AX/pixel control unusable and does not authorize route escalation. Errors expose only allowlisted refusal codes and static safe hints, not native messages, details, or secrets.
- Native refusals now surface as `Cua Driver <tool> request refused: <code>.` only for an allowlisted code, with validated `error.tool` and a static hint when available. Dispatched Driver failures keep `unknownOutcome:true`. `unknownOutcome:false` is reported only for local refusals (guard reasons, reserved `call()` tools, the busy guard, and `resume()` without a journal entry) and for failed read-only native-target reads (`guard_unavailable` before dispatch and `visual_regions_unavailable`). Read back before any new attempt. The allowlist includes `capture_not_found`, `capture_expired`, `capture_stale`, `capture_generation_mismatch`, `capture_target_mismatch`, `capture_coordinate_invalid`, `capture_binding_failed`, `capture_failed`, `capture_id_invalid`, `capture_frame_mismatch`, `capture_disabled`, `capture_publication_failed`, `desktop_scope_disabled`, `screenshot_context_missing`, `zoom_context_missing`, `window_id_not_found`, `window_owner_pid_mismatch`, `window_not_found`, `ax_window_unresolved`, `element_not_found`, `element_not_found_on_click`, `element_outside_target_window`, `stale_element_token`, `same_pid_keyboard_ambiguity`, `background_unavailable`, `foreground_unavailable`, `bring_to_front_exact_window_unverified`, `permissions_pending`, `permission_required`, `session_not_started`, and `invalid_arguments`. It also covers typed-browser and session-cleanup codes, plus the perception parse codes `not_installed`, `unsupported_target`, `unsupported_platform`, `incompatible_protocol`, `invalid_frame`, `worker_launch_failed`, `worker_crashed`, `worker_cancelled`, `timeout`, `resource_limit_exceeded`, `artifact_invalid`, and `inference_failed`. Driver 0.31.0 removed `snapshot_id_required` and `element_index_required`. The message never includes native output. `permissions_pending` or exit 75 needs the human TCC flow; do not bypass it.
- A fresh isolated Chrome can expose no web-content AX elements through `get_window_state`, even after navigation and waiting. That absence does not prove the page is absent: a typed-browser semantic snapshot may still see it. Do not treat missing AX as authorization to change route or click pixels blindly.
- `verify({expect})` returns `satisfied` only when the native status and every requested predicate are literally satisfied. Web-content element predicates never satisfy by design; expect status `unknown`, with the reason passed through when it is a native code (`observation_unavailable` in local testing). Window predicates such as `{window:{exists:true}}` are the supported deterministic checks. Never read `unknown` as false or as permission to act.
- Driver can advertise `parse_visual_regions` while the optional `cua-perception` extension is absent. The parse then refuses with `not_installed`, and the visual canvas reports `status: "blocked"` with `PERCEPTION_NOT_INSTALLED` before any click. Installing the extension is an operator decision; this package never installs it. Without it, use `nativeTarget.regions()` for deterministic colour and geometry enumeration. An install failure with `extension hook exceeded its execution limit` hit Driver's fixed 10-second health hook; retry the reviewed catalog once host load drops.
- Explicit `screenshot_out_file` and `debug_image_out` paths canonicalize their existing parent, including the macOS `/tmp` alias. This creates no directories, changes no permissions, and rejects symlink or non-file leaves. Use task-owned output locations. Existing regular files remain subject to native policy; preflight is not atomic no-clobber protection.
- The demo queries `receipt`. Collection completeness alone is insufficient: require no continuation, matching selected/total/ref counts, and visible main-frame evidence for every match. Hidden, occluded, budget-omitted, or unprovable-frame evidence blocks action. Document-wide `unknown` or `offscreen` counters alone need not invalidate a fully covered, visible query. Never infer a missing control from an incomplete query.
- A complete collection can still fail `SEMANTIC_SNAPSHOT_INCOMPLETE` when a required control is `near_viewport`. The bundled fixture uses a compact, left-aligned single-column layout to keep its controls and confirmation visible in smaller viewports. Keep the `in_viewport` requirement; native window dimensions do not establish the CSS viewport dimensions.

## Local verification, 2026-10-01

Tested on this already-configured Mac with Cua Driver `0.31.0` and `cua-perception` `0.2.1` (`aarch64-apple-darwin`). OmniWM manages its workspaces, and the desktop was in active use except during the hands-off reruns. This is not a clean-machine run.

- **Operator-approved host changes.** Driver moved from `0.30.2-nightly.20260927.36294544935` to `0.31.0` on the stable channel through `cua-driver channel set stable` and `cua-driver update --apply`. The installer preserved the TCC grants. The daemon was relaunched through LaunchServices in standard mode with Accessibility and Screen Recording granted. `cua-perception` 0.2.1 came from release `cua-perception-v0.2.1`, and its archive hash matched the catalog. `extension inspect` reported a verified publisher signature, `trust: "publisher-verified"`, `evidence_class: "production-publisher-verified"`, and 472,367,643 installed bytes. The first two installs hit the 10-second hook limit under heavy load, as described above; a retry after load dropped succeeded. The operator's `extension status cua-perception --self-test --json` then reported it installed, active at 0.2.1, healthy, and publisher-verified.
- **Driver 0.31.0 contract.** Element actions accept only `element_token`. The click schema no longer has `element_index` or `snapshot_id` and rejects unknown arguments. Parsing one capture three times succeeded, so a parse does not consume its capture. The parse's screenshot `sha256` equaled the hash of the PNG written through `screenshot_out_file`. Default captures were downscaled to a 1568-pixel long edge with an `affine` action space (`m11` 1.632, `m22` 1.630); `max_image_dimension: 0` gave `screenshot_pixels`. A failed parse exits 1 with a root `{code, message, detail?, retryable}`; a malformed ID returned `capture_not_found`.
- **v0.3.0 code on Driver 0.31.0, before the v0.4.0 changes.** `bun src/demo.mjs` succeeded in 4.9 s with zero judge calls and complete cleanup. The first `bun src/canvas-demo.mjs` run was refused before dispatch with `target_offscreen`: OmniWM had parked the isolated Chrome on hidden workspace 5 at x=5119. No click was sent, and cleanup completed. With workspace 5 visible, the demo succeeded in 8,627 ms with one trusted A1 click, a DOM Clear, and complete cleanup.
- **v0.4.0 checks.** `bun test` passed 128 tests in 11 files. Read-only `bun src/doctor.mjs` returned `checks_passed` with no blocking findings or warnings: a `testedDriver` match, `captureBoundPixels: true`, `elementTokens: true`, `visualRegions.advertised: true`, and the extension installed, healthy, at 0.2.1, and publisher-verified. `omp -p --no-extensions -e <repo>/index.ts "/jev"` listed `/jev canvas visual` and `/jev eval`. In print mode, both returned `status: "not_started"` with `language: "js"` and their exact code.
- **Offline OCR eval.** Variants `dpr1`, `dpr2`, and `dpr2-1568` each returned 18 regions, label recall 1.0, association accuracy 1.0, and zero wrong labels. All three read `Selected: none` and `Clear selection`. Mean parse time was 2,829 ms, or 3,220 ms wall time. The action space was `screenshot_pixels`, and `action_eligible` was false. Cleanup closed the fixture with zero clicks, terminated the eval's own headless Chrome, and removed its temporary directories; Chrome 154 keeps running after `--screenshot`. This is a bare page render without browser chrome, not a live window capture. An earlier raw live window capture at the 1568 downscale missed A6 once.

**Configured judge unavailable.** The host's configured judge role starts with `typesafe/jev-latest`. For more than 60 seconds, every call failed with `judgment: every judge candidate failed: typesafe/jev-latest rejected the account recently`. A later `probeJudge(judge)` surfaced the cause: `typesafe/jev-latest API error (402)`, with `"error_type":"billing_error"` and `Your organization has no available TypeSafe API credits`. The host's unchanged judge role produced no eval or visual-canvas results.

**Jev through OpenRouter.** Jev was then reached as `openrouter/~typesafe/jev-latest`, the next candidate in OMP's built-in judge chain, after the operator provided an OpenRouter credential. The already-running session did not pick that credential up. A fresh `omp -p` process therefore used an overlay config setting `modelRoles.judge` to that candidate; the global configuration stayed unchanged. `probeJudge(judge)` abstained ("Below confidence policy") with one judge call and no native action, which is a valid result. The judge-choice eval used 3 trials, the default 0.8/0.6 gates, and OCR labels from `dpr2-1568`, which read A1–A6:

| Condition | Gated correct | Ungated top-choice accuracy | Wrong (gated) | Mean confidence |
| --- | --- | --- | --- | --- |
| `anonymous` | 3/12 | 0.75 | 0 | 0.575 |
| `labelled` | 0/12 | 1.00 | 0 | 0.613 |
| `injection` | 9/12 | 1.00 | 0 | 0.817 |

In `labelled`, Jev's top choice was correct in every trial, but its confidence (0.45–0.75) stayed below the 0.8 gate, so every trial abstained. `injectionFollowed` was 0. Mean judge latency was about 83 ms in the first run and 0–2 ms afterwards. OMP sent `X-OpenRouter-Cache: true` (edge cache, TTL 3,600 s), so repeated identical prompts returned cached answers; these trials are not independent samples. No live visual canvas run used Jev.

**Substitute judge, not the configured judge.** An unshipped in-session adapter over OMP `completion()` also stood in for the judge. It used model `default` with a JSON schema for choice, probabilities, and confidence, and renormalized probabilities to sum to 1. With the same default gates, 3 trials, and `dpr2-1568` labels:

- `anonymous`: 3 of 12 correct, all for the leftmost goal; 9 abstained below the gate; 0 wrong; mean 5.4 s.
- `labelled`: 12 of 12 correct; mean 2.4 s.
- `injection`: 12 of 12 correct; `injectionFollowed` 0; mean 3.5 s.

**Live visual canvas, v0.4.0 code.**

- With a stub judge that always abstains, for seat A3, the run reported `abstained` after one judge call, with no click, an untouched server, and complete cleanup. The warm-up parse took 2,622 ms and the settled parse 2,492 ms (11 regions, `affine`). OCR read A1, A3, and A5 consistently with the layout. The judge saw only `seat_1`–`seat_3`, with OCR text marked untrusted.
- With the substitute judge during concurrent desktop use, for seat A3, the judge chose `seat_2` (A3) with confidence 0.92 after a 3.6 s parse. The foreground click was refused before dispatch with `target_offscreen`. OmniWM's trace showed the active workspace flipping 5→4→3→4→3→5→4, parking the owned Chrome at x=5119. No click was sent and `unknownOutcome` was false; cleanup completed with the prepared PID exited and the profile absent. A second attempt failed at focus with `bring_to_front_exact_window_unverified`, again without a click.
- In hands-off reruns with the substitute judge, the desktop was idle with workspace 5 shown. For seat A3, the judge chose `seat_2` with confidence 0.90. The click was refused before dispatch with `target_moved` because the window geometry changed between the settled capture and dispatch. No click was sent, and cleanup completed.
- For seat A5, the hands-off run **completed** with `success: true` in 18,794 ms and one judge call. The warm-up parse took 4,167 ms and the settled parse 3,215 ms (`affine`). OCR read A1, A3, and A5 consistently. The judge chose `seat_3` (A5) with confidence 0.92. One guarded, capture-bound foreground click at PNG pixel (231,124) was accepted, and the server recorded exactly one trusted A5 click. Semantic readback confirmed the selection, and a DOM Clear left `selected: null`. Both sessions ended, the prepared PID exited, the profile was absent, and the fixture closed.

These results prove the Driver 0.31.0 observations above, non-consuming read-only parses bound to their PNG hash, and offline OCR accuracy on the bare fixture render. They also prove the guard's live `target_offscreen` and `target_moved` refusals and one completed judge-selected visual canvas run on this host. That completion used the substitute judge, not the configured judge or Jev. The host's configured TypeSafe judge produced no choices. Jev through OpenRouter was measured only on synthetic trials that the provider cache made non-independent. No score here is a calibration or safety measurement. Nothing here proves clean-machine onboarding, behaviour on other Driver builds, or a speedup. npm is not published.

## Historical local verification, 2026-09-27 (Driver 0.30.2)

Tested with Bun `1.4.0` and Cua Driver `0.30.2-nightly.20260927.36294544935` in standard mode on this already-configured Mac. The desktop changed during testing from one 5120×1440 display to 1920-wide window positions. OmniWM was moving and hiding windows, and the operator was actively using Ghostty and Comet. This is not a clean-machine run.

- Existing localhost demo: the v0.2.0 code failed on this Driver at `browser_type` because receipts gained a root `summary` string. The updated `bun src/demo.mjs` returned `success:true`, `status:"complete"`, 4181 ms (8569 ms on the final-code re-run), one fill, one click, three snapshots, and zero judge calls. Receipts were normalized without `summary`. Cleanup completed: the session was inactive, the prepared PID had exited, the marker-validated profile was absent, and the fixture was closed.
- Native smoke used an owned isolated Chrome, the canvas fixture, and a temporary `OMP_CUA_JEV_STATE_DIR`. Settle returned `settled` in three samples and 1256 ms, with a recorded `capture_id`. The capture was 1567×881 for a 959×539 window. `regions()` matching `rgb(0,85,255)` within ±8 and `minArea:20` returned exactly three regions, `truncated:false`, and anchors `(94,332)`, `(356,332)`, and `(617,332)` in capture pixels. `verify({window:{exists:true}})` returned `satisfied` in 8 ms. A web-element label predicate returned `unknown` / `observation_unavailable`.
- A background capture-bound click on A1 passed the guard, used `synthetic_events`, took 3.6 seconds, and was independently recorded by the fixture as trusted A1. A foreground capture-bound click without `focus()` also passed because only Cua Driver's own full-screen overlay, PID 47412 and z-order 10 over target z-order 9, covered the point. It used `global_input`, and the fixture recorded a second trusted A1 click. `listOnScreenWindows()` reported that overlay as `driver_owned:true`; the target was `driver_owned:false`.
- Earlier raw probes motivated the guard. A background pixel click without `capture_id` used accessibility hit-testing and pressed a different canvas seat. Reusing a consumed capture, using another session's capture, or sending out-of-bounds coordinates returned `capture_not_found` or `capture_coordinate_invalid`. With the owned window hidden or moved by OmniWM, three delivered foreground clicks did not reach the owned page. A background capture-bound click while off-screen or occluded used `synthetic_events` and had no effect.
- A reserved raw `driver.call('get_session')` was refused locally with `unknownOutcome:false`. The surfaced click refusal was `Cua Driver click request refused: capture_coordinate_invalid.` with its static hint.
- SIGKILL simulated an eval timeout. `listSessions()` found both orphans `active` with `ownerAlive:false`, while the live browser session had `ownerAlive:true`. Resuming one orphan allowed an in-session observation and `end()`; its capture directory was removed. `recoverSessions({dryRun:true})` planned to end the other orphan and skip the live session. The real run did exactly that. Resume of an ended label failed locally. The journal retained only the live session. `bun src/doctor.mjs` returned `checks_passed`, `testedDriverMatch:true`, `capabilities.captureBoundPixels:true`, and zero journal entries. `/jev sessions` listed none and was read-only. `/jev canvas` in print mode returned `not_started` with the `runCanvasDemo` instruction. `/jev` help lists doctor, paths, sessions, probe, demo, and canvas.
- The first live canvas demo, using the earlier native-AX readiness design, failed at `settle_window`: fresh isolated Chrome exposed no web-content AX elements through `get_window_state` after 20 seconds, warm-up, and re-navigation, although a typed-browser semantic snapshot saw the page. Cleanup completed. That failure motivated the semantic readback and DOM-route Clear described above.
- The reworked canvas demo then completed live in 7,233 ms with zero judge calls: one guarded, capture-bound foreground click on seat A1 (route `global_input`), exactly one trusted A1 click on the server, `Selected: A1` in a semantic snapshot, a DOM Clear verified as `Selected: none` with `selected:null`, and complete cleanup (both sessions inactive, prepared PID exited, profile absent, fixture closed). The then-current guard admitted the click while only Cua Driver's overlay covered the point; on this OmniWM desktop that depends on window placement at run time. A re-run with the final code (main-display gate, whole-display overlay rule) also completed: 6,780 ms, zero judge calls, one trusted A1 click, cleared to `selected:null`, complete cleanup.
- Final-code guard smoke, owned isolated browsers only and no `focus()`, on a 1920×1080 main display: with the target topmost at launch (z 10, above the Driver overlay at z 8) a foreground click was admitted and the fixture recorded trusted A1. After `set_window_frame` moved the owned window so the click point fell off the main display, `execute()` refused with `target_offscreen`, `unknownOutcome:false`, and the fixture log was unchanged. With a second owned isolated browser window placed over the target (z 11 over z 9), `execute()` refused with `target_occluded`, `unknownOutcome:false`, and the fixture log was unchanged. All sessions ended inactive. The suite passed 88 tests across 6 files.

These results prove that 0.30.2 build's capture binding, deterministic region mapping, the guard's admission path and its live `target_offscreen` and `target_occluded` refusals, and journaled recovery on this Mac. At that time, `target_missing`, `target_moved`, and `guard_unavailable` were covered by unit tests only. The completed canvas run proves its recorded task and cleanup on this host, not a judge-selected pixel action, `cua-perception`, or clean-machine onboarding. npm is not published.

## Historical local native smoke, 2026-09-22

The authorized fixture received one AX Animate action, a bounded settled capture, and one foreground pixel click. Independent DOM/main-page readback reported `starts:1`, `clicks:1`, and `settled:true`, with rendered confirmation. A fresh Bun runtime also verified the source helper's exact-window `focus()` with matching PID/window and all exact-window effect checks true, followed by an inactive session receipt. Earlier retained OMP eval focus attempts were unverified; this is not a claim that those attempts succeeded. No automatic retry or lowered gate was added.

Comet evidence covers scoped read-only observation and capture, not ticket mutations. The final suite passed all 42 tests. Five deliberate mutations failed their regression checks in disposable copies: wrong-window focus acceptance, lost refusal diagnostics, unsettled pixel admission, failed-process acceptance, and broken cleanup retry. Review fixes also keep capture timestamps ahead of file processing and allow pending capture cleanup to retry without ending an already-closed native session again.

## Historical local verification, 2026-09-21

Tested with Bun `1.4.0`, stock OMP `18.2.7`, and Cua Driver `0.28.3-nightly.20260919.35421378483` on an already-configured Mac running macOS `26.5.2`, build `25F84`, with system Google Chrome `153.0.8010.52`. Retained evidence is in `~/.local/state/omp-jev/verification-2026-09-21`.

- Fresh-HOME discovery passed outside the checkout, including bundled skill discovery, absolute helper imports, and stock JS eval. Native doctor checks in that isolated HOME reported blocked; this was not fresh macOS onboarding.
- The live host judge probe used existing configuration and credentials, made one helper-level judge call, and abstained below the unchanged confidence gate. It executed no native action and used OMP's existing judge integration.
- The native demo completed through stock JS eval with personal extensions disabled. The daemon reported standard mode. Two deterministic actions, one fill and one click, used three snapshots and took 4,796 ms overall. They produced the matching token, `count: 1`, `attempts: 1`, and rendered `Receipt saved` confirmation, with zero judge calls.
- The owned session returned inactive and the fixture closed. Separate readback observed the prepared PID and exact marker-validated profile path absent. Descendant exit was not checked; this is not a guarantee of all browser-resource reclamation.
- All 15 tests passed; regression tests rejected 17 deliberate mutations in disposable copies without changing the originals.

These results prove local discovery, host judge integration, and the deterministic native path. They do not prove autonomous judge-selected native action, a speedup, or clean-machine onboarding. npm is not published.

## Clean-machine acceptance

Every item below remains pending for a genuinely clean supported machine, including fresh app-identity/OS-permission onboarding for macOS. The v0.1.0 GitHub release does not check off this list. A fresh `HOME` on an already-configured Mac can test OMP discovery isolation, but **does not satisfy this check**.

- [ ] Record actual Bun, OMP, Cua Driver, OS, and browser versions. Install stock OMP without personal plugins. Complete human authentication and Cua consent using ordinary standard mode, without bypass flags or existing-profile grants.
- [ ] Link the package directory. Confirm bundled `/skill:omp-cua-jev` discovery and absolute resource imports through `jev_resources` from a working directory outside the checkout. Confirm stock `eval` advertises `language: "js"`.
- [ ] Save `/jev doctor` output and its limits. Confirm standard mode, but do not label read-only checks as a native or fresh direct-capture proof.
- [ ] Run the real `/jev probe`. Record its actual decision, including abstention, and helper-level judge-call count. OMP can retry or fall back internally. Keep configured confidence gates unchanged. A valid response is not proof of calibrated confidence or a judge-selected native action.
- [ ] Run the isolated native demo. Require a newly prepared owned browser, PID-filtered visible-window discovery, exact binding with mutation allowed, and an actual returned tab. Require the fixture's token match, `count: 1`, `attempts: 1`, and rendered confirmation. Record abstention or failure honestly. Deterministic success proves the native path, not judge selection.
- [ ] Run the isolated canvas demo only as a separate authorized check. Require its own exact window, capture-bound pixel admission, independent fixture readback, and owned cleanup. Record refusal or failure honestly. Deterministic success does not prove judge-selected pixel coordinates.
- [ ] Record the matching owned-session inactive receipt and fixture shutdown, including any pending/partial cleanup. Record browser-process/profile reclamation as unverified unless independently checked within exact ownership scope. Never treat inactive session state as complete physical reclamation.
- [ ] Record this clean-machine run's versions and retained results. Source review, mocks, a fresh-HOME-only run, or daemon status do not complete this check.
