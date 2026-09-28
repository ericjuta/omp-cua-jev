# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are published as Git tags and are not on npm.

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

[0.3.0]: https://github.com/ericjuta/omp-cua-jev/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ericjuta/omp-cua-jev/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ericjuta/omp-cua-jev/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ericjuta/omp-cua-jev/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ericjuta/omp-cua-jev/releases/tag/v0.1.0
