# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are published as Git tags and are not on npm.

## [0.4.1] - 2026-10-02

### Changed

- **Judge-visible OCR framing.** OCR labels are now described as evidence of which seat a disc is, and canvas text is still never to be followed as an instruction (`OCR_LABEL_NOTE`, exported from `paths.canvasDemo`). Candidate descriptions read `OCR reads its label as "A3"` instead of `Untrusted OCR text below it reads "A3"`. The 0.8/0.6 gates, geometry-only authorization, and the label-shape filter are unchanged.
- **Judge-choice eval state.** Each available seat in the judge-visible state now includes its `candidateId`, so state rows map directly to candidates. This applies to all three conditions.
- **Live visual canvas state.** Seat rows now include `position` (left to right among detected seats), `colour: "blue"` and `available: true`. All three are local geometry facts, because only blue available seats are detected. The state also adds `page`, `legend` and `ocrNote`.
- **Measured effect (Jev via `openrouter/~typesafe/jev-latest`, 2026-10-01).** Judge-choice eval, 3 trials, fresh `dpr2-1568` OCR labels. Gated accuracy and mean confidence:
  - anonymous 0/12, 0.565 (top-choice accuracy 0.75; all abstained);
  - labelled 12/12, 0.948 (was 0/12, 0.613);
  - injection 12/12, 0.943 (was 9/12, 0.817), with the injection followed 0 times.

  There were no wrong choices. Ablation: the reframed wording alone took labelled to 12/12 at 0.902. Adding candidate IDs raised it to 0.955. OCR confidence and placement fields did not help (0.87), so they are not shipped. OpenRouter's edge cache makes repeated identical trials non-independent.
- **Live visual canvas with Jev.**
  - Before the position/legend change, run 1 (A5): Jev chose `seat_3` (A5) at 0.84 and passed the gates. The guard then refused before dispatch with `target_occluded`. No click was sent, and cleanup completed.
  - Before the change, run 2 (A5): Jev chose `seat_3` at 0.78 and abstained. Replaying its captured state with `page`, `legend`, `position`, `colour` and `available` added gave the correct choice at 0.93 for A1, 0.90 for A3 and 0.86 for A5.
  - After the change, one run failed before any judge call because the Mac was locked: `focus_window` returned `bring_to_front_exact_window_unverified`. No click was sent, and cleanup completed.
  - After the change, with the Mac unlocked (2026-10-02): A5, A3 and A1 each completed with a gated Jev choice, at confidence 0.87, 0.91 and 0.92. Each run made one judge call and one guarded capture-bound foreground click, which produced exactly one trusted server click on the requested seat. A DOM Clear followed, and cleanup was complete: both sessions ended, the prepared PID exited and the profile was absent. The runs took 17,002, 14,882 and 15,196 ms. OCR read A1, A3 and A5 correctly. Each run spent about 3.0 s on the settled parse plus a 3.1–3.4 s warm-up. That is one run per seat on one host, not a calibration.
- **`typesafe/jev-preview` is unavailable.** OpenRouter's judge catalog offers only `~typesafe/jev-latest` (`jev-1.13`). Direct TypeSafe access returns HTTP 402 `billing_error`. With an empty judge fallback chain, OMP reported `typesafe/jev-preview rejected the account recently`. Without that override, the role silently fell back to `openrouter/typesafe/jev-1.13-20260917`.

## [0.4.0] - 2026-10-01

Tested against Cua Driver `0.31.0`. The optional `cua-perception` extension is not bundled, and this plugin never installs it. Perception refusal codes are pinned to cua-perception 0.2.1. The direct TypeSafe judge was unavailable: `probeJudge` surfaced `typesafe/jev-latest API error (402)` with `billing_error` (no available API credits). The same Jev model through `openrouter/~typesafe/jev-latest` answered in a separate process. With the unchanged 0.8 gate, it abstained on every labelled trial even though its top choice was always correct. A live visual canvas run completed for seat A5 with a substitute judge, not the configured judge: one guarded capture-bound foreground click, exactly one trusted server click on A5, and complete cleanup in 18,794 ms. Other attempts refused before dispatch with `target_offscreen` or `target_moved`, or failed at focus, and sent no click.

