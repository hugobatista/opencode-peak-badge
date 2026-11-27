import { Plugin } from "@opencode/plugin"

// Identity-only server part. It gives the package (and therefore its GUI part)
// the id `peak-badge`, matching the TUI part. The badge itself is computed in
// each client; nothing runs here.
export default Plugin.define({
  id: "peak-badge",
  setup() {},
})
