// Build the npm TUI entrypoint: dist/tui.js + dist/tui.d.ts.
// Host-provided modules stay external so the plugin uses the host runtime.
import solidPlugin from "@opentui/solid/bun-plugin";
import { rename } from "node:fs/promises";

const js = await Bun.build({
  entrypoints: ["src/index.tsx"],
  outdir: "dist",
  naming: "tui.js",
  target: "bun",
  format: "esm",
  sourcemap: "external",
  // Compiles JSX away via babel-preset-solid. Without this, bun emits a
  // jsx-dev-runtime import that has no runtime behind it inside node_modules.
  plugins: [solidPlugin],
  external: ["@opencode-ai/plugin", "@opentui/core", "@opentui/solid", "solid-js"],
});

for (const log of js.logs) {
  if (log.level === "error") {
    console.error(log.message);
    process.exit(1);
  }
}
if (!js.success) {
  console.error("bun build failed");
  process.exit(1);
}

const proc = Bun.spawnSync(["tsc", "-p", "tsconfig.build.json"], { stdio: ["ignore", "inherit", "inherit"] });
if (proc.exitCode !== 0) {
  console.error("tsc declarations failed");
  process.exit(1);
}

// tsc emits index.d.ts from src/index.tsx; the export map expects tui.d.ts.
await rename("dist/index.d.ts", "dist/tui.d.ts");

console.log("built dist/tui.js + dist/tui.d.ts");