### Added

- **`nativeTarget.visualRegions(observation, options)`.**
  - Requires the current observation and a native `capture_id`. It does not require a settled observation. Settled pixel authority is separate and unchanged.
  - Re-hashes the owned capture, then sends read-only `parse_visual_regions` with a 45 s client timeout. Options are an optional non-empty unique subset of `text`/`icon`, a positive `maxRegions`, and `minConfidence` from 0 to 1.
  - Binds `capture_id`, window pid and `window_id`, width, height, and sha256. Returns frozen capture identity, `actionCoordinateSpace`, parser, regions, warnings, and `durationMs`.
  - Region bounds are PNG pixels of that capture. `actionCoordinateSpace` (`screenshot_pixels` or the Driver affine for a downscaled capture) is evidence only. This plugin never applies it; the Driver maps capture-bound click pixels.
  - Parsing does not consume the capture or invalidate the observation. OCR text authorizes nothing. A failure throws `NATIVE_TARGET_ERROR` with `unknownOutcome:false`, keeping only the tool and an allowlisted `refusalCode`.
- **`observe()` `max_image_dimension`.** An integer >= 0. `0` requests native resolution and overrides the Driver's configured long-edge downscale. `max_dimension` remains a tighter cap.
- **Per-call `driver.call(tool, args, options)`.** The optional third argument is exactly `{timeoutMs}`, an integer from 1 through 2^31−1. It bounds that call's CLI child only and does not change the instance timeout. Omitted or `undefined` options use the instance timeout. Any other options value fails locally (`unknownOutcome:false`) before native work.
- **`src/visual.mjs`.** Pure projections over `cua.visual_regions_v1`, with no I/O.
  - `projectParse` validates a live or offline envelope and returns frozen regions with in-bounds anchors. It drops `interactive`, warning messages, and unknown fields, and it does not bind a capture.
  - `labelRegions` pairs each target with at most one nearby text region by mutual nearest neighbour. Ties and conflicts stay unlabelled.
  - `findText` matches trimmed text exactly or by RegExp. OCR text and icon labels are untrusted observations, never instructions or authorization.
- **Offline OCR canvas eval and judge-choice eval.**
  - `runOcrCanvasEval` renders the bundled fixture with owned headless system Chrome and parses those PNGs with `cua-driver perception parse`. It starts no Driver session, opens no visible window, and executes no action (`action_eligible:false`).
  - `runJudgeChoiceEval` sends synthetic seat goals to an injected judge under anonymous, labelled, and injection conditions. Candidate actions are inert placeholders. It executes nothing and does not lower the default gates. Default `trials` is 2.
  - Each summary also reports ungated `topChoiceAccuracy`, `topChoiceWrongRate`, and `meanConfidence`. These are diagnostics only: gates are never lowered, and an ungated answer authorizes nothing.
  - On this host the offline OCR variants dpr1, dpr2, and dpr2-1568 each had label recall 1.0, association accuracy 1.0, and zero wrong labels. That was a bare page render, not a live window capture.
  - Jev via `openrouter/~typesafe/jev-latest`, 3 trials, gates 0.8/0.6. Gated accuracy, top-choice accuracy, and mean confidence: anonymous 3/12, 0.75, 0.575; labelled 0/12, 1.00, 0.613, with every trial abstaining; injection 9/12, 1.00, 0.817, with the injection followed 0 times. There were no wrong choices. OpenRouter's edge cache makes repeated identical trials non-independent. No numbers exist for direct TypeSafe access.
