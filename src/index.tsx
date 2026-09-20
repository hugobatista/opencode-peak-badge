/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal } from "solid-js"
import {
  badgeFor,
  matchRule,
  mergeBadges,
  modelKey,
  resolveRules,
  type BadgeState,
  type PeakHoursOptions,
  type RuleSet,
} from "./core"

type ModelRef = { providerID: string; id: string }

type BadgeView = { state: BadgeState | undefined; model: ModelRef | undefined }

function currentNow(): Date {
  const fake = process.env.OPENCODE_PEAK_HOURS_FAKE_TIME
  if (fake) {
    const parsed = new Date(fake)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

export default Plugin.define({
  id: "peak-badge",
  setup(ctx: Context) {
    const options: PeakHoursOptions = (ctx.options ?? {}) as PeakHoursOptions
    const rules: RuleSet = resolveRules(options)
    const labels = {
      peak: options.labelPeak ?? "[PEAK]",
      offPeak: options.labelOffPeak ?? "[OFF-PEAK]",
    }
    const pollSeconds = Math.max(1, Number(options.pollSeconds) || 10)
    const subagents = options.subagents ?? true
    const alwaysShow = options.alwaysShow ?? false
    const debug = options.debug ?? false

    const [tick, setTick] = createSignal(currentNow().getTime())
    const [homeModel, setHomeModel] = createSignal<ModelRef | undefined>(undefined)
    const synced = new Set<string>()

    const timer = setInterval(() => setTick(currentNow().getTime()), pollSeconds * 1000)

    // The default model is an async, non-reactive client call, so it is cached in
    // a signal and re-fetched on `model.updated`.
    async function refreshHomeModel(): Promise<void> {
      try {
        const result = await ctx.client.model.default()
        const info = result.data
        setHomeModel(
          info?.providerID && info.id ? { providerID: info.providerID, id: info.id } : undefined,
        )
      } catch {
        // Keep the previous value when the server is unreachable.
      }
    }
    void refreshHomeModel()

    function ensureSynced(sessionID: string): void {
      if (synced.has(sessionID)) return
      synced.add(sessionID)
      void ctx.data.session.sync(sessionID).catch(() => synced.delete(sessionID))
    }

    function sessionModel(sessionID: string): ModelRef | undefined {
      const model = ctx.data.session.get(sessionID)?.model
      if (model?.providerID && model.id) return { providerID: model.providerID, id: model.id }
      ensureSynced(sessionID)
      return undefined
    }

    function mainRef(sessionID: string | undefined): ModelRef | undefined {
      if (sessionID) {
        const model = sessionModel(sessionID)
        if (model) return model
      }
      return homeModel()
    }

    function activeChildRefs(sessionID: string): ModelRef[] {
      if (!subagents) return []
      const refs: ModelRef[] = []
      const seen = new Set<string>()
      const stack: string[] = [...ctx.data.session.family(sessionID)]
      while (stack.length > 0) {
        const id = stack.pop()
        if (!id || seen.has(id)) continue
        seen.add(id)
        if (ctx.data.session.status(id) === "running") {
          const model = sessionModel(id)
          if (model) refs.push(model)
        }
        // `family` may already return every descendant; recursing keeps nested
        // subagents covered if it only returns direct children. `seen` caps it.
        for (const nested of ctx.data.session.family(id)) {
          if (!seen.has(nested)) stack.push(nested)
        }
      }
      return refs
    }

    function badgeView(sessionID: string | undefined): BadgeView {
      const now = new Date(tick())
      const states: BadgeState[] = []
      const main = mainRef(sessionID)
      if (main) {
        const rule =
          matchRule(rules, modelKey(main.providerID, main.id)) ?? (alwaysShow ? rules.fallback : undefined)
        const state = badgeFor(now, rule, labels)
        if (state) states.push(state)
      }
      if (sessionID) {
        for (const child of activeChildRefs(sessionID)) {
          const state = badgeFor(now, matchRule(rules, modelKey(child.providerID, child.id)), labels)
          if (state) states.push(state)
        }
      }
      return { state: mergeBadges(states), model: main }
    }

    function badge(sessionID: string | undefined): BadgeState | undefined {
      return badgeView(sessionID).state
    }

    function badgeText(view: BadgeView): string {
      const model = debug && view.model ? `${view.model.providerID}/${view.model.id}` : ""
      return [view.state?.label ?? "", model].filter(Boolean).join(" ")
    }

    function renderBadge(sessionID: string | undefined) {
      const view = createMemo(() => badgeView(sessionID))
      return (
        <text fg={view().state?.peak ? ctx.theme.text.feedback.warning.base : ctx.theme.text.muted}>
          {badgeText(view())}
        </text>
      )
    }

    const disposeModelUpdated = ctx.data.on("model.updated", () => {
      void refreshHomeModel()
    })

    const disposeSessionSlot = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (input.sessionID ? renderBadge(input.sessionID) : null),
    })
    const disposeHomeSlot = ctx.ui.slot({
      append: "home.footer.status",
      render: () => renderBadge(undefined),
    })

    __test.badge = badge
    __test.badgeText = (sessionID?: string) => badgeText(badgeView(sessionID))
    __test.refresh = () => setTick(currentNow().getTime())
    __test.refreshHomeModel = refreshHomeModel

    return () => {
      disposeModelUpdated()
      disposeSessionSlot()
      disposeHomeSlot()
      clearInterval(timer)
    }
  },
})

// Test hook. The plugin loader reads the default export only; named exports are ignored.
export const __test: {
  badge: ((sessionID?: string) => BadgeState | undefined) | undefined
  badgeText: ((sessionID?: string) => string) | undefined
  refresh: (() => void) | undefined
  refreshHomeModel: (() => Promise<void>) | undefined
} = { badge: undefined, badgeText: undefined, refresh: undefined, refreshHomeModel: undefined }
