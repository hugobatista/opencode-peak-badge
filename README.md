# opencode-peak-badge

[![GitHub Tag](https://img.shields.io/github/v/tag/hugobatista/opencode-peak-badge?logo=github&label=latest)](https://go.hugobatista.com/gh/opencode-peak-badge/releases)
[![Lint](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-peak-badge/lint.yml?label=Lint)](https://go.hugobatista.com/gh/opencode-peak-badge/actions/workflows/lint.yml)
[![Test](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-peak-badge/test.yml?label=Test)](https://go.hugobatista.com/gh/opencode-peak-badge/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/opencode-peak-badge.svg)](https://www.npmjs.com/package/opencode-peak-badge)

`[PEAK]` / `[OFF-PEAK]` badge for OpenCode TUI and OpenCode Desktop. It follows
the active model's configured peak-hour rules; running subagents are included and
peak wins. Updates live, including when a session crosses a boundary.

![Demo](docs/demo-peak.png)

## Features

- TUI: footer badge for the session (`prompt.footer.status`) and Home
  (`home.footer.status`).
- Desktop: header chip for the session (`session.header`) and status strip on
  Home (`window.bottom`).
- Provider-agnostic; built-in rules cover DeepSeek models.
- Tracks running subagent sessions; if any is peak, the parent shows `[PEAK]`.
- Configurable models, UTC windows, labels, polling and fallback (`alwaysShow`).

## Requirements

- **OpenCode V2.**
- **OpenCode Desktop 2.4 or newer** for the desktop UI. The GUI plugin API is
  experimental; this release targets 2.4.2.
- **Bun** for development.

## Install

```sh
opencode plugin add opencode-peak-badge
```

This writes the package to the global `opencode.json(c)`, which both the TUI and
Desktop read.

Manual alternative:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-peak-badge"]
}
```

To pass options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-peak-badge", "options": { "pollSeconds": 30 } }
  ]
}
```

**TUI-only:** add the package to `~/.config/opencode/cli.json`:

```jsonc
{
  "plugins": ["opencode-peak-badge"]
}
```

Desktop reads only `opencode.json(c)`, not `cli.json`. Use one
`opencode.json(c)` entry for both, and remove duplicates from `cli.json`.

OpenCode reloads plugins when config changes; `/reload` forces a full reload. A
package update may need a client restart (Desktop loads the GUI bundle from the
installed package).

Verify with a tracked model (for example `opencode-go/deepseek-v4-flash`): the TUI
footer badge, or the Desktop header chip. To force a state, see
[Evaluation](#evaluation).

### Desktop surfaces

- **Session:** `session.header` chip next to the context indicator. The active
  timeline uses `composer.model()`; a cached hidden timeline uses the committed
  model. Compact headers show the icon only, with the full label as tooltip. The
  exact order relative to native header actions is host-controlled; `order` only
  sorts plugin contributions.
- **Home / draft:** `window.bottom` strip shown while no session is routed. It
  uses `client.model.default()`; it may lag behind the Home picker until a session
  starts.
- The parent session chip aggregates running subagents. A subagent's own header
  follows that subagent's model.
- Settings → Extensions → Plugins can disable the GUI.

### OpenCode V1 (legacy)

`0.3.0` is the last V1-compatible release; npm `latest` is V2. Pin it:

```sh
opencode plugin opencode-peak-badge@opencode-v1 --global
```

Or in `~/.config/opencode/tui.json`:

```jsonc
{ "plugin": ["opencode-peak-badge@opencode-v1"] }
```

## Configuration

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-peak-badge",
      "options": {
        "models": [
          "re:^opencode-go/deepseek",
          "re:^opencode/deepseek",
          "re:^deepseek/deepseek"
        ],
        "windows": [["01:00", "04:00"], ["06:00", "10:00"]],
        "weekdaysOnly": true,
        "pollSeconds": 10
      }
    }
  ]
}
```

### Options

| Option | Default | Description |
|---|---|---|
| `models` | DeepSeek patterns | Rules to track. Replaces the defaults. Strings are exact `provider/model` or `re:<regex>`; objects add per-model `windows`/`weekdaysOnly`. |
| `windows` | `[["01:00","04:00"],["06:00","10:00"]]` | Peak windows in UTC. Each is `["HH:MM","HH:MM"]`, half-open; end ≤ start wraps midnight. |
| `weekdaysOnly` | `true` | Weekends are always off-peak. |
| `pollSeconds` | `10` | Recompute interval (minimum 1). Live events also trigger updates. |
| `fakeTime` | unset | Fixed ISO timestamp for testing. Overrides `OPENCODE_PEAK_HOURS_FAKE_TIME` in the TUI and works in Desktop. |
| `subagents` | `true` | Include running subagent sessions; peak wins. |
| `alwaysShow` | `false` | Show the main model even without a matching rule, using the top-level windows. |
| `labelPeak` | `"[PEAK]"` | Peak label. |
| `labelOffPeak` | `"[OFF-PEAK]"` | Off-peak label. |
| `debug` | `false` | Append the detected `provider/model` to the badge. |

`models` **replaces** the default list; provide every model you want tracked.

### Model matching

- Exact `provider/model`, case-insensitive.
- `re:<pattern>` regex, case-insensitive.
- Object form for per-model overrides: `{ "id": "provider/model", "windows": [...], "weekdaysOnly": false }`, or the same with `pattern` instead of `id`.
- Exact entries beat regex patterns; otherwise the first match wins. Invalid
  patterns are ignored.
- JSON escapes backslashes: use `"re:^opencode-go/deepseek\\.v4"`.

```jsonc
"models": [
  "opencode-go/deepseek-v4-flash",
  "re:^opencode/deepseek",
  { "pattern": "^my-provider/.*$", "windows": [["09:00", "17:00"]], "weekdaysOnly": false }
]
```

## Behavior

- **TUI model source:** committed session model, plus the uncommitted picker
  selection from `$XDG_STATE_HOME/opencode/model.json`. A committed model wins;
  Home uses the pick, then `client.model.default()`.
- **Subagents:** running descendants from `data.session.family()`; peak wins.
  `subagents: false` ignores them; `alwaysShow` only affects the main model.
- **Peak hours:** UTC defaults are Mon–Fri 01:00–04:00 and 06:00–10:00, weekends
  off-peak. Defaults cover DeepSeek on OpenCode Go, OpenCode Zen and the DeepSeek
  direct API; add rules for any other provider/model.
- **TUI agent cycle:** the Tab agent cycle may not update until the next prompt;
  selecting a model explicitly updates immediately.

## Evaluation

TUI, before launching:

```sh
OPENCODE_PEAK_HOURS_FAKE_TIME=2026-09-07T08:30:00Z opencode   # peak
OPENCODE_PEAK_HOURS_FAKE_TIME=2026-09-07T12:00:00Z opencode   # off-peak
```

Desktop uses the `fakeTime` option, because the Electron renderer may not receive
the environment variable:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-peak-badge",
      "options": { "fakeTime": "2026-09-07T08:30:00Z" }
    }
  ]
}
```

`fakeTime` overrides the TUI environment variable. Remove it to use real time.

## Uninstall

```sh
opencode plugin remove opencode-peak-badge
```

Or remove the entry from `opencode.jsonc` / `cli.json`. Desktop only reads
`opencode.json(c)`.

## Development

```sh
bun install
bun run typecheck   # TUI + GUI TypeScript configs
bun test            # core + mocked TUI tests
bun run build       # dist/tui.js, dist/server.js, dist/gui-experimental.cjs
```

Local development: build, add the absolute repository directory to
`opencode.json(c)`, then reload. A local directory with `name` and `exports`
resolves `./tui`, `.` (server) and `./gui-experimental`; Desktop needs
`dist/gui-experimental.cjs`. For TUI-only development, point at `src/index.tsx`
instead.

- `src/core.ts` — pure rules, badge/subagent resolution and the fake-time clock.
- `src/index.tsx` — TUI part (`id: peak-badge`).
- `src/gui.tsx` — Desktop part (`session.header` chip + `window.bottom`).
- `src/server.ts` — identity-only server part; gives the GUI the `peak-badge` id.
- `scripts/build.ts` — TUI and server bundles; `vite.config.ts` — GUI CJS bundle.

Release check: `npm pack --dry-run`. The package must include `dist/tui.js`,
`dist/server.js` and `dist/gui-experimental.cjs`; scan for secrets before
publishing.

## License

MIT — see [LICENSE](./LICENSE). Author: Hugo Batista
(<https://github.com/hugobatista>).
