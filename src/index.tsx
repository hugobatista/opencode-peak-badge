/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import {
  badgeFor,
  modelKey,
  resolveRules,
  type PeakHoursOptions,
  type ResolvedModelRule,
} from "./core"

type ModelRef = { providerID: string; modelID: string }

function currentNow(): Date {
  const fake = process.env.OPENCODE_PEAK_HOURS_FAKE_TIME
  if (fake) {
    const parsed = new Date(fake)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options: PeakHoursOptions = (rawOptions ?? {}) as PeakHoursOptions
  const rules: Map<string, ResolvedModelRule> = resolveRules(options)
  const labels = {
    peak: options.labelPeak ?? "[PEAK]",
    offPeak: options.labelOffPeak ?? "[OFF-PEAK]",
  }
  const pollSeconds = Math.max(1, options.pollSeconds ?? 30)

  const [tick, setTick] = createSignal(currentNow().getTime())
  const [version, setVersion] = createSignal(0)
  const tracked = new Map<string, ModelRef>()

  api.event.on("session.next.model.switched", (event) => {
    const { sessionID, model } = event.properties
    tracked.set(sessionID, { providerID: model.providerID, modelID: model.id })
    setVersion((value) => value + 1)
  })

  api.event.on("session.deleted", (event) => {
    if (tracked.delete(event.properties.info.id)) setVersion((value) => value + 1)
  })

  const timer = setInterval(() => setTick(currentNow().getTime()), pollSeconds * 1000)
  api.lifecycle.onDispose(() => clearInterval(timer))

  function lookupRule(sessionID: string | undefined): ResolvedModelRule | undefined {
    version()
    let ref: ModelRef | undefined = sessionID ? tracked.get(sessionID) : undefined
    if (!ref && sessionID) {
      const messages = api.state.session.messages(sessionID)
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as { role?: string; modelID?: string; providerID?: string }
        if (message.role === "assistant" && message.modelID && message.providerID) {
          ref = { providerID: message.providerID, modelID: message.modelID }
          tracked.set(sessionID, ref)
          break
        }
      }
    }
    if (!ref) {
      const fallback = api.state.config.model
      if (!fallback) return undefined
      const index = fallback.indexOf("/")
      if (index < 1) return undefined
      ref = { providerID: fallback.slice(0, index), modelID: fallback.slice(index + 1) }
    }
    return rules.get(modelKey(ref.providerID, ref.modelID))
  }

  function badge(sessionID: string | undefined) {
    const now = new Date(tick())
    return badgeFor(now, lookupRule(sessionID), labels)
  }

  api.slots.register({
    slots: {
      session_prompt_right: (ctx, props) => {
        const theme = ctx.theme.current
        const state = () => badge(props.session_id)
        return (
          <text fg={state()?.peak ? theme.warning : theme.textMuted}>{state()?.label ?? ""}</text>
        )
      },
      home_prompt_right: (ctx) => {
        const theme = ctx.theme.current
        const state = () => badge(undefined)
        return (
          <text fg={state()?.peak ? theme.warning : theme.textMuted}>{state()?.label ?? ""}</text>
        )
      },
    },
  })

  __test.badge = badge
  __test.refresh = () => setTick(currentNow().getTime())
}

type TestBadge = (sessionID?: string) => ReturnType<typeof badgeFor>

// Test hook. The plugin loader reads the default export only; named exports are ignored.
export const __test: {
  badge: TestBadge | undefined
  refresh: (() => void) | undefined
} = { badge: undefined, refresh: undefined }

const plugin: TuiPluginModule & { id: string } = {
  id: "peak-badge",
  tui,
}

export default plugin