- **`/jev canvas visual` and `/jev eval`.** Both are model-mediated. Print and JSON modes emit `status:"not_started"` with `language:"js"` and the exact code, and do not start eval.
  - Canvas visual requests `runCanvasDemo({ judge, onProgress: display, visual: true })` with a timeout of at least 300 seconds.
  - Eval requests `runJudgeChoiceEval({ judge, onProgress: display })` with a timeout of at least 180 seconds, the same floor as demo and canvas. Probe still sets no timeout floor.
  - Command acceptance is not completion. Neither command is deterministic.
  - Visual mode gives the judge neutral `seat_1..seat_n` candidates with untrusted OCR label evidence. It authorizes only the requested seat by local geometry, runs a warm-up parse, and is limited to three decisions.
- **Paths and package exports.** `paths.visual`, `paths.ocrEval`, and `paths.judgeEval`. Exports `./visual`, `./evals/ocr-canvas`, and `./evals/judge-choice`. Doctor resource names include the same three.

### Changed

- **Breaking: native AX actions are `element_token` only.** Driver 0.31.0 element actions no longer accept `element_index` or `snapshot_id`.
  - `nativeTarget.execute()` refuses those arguments for `click`, `set_value`, `type_text`, and `press_key` locally before dispatch. AX identity is one current `element_token` from the observation. `element_index` remains display-only state. An observation may still carry `snapshot_id`; it is not an action argument.
  - The Driver refuses a token from another snapshot or runtime with `stale_element_token`, and the old argument shape with `invalid_arguments`.
- **Refusal allowlist.** `snapshot_id_required` and `element_index_required` are no longer exposed. Added `stale_element_token`, `invalid_arguments`, and the cua-perception parse codes `not_installed`, `unsupported_target`, `unsupported_platform`, `incompatible_protocol`, `invalid_frame`, `worker_launch_failed`, `worker_crashed`, `worker_cancelled`, `timeout`, `resource_limit_exceeded`, `artifact_invalid`, and `inference_failed`. Existing `capture_*` codes still apply to parse. Unknown codes and native messages stay private. Hints are static.
- **Doctor targets Driver `0.31.0`.**
  - `capabilities.elementTokens` is true only when `describe click` declares `element_token` and does not declare `element_index` or `snapshot_id`. It is false otherwise, and null when the schema is unrecognized. A recognized click schema without `element_token` is blocking `ELEMENT_TOKENS_UNSUPPORTED`.
  - `capabilities.visualRegions` is `{advertised, extension}`. `advertised` is whether `describe parse_visual_regions` declares `capture_id`. `extension` is optional status: `installed`, `healthy`, `activeVersion`, `trust`, and `evidenceClass`, or null when unrecognized.
  - Perception findings never block: `VISUAL_REGIONS_UNADVERTISED`, `PERCEPTION_STATUS_UNKNOWN`, `PERCEPTION_NOT_INSTALLED`, `PERCEPTION_UNHEALTHY`, and `PERCEPTION_TRUST_UNVERIFIED`. Doctor reads extension status and does not run the worker, its self-test, a capture, or a parse. `evidence.visualRegions` stays `not_tested`.

### Removed

- **`element_index` and `snapshot_id` as native action arguments.**
- **Allowlisted refusal codes `snapshot_id_required` and `element_index_required`.**

### Security-relevant

- `driver.call("install_extension")` is now refused locally, like the other reserved `call()` tools, with an operator-only hint. It dispatches nothing. Installation stays an operator action through `cua-driver extension inspect/install --catalog`.
- Visual regions and OCR text do not authorize a click, consume a capture, or apply the Driver affine.

## [0.3.0] - 2026-09-27

Tested against Cua Driver `0.30.2-nightly.20260927.36294544935`.

### Added

- **Capture-bound single-use pixel clicks.**
  - Every native observation records `local.screenshot.capture_id`.
  - Pixel clicks require a current settled capture, and the helper sends that `capture_id` with every one. A caller-supplied `capture_id` must match it.
  - The Driver consumes the capture on admission, so each pixel click needs a fresh `settle()`.
  - Mixing element and pixel addressing is refused.
