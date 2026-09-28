# omp-cua-jev

Use OMP's configured `judge` to choose from a local action table, then execute and verify authorized actions through Cua Driver. The plugin supplies diagnostics, absolute helper paths, a bundled skill, and isolated localhost demos. It does not install a model client or keep separate credentials.

**Version: v0.3.0.** Includes capture-bound pixels, deterministic region enumeration, and journaled session recovery. Tested against Cua Driver `0.30.2-nightly.20260927.36294544935` only; no compatibility claim is made for any other build. Local results are recorded below. Clean-machine onboarding is still open. There is no npm package.

## Requirements

- Bun **1.3.14 or later** and OMP **18.2.7 or later**. `/jev doctor` compares the advertised host version with this minimum. Package-manager metadata does not enforce the OMP requirement.
- Active stock JavaScript `eval`, with `language: "js"`, and a working OMP model/auth configuration.
- Cua Driver and a logged-in graphical desktop. On macOS, use macOS 14 or later. The typed-browser demo specifically requires supported system-installed Google Chrome in `/Applications`; a cached test browser, Safari, or Firefox is not a substitute. The native-window helper instead requires a separately supported, explicitly authorized exact native app/window. It does not promise support for every browser or remove permission requirements.

The native implementation was tested against Cua Driver `0.30.2-nightly.20260927.36294544935`. That exact build is not a tested minimum, and the local verification below is not a compatibility claim for any other build.

## Set up the host

