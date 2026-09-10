/** @jsxImportSource @opentui/solid */
import { readFileSync, statSync, watch } from "node:fs"
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
  const pollSeconds = Math.max(1, options.pollSeconds ?? 30)
  const subagents = options.subagents ?? true
  const alwaysShow = options.alwaysShow ?? false

  const [tick, setTick] = createSignal(currentNow().getTime())
  const [version, setVersion] = createSignal(0)
  const tracked = new Map<string, ModelRef>()
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

  const timer = setInterval(() => setTick(currentNow().getTime()), pollSeconds * 1000)
  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    homeWatcher?.close()
  })

  function mainRef(sessionID: string | undefined): ModelRef | undefined {
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
      if (!ref && api.client?.session?.get && !fetching.has(sessionID)) {
        fetching.add(sessionID)
        void api.client.session
          .get({ sessionID })
          .then((result) => {
            fetching.delete(sessionID)
            const model = result.data?.model
            if (model?.providerID && model.id) {
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
    if (Date.now() - homeRefChecked > 5000) refreshHomeModel()
    return homeRef
  }

  function refreshHomeModel(): void {
    homeRef = readRecentModel()
    homeRefChecked = Date.now()
  }

  function readRecentModel(): ModelRef | undefined {
    const state = api.state.path.state
    if (!state) return undefined
    try {
      const raw = readFileSync(`${state}/model.json`, "utf8")
      const parsed = JSON.parse(raw) as { recent?: Array<{ providerID?: string; modelID?: string }> }
      const recent = parsed.recent?.find((model) => model?.providerID && model?.modelID)
      if (recent) return { providerID: recent.providerID!, modelID: recent.modelID! }
    } catch {
      // model.json missing or unreadable
    }
    return undefined
  }

  // Watch model.json so a model picked on the home screen updates the badge
  // immediately instead of waiting for the next poll tick. OpenCode writes the
  // file atomically (rename of a temp file), so the watcher reports the temp
  // name — compare the mtime instead of the reported filename.
  const stateDir = api.state.path.state
  let homeMtime = 0
  function refreshFromWatcher(): void {
    if (!stateDir) return
    try {
      const stat = statSync(`${stateDir}/model.json`)
      if (stat.mtimeMs === homeMtime) return
      homeMtime = stat.mtimeMs
      refreshHomeModel()
      setVersion((value) => value + 1)
    } catch {
      if (homeMtime !== 0) {
        homeMtime = 0
        homeRef = undefined
      }
    }
  }
  const homeWatcher = stateDir
    ? (() => {
        try {
          return watch(stateDir, () => refreshFromWatcher())
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

  function badge(sessionID: string | undefined) {
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
    return mergeBadges(states)
  }

  api.slots.register({
    slots: {
      session_prompt_right: (ctx, props) => {
        const theme = ctx.theme.current
        const state = createMemo(() => badge(props.session_id))
        return (
          <text fg={state()?.peak ? theme.warning : theme.textMuted}>{state()?.label ?? ""}</text>
        )
      },
      home_prompt_right: (ctx) => {
        const theme = ctx.theme.current
        const state = createMemo(() => badge(undefined))
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