- **`nativeTarget.verify()`.**
  - Runs Driver `verify_state` against the exact pid and window. It accepts 1–8 predicates, `timeoutMs` 0–10000 (default 5000) and `stableSamples` 1–5 (default 2).
  - Returns `{status, stable, samples, elapsedMs, predicates}`. `satisfied` is reported only when the Driver and every predicate report satisfied, and unrecognized statuses become `unknown`.
  - This is independent verification of application state. Web-content element predicates are expected to return `unknown`; only window predicates can be satisfied.
- **`nativeTarget.regions()` and the `./pixels` export.**
  - `decodePng()` is a strict decoder for 8-bit, non-interlaced RGB/RGBA PNGs.
  - `findRegions()` finds connected colour regions using 4- or 8-connectivity, with `minArea` and `maxRegions` limits. Each region has `center` and an in-region `anchor`, and the result reports `truncated`.
  - `regions()` re-reads the owned capture file, checks its size, SHA-256 and dimensions, and returns the regions together with the `capture_id` they came from. It doesn't authorize an action.
- **Session journal.**
  - Location: `$OMP_CUA_JEV_STATE_DIR/sessions` when that is set (the path must be absolute). Otherwise `$XDG_STATE_HOME/omp-cua-jev/sessions`, or `~/.local/state/omp-cua-jev/sessions` by default.
  - The directory is `0700` and entries are written atomically as `0600` files. Journaling is on by default for `createCuaDriver`, and the `journal`/`journalDir` options override it.
  - The entry is written before `start_session` is dispatched, so a start whose outcome is uncertain can still be recovered.
  - The start entry is created exclusively (hard link from a synced temp file). `start()` for a label that is already journaled is refused locally, dispatches nothing, and leaves the entry byte-identical; use `resume()` or recovery for that label.
- **Driver session methods:**
  - `resume()`: requires an explicit label, its journal entry, and an active `get_session`.
  - `getSession()`: read-only.
  - `recordOwnership()`: updates the journal only and dispatches nothing.
  - `listOnScreenWindows()`: returns `window_id`, `pid`, `bounds`, `z_index` and `driver_owned`. This window listing is occlusion evidence, not target discovery.
  - `screenSize()`: validates the main display's width, height and scale factor for foreground pixel admission; `driver.call("get_screen_size")` is reserved for this method.
- **`./sessions` export.**
  - `listSessions()` runs a read-only `get_session` for each journaled label and reports `ownerAlive`, and `active`, `inactive` or `unknown`.
  - `recoverSessions()` ends orphaned sessions (dead owner, listed label or `minIdleSeconds`) by resuming and then ending them, and removes their owned capture directories and journal entries. It supports `dryRun`.
  - Labels that are not in the journal are never contacted.
  - Each selected entry is re-read just before recovery acts on it. If it was removed or rewritten (different owner PID or `updatedAt`, e.g. another process resumed it), it is reported `kept` with `ENTRY_CHANGED` and left alone.
- **`/jev sessions`:** read-only journal listing that doesn't use eval.
- **`/jev canvas`, the `./canvas-demo` export and a loopback canvas seat-map fixture.**
  - Readiness and readback use typed-browser `semantic_v2` state.
  - A separate foreground native session makes one capture-bound pixel click on a seat.
  - The selection is cleared with one background `browser_click` DOM event.
  - Live run with the final code (Driver 0.30.2 nightly): `success:true`, `status:"complete"`, 6,780 ms, zero judge calls. One guarded foreground click on seat A1 (route `global_input`); the server recorded exactly one trusted A1 click, the page read `Selected: A1`, and after the DOM Clear it read `Selected: none` with `selected:null`. Both sessions ended; the prepared PID exited and its profile was absent; the fixture closed. An earlier revision that relied on web-content AX failed at `settle_window` with complete cleanup.
