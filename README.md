# opencode-peak-badge

[![GitHub Tag](https://img.shields.io/github/v/tag/hugobatista/opencode-peak-badge?logo=github&label=latest)](https://github.com/hugobatista/opencode-peak-badge/releases)
[![Lint](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-peak-badge/lint.yml?label=Lint)](https://github.com/hugobatista/opencode-peak-badge/actions/workflows/lint.yml)
[![Test](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-peak-badge/test.yml?label=Test)](https://github.com/hugobatista/opencode-peak-badge/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/opencode-peak-badge.svg)](https://www.npmjs.com/package/opencode-peak-badge)

OpenCode TUI plugin. Shows a `[PEAK]` / `[OFF-PEAK]` badge next to the model
name in the prompt bar, so you always know whether the active model is billed
at peak rates. When a subagent session is running, its model is tracked too:
peak wins across the main model and all busy subagents. Updates live — no
restart needed when a session crosses a peak window boundary.

![Demo](docs/demo-peak.png)

## What it does

- Renders a badge in `session_prompt_right` and `home_prompt_right` (both
  slots) whenever a model with configured peak hours is active — or always,
  with `alwaysShow: true`.
- `[PEAK]` renders in the theme's warning color. `[OFF-PEAK]` renders in the
  muted color. The badge shows in **both** states for tracked models.
- Recomputes every `pollSeconds` (default 30) and on every model switch.
- Tracks all descendant subagent sessions through their `parentID` chain.
  While a subagent session is busy, its model is checked against the peak
  windows. Peak wins: if any busy subagent is in peak hours, the badge shows
  `[PEAK]`. Disable with `subagents: false`.
- Resolves the active model at session start from `session.created` /
  `session.updated` events, with a `session.get` fallback, so the badge shows
  before the first prompt. On the home screen (no session yet) it uses the
  last-used model from OpenCode's `model.json` and watches that file, so the
  badge updates immediately when you pick a model, instead of waiting for the
  next poll tick.
- Shows nothing for models without configured peak hours, unless
  `alwaysShow: true` forces the badge for the main model from the top-level
  `windows` / `weekdaysOnly`.
- Provider-agnostic: track any model that has peak pricing by adding a rule
  under `models`. Built-in defaults cover the DeepSeek V4 family, which is
  where peak hours are known today.

## Requirements

- OpenCode TUI >= 1.14 (TUI plugin support).
- [Bun](https://bun.sh) to install dependencies (dev only).

## Install

```sh
opencode plugin opencode-peak-badge --global
```

Or add the package name to `~/.config/opencode/tui.json`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-peak-badge"]
}
```

Restart OpenCode. Config is loaded at startup; there is no hot reload.

Verify. Start a session with a tracked model (for example
`opencode-go/deepseek-v4-flash`) and confirm the badge appears next to the
model name in the prompt bar. To force a known state, see
[Evaluation](#evaluation).

### Install from source (local dev)

1. Clone the repository and install dependencies:

   ```sh
   git clone https://github.com/hugobatista/opencode-peak-badge.git ~/code/projects/opencode-peak-badge
   cd ~/code/projects/opencode-peak-badge
   bun install
   ```

2. Register the plugin in `~/.config/opencode/tui.json` with an absolute
   path to `src/index.tsx`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": [
       "/home/your-user/code/projects/opencode-peak-badge/src/index.tsx"
     ]
   }
   ```

   The defaults below apply when no options are given. To override, use the
   tuple form (see [Configuration](#configuration)).

3. Restart OpenCode. Config is loaded at startup; there is no hot reload.

## Configuration

Add options as the second element of a tuple entry:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "/home/your-user/code/projects/opencode-peak-badge/src/index.tsx",
      {
        "models": [
          "re:^opencode-go/deepseek-(v4-)?(flash|pro)(-vision-exp)?$",
          "re:^opencode/deepseek-(v4-)?(flash|pro)(-vision-exp)?$",
          "re:^deepseek/deepseek-(v4-)?(flash|pro)(-vision-exp)?$"
        ],
        "windows": [["01:00", "04:00"], ["06:00", "10:00"]],
        "weekdaysOnly": true,
        "pollSeconds": 30,
        "subagents": true,
        "alwaysShow": false,
        "labelPeak": "[PEAK]",
        "labelOffPeak": "[OFF-PEAK]"
      }
    ]
  ]
}
```

### Options

| Option | Default | Description |
|---|---|---|
| `models` | built-in patterns for the DeepSeek V4 family (OpenCode Go, OpenCode Zen, DeepSeek direct) | Models with peak hours. Override to track any `provider/model`. Each entry is a `"provider/model"` exact string, a `"re:<pattern>"` regex string, or an object with per-model `windows`/`weekdaysOnly` overrides. Matching is against the full `provider/model` key (case-insensitive). Exact `id` entries win over regex patterns; otherwise the first matching entry in list order wins. |
| `windows` | `[["01:00","04:00"],["06:00","10:00"]]` | Peak windows in UTC. Each is `["HH:MM","HH:MM"]`, half-open `[start, end)`. A window whose end is ≤ its start wraps past midnight. |
| `weekdaysOnly` | `true` | When true, weekends are always off-peak. |
| `pollSeconds` | `30` | How often the badge recomputes (minimum 1). |
| `subagents` | `true` | Track subagent sessions while they are busy. Peak wins over the main model's state. |
| `alwaysShow` | `false` | When true, always show a badge for the main model, using the top-level `windows`/`weekdaysOnly` when no model rule matches. |
| `labelPeak` | `"[PEAK]"` | Text shown during peak hours. |
| `labelOffPeak` | `"[OFF-PEAK]"` | Text shown during off-peak hours. |

`models` entries are additive to the defaults? No. Supplying `models`
**replaces** the default list. Provide the full list you want tracked.

### Subagents

When an OpenCode task spawns a subagent session, that child session carries a
`parentID` pointing at the session that spawned it. The plugin registers child
sessions from `session.created` / `session.updated` and tracks the child's
model. Tracing the `parentID` chain, all **descendant** sessions of the current
one participate — a subagent's own subagents count too. While a session is
`busy`, its model enters the badge computation:

- If any busy subagent has a matching rule and is in peak hours, the badge
  shows `[PEAK]`, whatever the main model says (`peak` wins).
- Otherwise the badge follows the main model's state.
- Idle or deleted subagent sessions are ignored.
- Subagent sessions whose model has no configured peak hours add nothing.
- `session.status` events refresh the badge immediately when a subagent goes
  busy or idle; no need to wait for the next poll tick.

`alwaysShow` only affects the main model; a subagent never renders a badge from
the fallback windows. Set `subagents: false` to ignore subagents entirely.

### alwaysShow

By default the plugin shows nothing for models without a matching rule. Set
`alwaysShow: true` to always render a badge in the prompt bar: unmatched main
models use the top-level `windows` / `weekdaysOnly` (defaults or your
overrides). Combined with `subagents`, a busy subagent in peak hours still wins
over an off-peak main model.

## Background: peak pricing is property of channel + model

Peak hours are a property of the **channel + model pair**, not of the model
alone. The plugin is provider-agnostic: it renders a badge whenever the active
`provider/model` key matches a configured rule, and prices are billable at peak
in the channels you configure. Add any model you care about — the plugin does
not know or care which provider it belongs to.

The built-in defaults target the DeepSeek V4 family, because that is where
peak pricing is known today. Current facts (per OpenCode docs):

- **OpenCode Go** — DeepSeek V4 Pro, V4 Flash and V4 Flash Vision Exp: peak =
  Mon–Fri 01:00–04:00 and 06:00–10:00 UTC; everything else, including weekends,
  is off-peak (2× price in peak). No other Go model has peak hours. OpenCode
  also exposes Flash as the alias `opencode-go/deepseek-flash`; the default
  pattern matches both spellings.
- **OpenCode Zen** — bills the same DeepSeek V4 models (`opencode/deepseek-v4-*`)
  at DeepSeek's list price, so the same peak windows apply.
- **DeepSeek direct API (BYOK)** — the same peak windows apply to
  `deepseek/deepseek-v4-*`.

In Lisbon time (WEST, UTC+1) the DeepSeek windows are 02:00–05:00 and
07:00–11:00; in winter (WET, UTC+0) the UTC windows apply as-is. The plugin
computes in UTC, so DST is a non-issue.

### Exact matching

Match one `provider/model` id exactly (case-insensitive). This is the simplest
form and avoids regex entirely:

```jsonc
{
  "models": [
    "opencode-go/deepseek-v4-flash",
    "opencode/deepseek-v4-pro"
  ]
}
```

Give a single model its own windows or weekday behavior with the object form:

```jsonc
{
  "models": [
    { "id": "opencode-go/deepseek-v4-flash", "windows": [["09:00", "17:00"]], "weekdaysOnly": false }
  ]
}
```

### Regex matching

Exact ids match one model. To track every current and future model id that
fits a pattern, use the `re:` prefix on a string, or the `pattern` object form
(which also allows per-model overrides):

```jsonc
{
  "models": [
    "re:^opencode-go/deepseek",
    { "pattern": "^my-provider/.*$", "windows": [["09:00", "17:00"]] }
  ]
}
```

Matching rules:

- Patterns are compiled case-insensitively and tested against the full
  `provider/model` key.
- An exact `id` entry always beats a regex pattern, regardless of list order.
- Otherwise the first matching entry wins (list order).
- An invalid or empty pattern is ignored.

Escaping: `models` is JSON, so backslashes must be doubled. For example, to
match a literal dot use `"re:^opencode-go/deepseek\\.v4"`. To avoid escaping,
prefer plain `-` and `?` characters as in the defaults above.

## Evaluation

Set the environment variable before launching OpenCode to force a specific
instant. The variable is read on every tick, so changing it mid-session takes
effect within `pollSeconds`:

```sh
OPENCODE_PEAK_HOURS_FAKE_TIME=2026-09-07T08:30:00Z opencode   # peak (Mon 08:30 UTC)
OPENCODE_PEAK_HOURS_FAKE_TIME=2026-09-07T12:00:00Z opencode   # off-peak (Mon 12:00 UTC)
```

Unset the variable to use real time.

## Uninstall

Remove the plugin entry from `plugin` in `~/.config/opencode/tui.json` and
restart OpenCode.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit, strict
bun test            # unit (core logic) + functional (mocked TUI api)
bun run build       # dist/tui.js + dist/tui.d.ts (npm entrypoint)
```

- `src/core.ts` — pure logic: window parsing, UTC peak check, per-model config
  resolution. No TUI imports. Fully unit-tested.
- `src/index.tsx` — the TUI plugin (`id: "peak-badge"`). The plugin loader
  reads the default export only; the `__test` named export is a test hook.
- `scripts/build.ts` — bundles `src/index.tsx` to `dist/tui.js` with
  `@opencode-ai/plugin`, `@opentui/*` and `solid-js` external. The npm
  `exports["./tui"]` entry points at `dist`, never at `src` (the Solid
  transform does not run inside `node_modules`).

## Pre-release checklist

```sh
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

Inspect the pack list (`dist/`, `README.md`, `LICENSE` only). Scan for
secrets before `npm publish`.

## License

MIT — see [LICENSE](./LICENSE). Author: Hugo Batista
(<https://github.com/hugobatista>).
