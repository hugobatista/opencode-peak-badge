/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
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

// OpenCode stores its TUI state under `<XDG_STATE_HOME>/opencode` (default
// `~/.local/state/opencode`). The model picker writes the last chosen model to
// `model.json` there immediately, while the session only commits the model to
// the server on prompt. Reading it lets the badge follow the picker without
// waiting for a prompt.
function stateDir(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(base, "opencode")
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
    const [version, setVersion] = createSignal(0)
    // `homePick` mirrors the TUI's last picked model (model.json `recent[0]`);
    // `defaultModel` is the server's fallback from `client.model.default()`.
    const [homePick, setHomePick] = createSignal<ModelRef | undefined>(undefined)
    const [defaultModel, setDefaultModel] = createSignal<ModelRef | undefined>(undefined)

    // Models committed to the server for a session (from session events or the
    // reactive store). They always win over the transient model.json pick.
    const committed = new Map<string, ModelRef>()
    // Transient picks from model.json, applied only to the active session.
    const picked = new Map<string, ModelRef>()
    const synced = new Set<string>()
    let activeSessionID: string | undefined
    let lastAppliedKey: string | undefined
    let debounceTimer: ReturnType<typeof setTimeout> | undefined

    const timer = setInterval(() => {
      setTick(currentNow().getTime())
      // Safety net in case a filesystem event is missed.
      void applyRecentModel()
    }, pollSeconds * 1000)

    async function applyRecentModel(): Promise<void> {
      const dir = stateDir()
      try {
        const raw = await readFile(join(dir, "model.json"), "utf8")
        const parsed = JSON.parse(raw) as { recent?: Array<{ providerID?: string; modelID?: string }> }
        const recent = parsed.recent?.find((model) => model?.providerID && model?.modelID)
        const key = recent ? `${recent.providerID}/${recent.modelID}` : undefined
        if (key === lastAppliedKey) return
        lastAppliedKey = key
        const ref = recent ? { providerID: recent.providerID!, id: recent.modelID! } : undefined
        setHomePick(ref)
        if (activeSessionID) {
          if (ref) picked.set(activeSessionID, ref)
          else picked.delete(activeSessionID)
        }
        setVersion((value) => value + 1)
      } catch {
        // No model.json yet (or unreadable): keep the default-model fallback.
        // Reset a previously applied pick so a recreated file is re-read.
        if (lastAppliedKey !== undefined) {
          lastAppliedKey = undefined
          setHomePick(undefined)
          if (activeSessionID) picked.delete(activeSessionID)
          setVersion((value) => value + 1)
        }
      }
    }

    function scheduleModelRefresh(): void {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void applyRecentModel(), 100)
    }

    // The TUI writes model.json atomically (temp file plus rename) and the
    // filesystem reports the temp name, so watch the directory and debounce.
    const homeWatcher = (() => {
      try {
        return watch(stateDir(), () => scheduleModelRefresh())
      } catch {
        return undefined
      }
    })()

    void applyRecentModel()

    // The server default is an async, non-reactive client call, so it is cached
    // in a signal and re-fetched on `model.updated`.
    async function refreshHomeModel(): Promise<void> {
      try {
        const result = await ctx.client.model.default()
        const info = result.data
        setDefaultModel(
          info?.providerID && info.id ? { providerID: info.providerID, id: info.id } : undefined,
        )
      } catch {
        // Keep the previous value when the server is unreachable.
      }
    }
    void refreshHomeModel()

    function trackModel(
      sessionID: string | undefined,
      model: { providerID?: string; id?: string } | undefined,
    ): void {
      if (!sessionID || !model?.providerID || !model.id) return
      const ref: ModelRef = { providerID: model.providerID, id: model.id }
      // A committed session model is authoritative over a stale model.json pick.
      const hadPick = picked.delete(sessionID)
      const prev = committed.get(sessionID)
      committed.set(sessionID, ref)
      if (hadPick || !prev || prev.providerID !== ref.providerID || prev.id !== ref.id) {
        setVersion((value) => value + 1)
      }
    }

    function ensureSynced(sessionID: string): void {
      if (synced.has(sessionID)) return
      synced.add(sessionID)
      void ctx.data.session.sync(sessionID).catch(() => synced.delete(sessionID))
    }

    function sessionModel(sessionID: string): ModelRef | undefined {
      const tracked = committed.get(sessionID)
      if (tracked) return tracked
      const model = ctx.data.session.get(sessionID)?.model
      if (model?.providerID && model.id) return { providerID: model.providerID, id: model.id }
      ensureSynced(sessionID)
      return undefined
    }

    function homeRef(): ModelRef | undefined {
      return homePick() ?? defaultModel()
    }

    function mainRef(sessionID: string | undefined): ModelRef | undefined {
      if (sessionID) {
        const pick = picked.get(sessionID)
        if (pick) return pick
        const model = sessionModel(sessionID)
        if (model) return model
      }
      return homeRef()
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
      // Reading `version` keeps event-driven model changes tracked by the memo.
      version()
      if (sessionID !== activeSessionID) {
        // Entering a session drops any pick left over from another one; the
        // session's committed model (once known) is used instead.
        if (sessionID) picked.delete(sessionID)
        activeSessionID = sessionID
      }
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

    const disposeEvents = [
      ctx.data.on("model.updated", () => {
        void refreshHomeModel()
      }),
      ctx.data.on("session.created", (event) => {
        trackModel(event.data.sessionID, event.data.model)
      }),
      ctx.data.on("session.model.selected", (event) => {
        trackModel(event.data.sessionID, event.data.model)
      }),
      ctx.data.on("session.deleted", (event) => {
        const changed = committed.delete(event.data.sessionID)
        const hadPick = picked.delete(event.data.sessionID)
        synced.delete(event.data.sessionID)
        if (changed || hadPick) setVersion((value) => value + 1)
      }),
    ]

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
    __test.applyRecentModel = applyRecentModel
    __test.refreshHomeModel = refreshHomeModel

    return () => {
      for (const dispose of disposeEvents) dispose()
      disposeSessionSlot()
      disposeHomeSlot()
      clearInterval(timer)
      clearTimeout(debounceTimer)
      homeWatcher?.close()
    }
  },
})

// Test hook. The plugin loader reads the default export only; named exports are ignored.
export const __test: {
  badge: ((sessionID?: string) => BadgeState | undefined) | undefined
  badgeText: ((sessionID?: string) => string) | undefined
  refresh: (() => void) | undefined
  applyRecentModel: (() => Promise<void>) | undefined
  refreshHomeModel: (() => Promise<void>) | undefined
} = { badge: undefined, badgeText: undefined, refresh: undefined, applyRecentModel: undefined, refreshHomeModel: undefined }