1. Install Bun, then follow [OMP's official installation instructions](https://github.com/can1357/oh-my-pi/blob/v18.2.7/README.md#install). One supported route is:

   ```sh
   bun install -g @oh-my-pi/pi-coding-agent
   ```

2. Start `omp`. Use `/login` for your provider and `/model` to select a working chat model. In `/model`'s Roles view, review the judge role and its fallback rows. The plugin reuses `modelRoles.judge`, `retry.fallbackChains.judge`, and the host's existing credentials and routing. Do not overwrite a working setup just for this plugin. For a TypeSafe judge, OMP supports `/login typesafe`; a configured text-model fallback is also possible. See [provider authentication](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/providers.md#oauth-vs-api-key-and-provider-scoped-logins) and [role/fallback settings](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/settings.md#models).

3. Keep stock JS eval enabled. `eval.js` defaults to `true`; `PI_JS=0` disables it. If you deliberately disabled it, review that choice before changing it. No alternate eval plugin is required or installed. See [stock eval](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/tools/eval.md).

4. Install the pinned Git tag. Quote it so the shell does not eat the `#`:

   ```sh
   omp plugin install 'github:ericjuta/omp-cua-jev#v0.3.0'
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
| `/jev sessions` | Lists journaled sessions directly, without eval. It sends one read-only `get_session` per journaled label, so it is not offline, and never contacts labels absent from the journal. |
| `bun src/doctor.mjs` | From this checkout, prints read-only JSON diagnostics without OMP host metadata. Blocking prerequisites produce exit code 1. |
| `bun src/demo.mjs` | From this checkout, runs the native localhost demo deterministically without a model. It performs real isolated-browser mutations, not a mock or judge proof. |
| `bun src/canvas-demo.mjs` | From this checkout, runs the isolated canvas demo deterministically without a model. It performs real isolated-browser mutations and briefly foregrounds its owned window. |

Interactively, probe, demo, and canvas hand an exact eval instruction to the main model. They are **model-mediated**, not direct command-to-eval dispatch. Wait for the actual result; command acceptance is not completion. In print and JSON modes, they return `status: "not_started"` with the eval instruction without starting it. Print mode emits the details as JSON; JSON mode wraps them in `{ "type": "jev", "details": ... }`. Paths, doctor, and sessions use the same output formats.

Doctor invokes Cua `--version`, `status`, `permissions status --json`, and read-only `describe click`. It checks whether that click schema declares `capture_id` and counts valid journal entries on disk, without asking the daemon whether those sessions are live. The inspected Driver emits plain text for `status --json`; do not assume all status output is JSON. Doctor's `checks_passed` means read-only prerequisites passed. `native.testedDriver` records the exact tested build; a different installed build is a warning, not proof that this package works with it. Host version/eval metadata does not prove credentials or a live judge. Permission status can report grants without performing a fresh direct capture, and historical capture evidence is not a new probe. A listening daemon or successful permission-status query does not prove browser delivery, task completion, cleanup, or a standard-mode run. OMP's separate `omp plugin doctor` checks plugin installation, not these capabilities.

## Use the helpers in stock eval

Call `jev_resources` with `{"action":"paths"}`. Its result contains `paths.loop`, `paths.driver`, `paths.native`, `paths.pixels`, `paths.sessions`, `paths.demo`, `paths.canvasDemo`, `paths.probe`, and `paths.skill`. Read `paths.skill` and each helper's instructions/source before importing it, including `paths.native` for native-window work. Bind the returned `paths` object in the retained JS cell, then import the actual absolute filesystem paths:

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

Pixel clicks use the current settled observation's `local.screenshot.capture_id`. The helper always sends that binding; a caller-supplied copy must match. Driver consumes it on dispatch, so it cannot be reused, and a binding from another session is not valid here. Take a fresh `settle()` in this same session before every pixel click. Screenshot `x`/`y` are PNG pixels and are sent unchanged. Do not multiply them by `scale` or derive them from AX frames.

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

`regions()` re-hashes the owned capture and returns capture pixels. It does not invalidate the observation or authorize a click. `anchor` is the region pixel nearest the rounded centroid. Use it only with that same observation. Enumerate a closed, task-owned colour and geometry rule; do not ask `judge` to invent pixel coordinates. The optional `cua-perception` extension and its `parse_visual_regions` tool are neither installed nor required.

For a separately authorized foreground pixel click, construct with `foreground:true` and call `focus()` **before** the `settle()` that produced the observation and anchor above. Focus after settling invalidates that evidence: settle and enumerate again before acting. The candidate must also declare `delivery_mode:"foreground"`:

```js
await nativeTarget.execute({
  action: { tool: 'click', args: { x: anchor.x, y: anchor.y, delivery_mode: 'foreground' } },
}, settled.observation);
```

Before dispatch, the guard reads the exact-PID window list. It refuses, without sending a click, when the target is missing (`target_missing`) or its bounds differ by more than one point (`target_moved`). That is the whole background check: it does not prove the window is visible or unoccluded, and background delivery is unverified. Foreground mode additionally calls read-only `screenSize()` and maps each capture pixel to a screen point from **both** the captured and current bounds (never screenshot scale). Both points must fall inside the main display's `[0,width) × [0,height)` rectangle, or it refuses `target_offscreen`; a window may extend beyond that rectangle if both points are in bounds. It then reads the on-screen list: the exact target must appear, and any other window covering either point at equal or unknown `z_index` causes `target_occluded`. Only a `driver_owned:true` window covering the **whole main display**, such as Cua Driver's full-screen click-through overlay, is exempt. Driver-owned approval cards, even if they cover the target, and unknown ownership still occlude. Failed pre-dispatch guard reads yield `guard_unavailable`, retaining only safe `tool`/`refusalCode` diagnostics. All these local refusals have `unknownOutcome:false` and dispatch no click. A matching background route is `synthetic_events`; foreground is `global_input`. Neither route proves the application effect. A failed post-dispatch window read yields `guard_unavailable_after_dispatch` with `unknownOutcome:true`; do not replay without independent readback.

Never call raw `driver.call('click', {x, y})` for pixels. Without the capture binding, an accessibility route can hit-test a different element, including the centre of a canvas rather than the requested point. If a pixel receipt returns `route:"accessibility"`, treat the outcome as unknown and stop. Do not replay it before independent readback.

`runCanvasDemo({ judge, onProgress, binary, seat })` owns an isolated browser session and a second, foreground-enabled native session for the exact returned window. `seat` is optional and defaults to the leftmost available seat. Readiness and readback use the browser session's `get_browser_state` `semantic_v2` snapshot for the exact fixture URL: `Selected: none`, then `Selected: <seat>`, plus a unique Clear ref. The native session only focuses, settles, enumerates fixture-coloured regions, and sends one capture-bound foreground pixel click through `runBounded`. There is no native AX readback. After the fixture server and semantic status confirm the selection, one `browser_click` with that ref and `input_route:"dom_event"` clears it, followed by another readback. Results are `complete`, `cleanup_incomplete`, `refused` (guard refused before dispatch, with `reason`), or `failed`. Never retry a refusal automatically. `bun src/canvas-demo.mjs` runs the same demo without a model. Its final live result is recorded separately below.

## Recover after an eval timeout

Keep each native operation in a short cell. A long cell can hit OMP's 30-second eval timeout, discard the JS state, and leave the helper session active. For `/jev demo` or `/jev canvas`, pass an explicit eval timeout of at least 180 seconds so cleanup is not interrupted. Acceptance of that instruction is not proof that cleanup finished.

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
- Native refusals now surface as `Cua Driver <tool> request refused: <code>.` only for an allowlisted code, with validated `error.tool` and a static hint when available. Driver-side refusals keep `unknownOutcome:true`; only local refusals, meaning guard reasons, reserved `call()` tools, the busy guard, and `resume()` without a journal entry, report `unknownOutcome:false`. Read back before any new attempt. The allowlist includes `capture_not_found`, `capture_expired`, `capture_stale`, `capture_generation_mismatch`, `capture_target_mismatch`, `capture_coordinate_invalid`, `capture_binding_failed`, `capture_failed`, `capture_id_invalid`, `capture_frame_mismatch`, `capture_disabled`, `capture_publication_failed`, `desktop_scope_disabled`, `screenshot_context_missing`, `zoom_context_missing`, `window_id_not_found`, `window_owner_pid_mismatch`, `window_not_found`, `ax_window_unresolved`, `element_not_found`, `element_not_found_on_click`, `element_outside_target_window`, `snapshot_id_required`, `element_index_required`, `same_pid_keyboard_ambiguity`, `background_unavailable`, `foreground_unavailable`, `permissions_pending`, `permission_required`, and `session_not_started`. The message never includes native output. `permissions_pending` or exit 75 needs the human TCC flow; do not bypass it.
- A fresh isolated Chrome can expose no web-content AX elements through `get_window_state`, even after navigation and waiting. That absence does not prove the page is absent: a typed-browser semantic snapshot may still see it. Do not treat missing AX as authorization to change route or click pixels blindly.
- `verify({expect})` returns `satisfied` only when the native status and every requested predicate are literally satisfied. Web-content element predicates never satisfy by design; expect status `unknown`, with the reason passed through when it is a native code (`observation_unavailable` in local testing). Window predicates such as `{window:{exists:true}}` are the supported deterministic checks. Never read `unknown` as false or as permission to act.
- `parse_visual_regions` may be advertised by Driver, but it needs the optional `cua-perception` extension. This package does not install that extension. Use `nativeTarget.regions()` for the local deterministic enumeration instead.
- Explicit `screenshot_out_file` and `debug_image_out` paths canonicalize their existing parent, including the macOS `/tmp` alias. This creates no directories, changes no permissions, and rejects symlink or non-file leaves. Use task-owned output locations. Existing regular files remain subject to native policy; preflight is not atomic no-clobber protection.
- The demo queries `receipt`. Collection completeness alone is insufficient: require no continuation, matching selected/total/ref counts, and visible main-frame evidence for every match. Hidden, occluded, budget-omitted, or unprovable-frame evidence blocks action. Document-wide `unknown` or `offscreen` counters alone need not invalidate a fully covered, visible query. Never infer a missing control from an incomplete query.
- A complete collection can still fail `SEMANTIC_SNAPSHOT_INCOMPLETE` when a required control is `near_viewport`. The bundled fixture uses a compact, left-aligned single-column layout to keep its controls and confirmation visible in smaller viewports. Keep the `in_viewport` requirement; native window dimensions do not establish the CSS viewport dimensions.

## Local verification, 2026-09-27

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

These results prove the tested Driver's capture binding, deterministic region mapping, the guard's admission path and its live `target_offscreen` and `target_occluded` refusals, and journaled recovery on this Mac. `target_missing`, `target_moved`, and `guard_unavailable` are covered by unit tests only. The completed canvas run proves its recorded task and cleanup on this host, not a judge-selected pixel action, `cua-perception`, or clean-machine onboarding. npm is not published.

## Local native smoke, 2026-09-22

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
