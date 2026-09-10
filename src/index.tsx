/** @jsxImportSource @opentui/solid */
import { readFileSync, watch } from "node:fs"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
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
  const rules: RuleSet = resolveRules(options)
  const labels = {
    peak: options.labelPeak ?? "[PEAK]",
    offPeak: options.labelOffPeak ?? "[OFF-PEAK]",
  }
  const pollSeconds = Math.max(1, options.pollSeconds ?? 10)
  const subagents = options.subagents ?? true
  const alwaysShow = options.alwaysShow ?? false
  const debug = options.debug ?? false

  const [tick, setTick] = createSignal(currentNow().getTime())
  const [version, setVersion] = createSignal(0)
  const tracked = new Map<string, ModelRef>()
  const picked = new Map<string, ModelRef>()
  let activeSessionID: string | undefined
  const fetching = new Set<string>()
  const childParent = new Map<string, string>()
  const children = new Map<string, Map<string, ModelRef>>()

  function trackModel(sessionID: string, model: { providerID?: string; id?: string } | undefined): void {
    if (!sessionID || !model?.providerID || !model?.id) return
    tracked.set(sessionID, { providerID: model.providerID, modelID: model.id })
    setVersion((value) => value + 1)
  }

  function trackChild(
    sessionID: string,
    parentID: string | undefined,
    model: { providerID?: string; id?: string } | undefined,
  ): void {
    if (!sessionID || !parentID) return
    let changed = false
    if (childParent.get(sessionID) !== parentID) {
      childParent.set(sessionID, parentID)
      changed = true
    }
    const map = children.get(parentID) ?? new Map<string, ModelRef>()
    if (model?.providerID && model?.id) {
      const ref: ModelRef = { providerID: model.providerID, modelID: model.id }
      const prev = map.get(sessionID)
      if (!prev || prev.providerID !== ref.providerID || prev.modelID !== ref.modelID) {
        map.set(sessionID, ref)
        changed = true
      }
    } else if (map.delete(sessionID)) {
      changed = true
    }
    if (changed) {
      children.set(parentID, map)
      setVersion((value) => value + 1)
    }
  }

  api.event.on("session.created", (event) => {
    trackModel(event.properties.sessionID, event.properties.info?.model)
    trackChild(event.properties.sessionID, event.properties.info?.parentID, event.properties.info?.model)
  })

  api.event.on("session.updated", (event) => {
    trackModel(event.properties.sessionID, event.properties.info?.model)
    trackChild(
      event.properties.sessionID,
      event.properties.info?.parentID ?? childParent.get(event.properties.sessionID),
      event.properties.info?.model,
    )
  })

  api.event.on("session.next.model.switched", (event) => {
    trackModel(event.properties.sessionID, event.properties.model)
    trackChild(event.properties.sessionID, childParent.get(event.properties.sessionID), event.properties.model)
  })

  api.event.on("session.status", (event) => {
    if (childParent.has(event.properties.sessionID)) setVersion((value) => value + 1)
  })

  api.event.on("session.deleted", (event) => {
    const sessionID = event.properties.info.id
    let changed = tracked.delete(sessionID)
    if (picked.delete(sessionID)) changed = true
    const childMap = children.get(sessionID)
    if (childMap) {
      for (const childID of childMap.keys()) childParent.delete(childID)
      children.delete(sessionID)
      changed = true
    }
    const parent = childParent.get(sessionID)
    if (parent) {
      if (children.get(parent)?.delete(sessionID)) changed = true
      childParent.delete(sessionID)
    }
    if (changed) setVersion((value) => value + 1)
  })

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setInterval(() => {
    setTick(currentNow().getTime())
    applyRecentModel()
  }, pollSeconds * 1000)
  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    clearTimeout(debounceTimer)
    homeWatcher?.close()
  })

  function mainRef(sessionID: string | undefined): ModelRef | undefined {
    version()
    let ref: ModelRef | undefined = sessionID ? (picked.get(sessionID) ?? tracked.get(sessionID)) : undefined
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
      if (!ref && api.client?.session?.get && !fetching.has(sessionID)) {
        fetching.add(sessionID)
        void api.client.session
          .get({ sessionID })
          .then((result) => {
            fetching.delete(sessionID)
            const model = result.data?.model
            if (model?.providerID && model.id && !tracked.has(sessionID)) {
              tracked.set(sessionID, { providerID: model.providerID, modelID: model.id })
              setVersion((value) => value + 1)
            }
          })
          .catch(() => fetching.delete(sessionID))
      }
    }
    if (!ref) {
      ref = sessionID ? configModelRef() : (configModelRef() ?? homeModelRef())
    }
    return ref
  }

  function configModelRef(): ModelRef | undefined {
    const fallback = api.state.config.model
    if (!fallback) return undefined
    const index = fallback.indexOf("/")
    if (index < 1) return undefined
    return { providerID: fallback.slice(0, index), modelID: fallback.slice(index + 1) }
  }

  let homeRef: ModelRef | undefined
  let homeRefChecked = 0
  function homeModelRef(): ModelRef | undefined {
    if (Date.now() - homeRefChecked > 5000) applyRecentModel()
    return homeRef
  }

  let lastAppliedKey: string | undefined

  function applyRecentModel(): void {
    const state = api.state.path.state
    if (!state) return
    try {
      const raw = readFileSync(`${state}/model.json`, "utf8")
      const parsed = JSON.parse(raw) as { recent?: Array<{ providerID?: string; modelID?: string }> }
      const recent = parsed.recent?.find((model) => model?.providerID && model?.modelID)
      const key = recent ? `${recent.providerID}/${recent.modelID}` : undefined
      if (key === lastAppliedKey) return
      lastAppliedKey = key
      homeRef = recent ? { providerID: recent.providerID!, modelID: recent.modelID! } : undefined
      homeRefChecked = Date.now()
      if (activeSessionID && homeRef) picked.set(activeSessionID, homeRef)
      setVersion((value) => value + 1)
    } catch {
      if (lastAppliedKey !== undefined) {
        lastAppliedKey = undefined
        homeRef = undefined
      }
    }
  }

  // Watch model.json so a model picked on the home screen updates the badge
  // immediately instead of waiting for the next poll tick. OpenCode writes the
  // file atomically (rename of a temp file), so we debounce the read to
  // ensure it happens after the rename completes.
  const stateDir = api.state.path.state
  function scheduleModelRefresh(): void {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => applyRecentModel(), 100)
  }
  const homeWatcher = stateDir
    ? (() => {
        try {
          return watch(stateDir, () => scheduleModelRefresh())
        } catch {
          return undefined
        }
      })()
    : undefined

  function activeChildRefs(sessionID: string): ModelRef[] {
    if (!subagents) return []
    const refs: ModelRef[] = []
    const stack: string[] = [sessionID]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const parent = stack.pop()
      if (!parent || seen.has(parent)) continue
      seen.add(parent)
      const map = children.get(parent)
      if (!map) continue
      for (const [childID, ref] of map) {
        if (api.state.session.status?.(childID)?.type === "busy") refs.push(ref)
        stack.push(childID)
      }
    }
    return refs
  }

  function badgeView(sessionID: string | undefined): { state: BadgeState | undefined; model: ModelRef | undefined } {
    if (sessionID !== activeSessionID) {
      if (sessionID) picked.delete(sessionID)
      activeSessionID = sessionID
    }
    const now = new Date(tick())
    const states: BadgeState[] = []
    const main = mainRef(sessionID)
    if (main) {
      const rule =
        matchRule(rules, modelKey(main.providerID, main.modelID)) ?? (alwaysShow ? rules.fallback : undefined)
      const state = badgeFor(now, rule, labels)
      if (state) states.push(state)
    }
    if (sessionID) {
      for (const child of activeChildRefs(sessionID)) {
        const state = badgeFor(now, matchRule(rules, modelKey(child.providerID, child.modelID)), labels)
        if (state) states.push(state)
      }
    }
    return { state: mergeBadges(states), model: main }
  }

  function badge(sessionID: string | undefined) {
    return badgeView(sessionID).state
  }

  function badgeText(view: { state: BadgeState | undefined; model: ModelRef | undefined }): string {
    const model = debug && view.model ? `${view.model.providerID}/${view.model.modelID}` : ""
    return [view.state?.label ?? "", model].filter(Boolean).join(" ")
  }

  api.slots.register({
    slots: {
      session_prompt_right: (ctx, props) => {
        const theme = ctx.theme.current
        const view = createMemo(() => badgeView(props.session_id))
        return (
          <text fg={view().state?.peak ? theme.warning : theme.textMuted}>{badgeText(view())}</text>
        )
      },
      home_prompt_right: (ctx) => {
        const theme = ctx.theme.current
        const view = createMemo(() => badgeView(undefined))
        return (
          <text fg={view().state?.peak ? theme.warning : theme.textMuted}>{badgeText(view())}</text>
        )
      },
    },
  })

  __test.badge = badge
  __test.badgeText = (sessionID?: string) => badgeText(badgeView(sessionID))
  __test.refresh = () => setTick(currentNow().getTime())
  __test.applyRecentModel = applyRecentModel
}

type TestBadge = (sessionID?: string) => ReturnType<typeof badgeFor>

// Test hook. The plugin loader reads the default export only; named exports are ignored.
export const __test: {
  badge: TestBadge | undefined
  badgeText: ((sessionID?: string) => string) | undefined
  refresh: (() => void) | undefined
  applyRecentModel: (() => void) | undefined
} = { badge: undefined, badgeText: undefined, refresh: undefined, applyRecentModel: undefined }

const plugin: TuiPluginModule & { id: string } = {
  id: "peak-badge",
  tui,
}

export default plugin
