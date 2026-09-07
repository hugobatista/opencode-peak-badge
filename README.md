# opencode-peak-badge

OpenCode TUI plugin. Shows a `[PEAK]` / `[OFF-PEAK]` badge next to the model
name in the prompt bar, so you always know whether the active model is billed
at peak rates. Updates live — no restart needed when a session crosses a peak
window boundary.

## What it does

- Renders a badge in `session_prompt_right` and `home_prompt_right` (both
  slots) whenever the active model has configured peak hours.
- `[PEAK]` renders in the theme's warning color. `[OFF-PEAK]` renders in the
  muted color. The badge shows in **both** states for tracked models.
- Recomputes every `pollSeconds` (default 30) and on every model switch.
- Shows nothing for models without peak hours (for example `glm-5.3-flash`).

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
          "opencode-go/deepseek-v4-flash",
          "opencode-go/deepseek-v4-pro",
          "opencode-go/deepseek-v4-flash-vision-exp"
        ],
        "windows": [["01:00", "04:00"], ["06:00", "10:00"]],
        "weekdaysOnly": true,
        "pollSeconds": 30,
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
| `models` | the 3 DeepSeek V4 models on `opencode-go` | Active models with peak hours. Each entry is a `"provider/model"` string (inherits `windows`/`weekdaysOnly`) or an object `{ id, windows?, weekdaysOnly? }` for per-model overrides. Matching is exact `provider/model` (case-insensitive). |
| `windows` | `[["01:00","04:00"],["06:00","10:00"]]` | Peak windows in UTC. Each is `["HH:MM","HH:MM"]`, half-open `[start, end)`. A window whose end is ≤ its start wraps past midnight. |
| `weekdaysOnly` | `true` | When true, weekends are always off-peak. |
| `pollSeconds` | `30` | How often the badge recomputes (minimum 1). |
| `labelPeak` | `"[PEAK]"` | Text shown during peak hours. |
| `labelOffPeak` | `"[OFF-PEAK]"` | Text shown during off-peak hours. |

`models` entries are additive to the defaults? No. Supplying `models`
**replaces** the default list. Provide the full list you want tracked.

## Background: why per-model peak hours

Peak hours are a property of the **channel + model pair**, not of the model
alone. They come from DeepSeek's upstream pricing and exist on OpenCode Go but
not on OpenCode Zen (which bills a flat blended rate). Matching is therefore by
exact `provider/model` id, so a model used via a flat-priced channel never shows
a false badge.

Current facts (per OpenCode docs):

- **OpenCode Go** — DeepSeek V4 Pro, V4 Flash and V4 Flash Vision Exp: peak =
  Mon–Fri 01:00–04:00 and 06:00–10:00 UTC; everything else, including weekends,
  is off-peak (2× price in peak). No other Go model has peak hours.
- **OpenCode Zen** — flat blended rate. No peak hours.
- **DeepSeek direct API (BYOK)** — the same peak windows apply to
  `deepseek/deepseek-v4-*`.
- **GLM** — has peak hours (14:00–18:00 UTC+8) only on z.ai's own GLM Coding
  Plan, not via OpenCode channels.

In Lisbon time (WEST, UTC+1) the DeepSeek windows are 02:00–05:00 and
07:00–11:00; in winter (WET, UTC+0) the UTC windows apply as-is. The plugin
computes in UTC, so DST is a non-issue.

### Adding a model later

Add an entry with its own windows. It overrides the shared `windows` default:

```jsonc
{
  "models": [
    "opencode-go/deepseek-v4-flash",
    { "id": "provider/new-model", "windows": [["09:00", "17:00"]] }
  ]
}
```

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