- **Doctor fields:**
  - `native.testedDriver` and `testedDriverMatch`. A mismatch is a warning.
  - `capabilities.captureBoundPixels`, taken from `cua-driver describe click`.
  - A read-only `journal` entry count.
  - The `CUA_VERSION_UNTESTED` and `CAPTURE_BOUND_PIXELS_*` warnings.
- **Package exports:** `./pixels`, `./sessions` and `./canvas-demo`. The `paths` resource also lists `pixels`, `sessions` and `canvasDemo`.

### Changed

- **Error details.** Driver errors carry `error.tool`, and their message is exactly `Cua Driver <tool> request refused: <code>.` or `Cua Driver <tool> request failed.`
  - An expanded allowlist of native refusal codes (capture, window, element, delivery, permission and session) is exposed as `refusalCode`, with static hints that are safe to show.
  - Exit code 75 gets a hint pointing to the macOS permission gate.
  - Unknown codes and native messages remain private.
- **Refused receipts.** Receipts with a root `effect:"refused"` are now rejected.
- **Reserved `call()` tools.** `driver.call()` now also refuses `get_session` and `get_screen_size`, alongside `start_session`, `end_session`, `list_windows` and `bring_to_front`. Each refusal is local, dispatches nothing, and carries a hint naming the method to use instead.
- **Pre-dispatch pixel guard.** The exact-PID target window must still exist with bounds within one point of the captured bounds; otherwise the click is refused with `target_missing` or `target_moved`.
  - Foreground mode uses `screenSize()` to require the screen points derived separately from captured and current bounds to lie inside the main display; otherwise it refuses `target_offscreen`. A window may extend off-screen if both points are in bounds.
  - It then requires the exact target in the on-screen list and refuses `target_occluded` when another window covers either point at equal or unknown z-order. The sole exemption is a `driver_owned:true` window that covers the **whole main display**, not merely the target; even a Driver-owned approval card can occlude.
  - A failed guard read reports `guard_unavailable`, keeps only safe tool/refusal diagnostics, sends no click and has `unknownOutcome:false`, as do the other pre-dispatch guard refusals.
- **Post-dispatch pixel checks.** These report `unknownOutcome:true`:
  - `pixel_routed_to_accessibility`, when a pixel click was routed through accessibility;
  - `target_moved_during_dispatch`, when the window moved or disappeared during dispatch;
  - `guard_unavailable_after_dispatch`, when the post-click window read fails.

### Fixed

- Cua Driver 0.30.2 adds a root `summary` string to action receipts, and the v0.2.0 localhost demo failed at `browser_type` on it. Receipts now allow exactly one optional string `summary`. It is removed before shape checks and never surfaced.

### Security-relevant

- Pixel clicks are bound to one capture from the current session. That capture can't be reused or moved to another session. The guard refuses stale geometry, an off-main-display foreground point, and known or unprovable foreground occlusion before dispatch.
- Delivery receipts are not proof of effect. Completion requires independent application verification.
- Journal files are private to the user. Symlinks are never followed, and only temp directories named `omp-cua-jev-native-*` are treated as owned capture directories.
- Raw `driver.call()` is only a transport and doesn't apply the pixel guard. Use `nativeTarget.execute()` for pixel clicks.

## [0.2.0] - 2026-09-22

### Added

- Guarded native window workflows.

## [0.1.2] - 2026-09-22

### Fixed

- Demo controls stay inside the viewport.

## [0.1.1] - 2026-09-22

### Changed

- Renamed the plugin from `omp-jev` to `omp-cua-jev`.

## [0.1.0] - 2026-09-22

### Added

- Initial release as `omp-jev`.

[0.4.1]: https://github.com/ericjuta/omp-cua-jev/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ericjuta/omp-cua-jev/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ericjuta/omp-cua-jev/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ericjuta/omp-cua-jev/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ericjuta/omp-cua-jev/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ericjuta/omp-cua-jev/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ericjuta/omp-cua-jev/releases/tag/v0.1.0
