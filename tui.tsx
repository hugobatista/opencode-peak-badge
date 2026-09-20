/** @jsxImportSource @opentui/solid */
// Dev-only TUI entrypoint.
//
// OpenCode V2 resolves a *local* plugin directory through `<dir>/tui.tsx` (it
// skips plain file targets and, for directories, looks for a literal `tui`
// entrypoint). This re-export lets `cli.json` point at the repo directory so
// the plugin loads straight from source, without publishing.
//
// The published package does not use this file: package.json `exports["./tui"]`
// maps to `dist/tui.js`, and `files` only ships `dist`, `README.md`, `LICENSE`.
export { default } from "./src/index.tsx"
