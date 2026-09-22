# omp-cua-jev

Use OMP's configured `judge` to choose from a local action table, then execute and verify authorized actions through Cua Driver. The plugin supplies diagnostics, absolute helper paths, a bundled skill, and an isolated localhost demo. It does not install a model client or keep separate credentials.

**Status: v0.1.1 on GitHub.** Local stock-host, judge, and native demo results are recorded below. Clean-machine onboarding is still open. There is no npm package.

## Requirements

- Bun **1.3.14 or later** and OMP **18.2.7 or later**. `/jev doctor` compares the advertised host version with this minimum. Package-manager metadata does not enforce the OMP requirement.
- Active stock JavaScript `eval`, with `language: "js"`, and a working OMP model/auth configuration.
- Cua Driver, a logged-in graphical desktop, and a supported system-installed Chromium browser. On macOS, use macOS 14 or later and Google Chrome in `/Applications`. A cached test browser, Safari, or Firefox is not a substitute for this typed-browser demo.

The native implementation uses the schema contract inspected in Cua Driver `0.28.3-nightly.20260919.35421378483`. The local verification below is not a tested minimum or a compatibility claim for other builds.

## Set up the host

1. Install Bun, then follow [OMP's official installation instructions](https://github.com/can1357/oh-my-pi/blob/v18.2.7/README.md#install). One supported route is:

   ```sh
   bun install -g @oh-my-pi/pi-coding-agent
   ```

2. Start `omp`. Use `/login` for your provider and `/model` to select a working chat model. In `/model`'s Roles view, review the judge role and its fallback rows. The plugin reuses `modelRoles.judge`, `retry.fallbackChains.judge`, and the host's existing credentials and routing. Do not overwrite a working setup just for this plugin. For a TypeSafe judge, OMP supports `/login typesafe`; a configured text-model fallback is also possible. See [provider authentication](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/providers.md#oauth-vs-api-key-and-provider-scoped-logins) and [role/fallback settings](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/settings.md#models).

3. Keep stock JS eval enabled. `eval.js` defaults to `true`; `PI_JS=0` disables it. If you deliberately disabled it, review that choice before changing it. No alternate eval plugin is required or installed. See [stock eval](https://github.com/can1357/oh-my-pi/blob/v18.2.7/docs/tools/eval.md).

4. Install the pinned Git tag. Quote it so the shell does not eat the `#`:

   ```sh
   omp plugin install 'github:ericjuta/omp-cua-jev#v0.1.1'
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
| `bun src/doctor.mjs` | From this checkout, prints read-only JSON diagnostics without OMP host metadata. Blocking prerequisites produce exit code 1. |
| `bun src/demo.mjs` | From this checkout, runs the native localhost demo deterministically without a model. It performs real isolated-browser mutations, not a mock or judge proof. |

Interactively, probe and demo hand an exact eval instruction to the main model. They are **model-mediated**, not direct command-to-eval dispatch. Wait for the actual result; command acceptance is not completion. In print and JSON modes, they return `status: "not_started"` with the eval instruction without starting it. Print mode emits the details as JSON; JSON mode wraps them in `{ "type": "jev", "details": ... }`. Paths and doctor use the same output formats.

Doctor invokes only Cua `--version`, `status`, and `permissions status --json`. The inspected Driver emits plain text for `status --json`; do not assume all status output is JSON. Doctor's `checks_passed` means read-only prerequisites passed. Host version/eval metadata does not prove credentials or a live judge. Permission status can report grants without performing a fresh direct capture, and historical capture evidence is not a new probe. A listening daemon or successful permission-status query does not prove browser delivery, task completion, cleanup, or a standard-mode run. OMP's separate `omp plugin doctor` checks plugin installation, not these capabilities.

## Use the helpers in stock eval

Call `jev_resources` with `{"action":"paths"}`. Its result contains `paths.loop`, `paths.driver`, `paths.demo`, `paths.probe`, and `paths.skill`. Read the returned skill path. Bind the returned `paths` object in the retained JS cell, then import the actual absolute filesystem paths:

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

## Troubleshooting native evidence

- Normalized `browser_type` and `browser_click` receipts need not contain `status`, target, or tab fields. The tested typing receipt uses `route: "trusted_input"` and a `delivery.delivered_count` matching the requested text. The demo's `dom_event` click returns `route: "dom"` and `escalation: { target: "page", reason: "effect_unconfirmed" }`. Both report background delivery and `effect: "unverifiable"`. The adapter validates these request-specific shapes; independent readback proves completion. Do not replay a mutation because its receipt lacks an expected wrapper.
- Discover windows with `list_windows` using only the returned `prepared_pid` and `on_screen_only: true`, without a session argument. Require one visible window, exact binding, and an actual returned tab. Hidden helper windows are not targets; multiple visible windows remain ambiguous.
- The demo queries `receipt`. Collection completeness alone is insufficient: require no continuation, matching selected/total/ref counts, and visible main-frame evidence for every match. Hidden, occluded, budget-omitted, or unprovable-frame evidence blocks action. Document-wide `unknown` or `offscreen` counters alone need not invalidate a fully covered, visible query. Never infer a missing control from an incomplete query.

## Local verification, 2026-09-21

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
- [ ] Record the matching owned-session inactive receipt and fixture shutdown, including any pending/partial cleanup. Record browser-process/profile reclamation as unverified unless independently checked within exact ownership scope. Never treat inactive session state as complete physical reclamation.
- [ ] Record this clean-machine run's versions and retained results. Source review, mocks, a fresh-HOME-only run, or daemon status do not complete this check.
