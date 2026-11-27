import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({
  plugins: [gui()],
  // `bun run build:tui` writes dist/tui.js and dist/server.js first. Vite must
  // not empty dist when it writes the GUI bundle.
  build: { emptyOutDir: false },
})
