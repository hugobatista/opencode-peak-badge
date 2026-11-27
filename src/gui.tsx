import { Plugin, Slot, createKeyed } from "@opencode/plugin/gui"
import type { MountedSession, SessionScreen } from "@opencode/plugin/gui"
import { Show, createMemo, createSignal, onCleanup } from "solid-js"
import {
  badgeForModels,
  currentNow,
  resolveRules,
  runningSubagentRefs,
  type BadgeState,
  type ModelRef,
  type PeakHoursOptions,
  type RuleSet,
} from "./core"

type BadgeView = { state: BadgeState | undefined; model: ModelRef | undefined }

type SessionInput = {
  readonly session: MountedSession
  readonly screen: SessionScreen
  readonly active?: boolean
}

type HeaderInput = SessionInput & {
  readonly active: boolean
  readonly compact: boolean
}

const chipStyle = {
  display: "inline-flex",
  "align-items": "center",
  gap: "4px",
  "font-size": "11px",
  "font-weight": "600",
  "letter-spacing": "0.02em",
  "white-space": "nowrap",
}

function toRef(model: { providerID?: string; id?: string } | null | undefined): ModelRef | undefined {
  return model?.providerID && model.id ? { providerID: model.providerID, id: model.id } : undefined
}

function fromComposer(model: { providerID: string; modelID: string } | undefined): ModelRef | undefined {
  return model ? { providerID: model.providerID, id: model.modelID } : undefined
}

export default Plugin.define({
  setup(ctx) {
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
    const fakeTime = typeof options.fakeTime === "string" ? options.fakeTime : undefined

    const [tick, setTick] = createSignal(currentNow(fakeTime).getTime())
    const [defaultModel, setDefaultModel] = createSignal<ModelRef | undefined>(undefined)
    // Sessions whose data store has already been asked to sync. Mirrors the TUI
    // adapter so a missing model does not trigger a sync on every tick.
    const synced = new Set<string>()

    function ensureSynced(
      data: { sync(sessionID: string): Promise<void> },
      key: string,
      sessionID: string,
    ): void {
      if (synced.has(key)) return
      synced.add(key)
      void data.sync(sessionID).catch(() => synced.delete(key))
    }

    function badgeText(view: BadgeView): string {
      const model = debug && view.model ? `${view.model.providerID}/${view.model.id}` : ""
      return [view.state?.label ?? "", model].filter(Boolean).join(" ")
    }

    function sessionMainModel(input: SessionInput): ModelRef | undefined {
      // A cached, hidden timeline has no reliable composer model; use the
      // session's committed model there instead.
      const composer = input.active === false ? undefined : fromComposer(input.screen.composer.model())
      if (composer) return composer
      const data = input.session.server.data.session
      const ref = toRef(data.get(input.session.id)?.model)
      if (!ref) ensureSynced(data, input.session.key, input.session.id)
      return ref
    }

    function childModel(input: SessionInput, sessionID: string): ModelRef | undefined {
      const data = input.session.server.data.session
      const ref = toRef(data.get(sessionID)?.model)
      if (!ref) ensureSynced(data, `${input.session.server.id}\n${sessionID}`, sessionID)
      return ref
    }

    function sessionView(input: SessionInput): BadgeView {
      const main = sessionMainModel(input)
      const children = subagents
        ? runningSubagentRefs({
            sessionID: input.session.id,
            family: (id) => input.session.server.data.session.family(id),
            status: (id) => input.session.server.data.session.status(id),
            model: (id) => childModel(input, id),
          })
        : []
      const state = badgeForModels({
        now: new Date(tick()),
        rules,
        labels,
        main,
        subagents: children,
        alwaysShow,
      })
      return { state, model: main }
    }

    function HeaderBadge(props: { input: HeaderInput }) {
      const view = createMemo(() => sessionView(props.input))
      return (
        <Show when={badgeText(view())}>
          {(text) => (
            <span
              style={chipStyle}
              title={text()}
              aria-label={props.input.compact ? text() : undefined}
            >
              <Show when={view().state}>
                {(state) => (
                  <Show when={state().peak} fallback={<ctx.ui.Icon name="circle-check" size="small" />}>
                    <ctx.ui.Icon name="warning" size="small" />
                  </Show>
                )}
              </Show>
              <Show when={!props.input.compact}>{text()}</Show>
            </span>
          )}
        </Show>
      )
    }

    const homeView = createMemo<BadgeView>(() => {
      const main = defaultModel()
      const state = badgeForModels({
        now: new Date(tick()),
        rules,
        labels,
        main,
        subagents: [],
        alwaysShow,
      })
      return { state, model: main }
    })

    function HomeBadge() {
      const text = badgeText(homeView())
      return text ? <span>{text}</span> : null
    }

    async function refreshDefaultModel(): Promise<void> {
      try {
        const result = await ctx.client.model.default()
        setDefaultModel(toRef(result.data))
      } catch {
        // Keep the previous value when the server is unreachable.
      }
    }

    void refreshDefaultModel()

    function builtinData() {
      try {
        for (const id of ctx.servers.list()) {
          const server = ctx.servers.get(id)
          if (server?.builtin) return server.data
        }
      } catch {
        // The app interface may not be mounted yet.
      }
      return undefined
    }

    createKeyed(
      () => builtinData(),
      (data) => onCleanup(data.on("model.updated", () => void refreshDefaultModel())),
    )

    const timer = setInterval(() => {
      setTick(currentNow(fakeTime).getTime())
      // The Home screen has no composer model, so the server default is the only
      // source available there. Refresh it while no session is routed.
      if (!ctx.sessions.current()) void refreshDefaultModel()
    }, pollSeconds * 1000)

    ctx.add(Slot, {
      at: "session.header",
      order: 100,
      render: (input) => <HeaderBadge input={input} />,
    })

    ctx.add(Slot, {
      at: "window.bottom",
      order: 10,
      render: () => (
        <Show when={!ctx.sessions.current()}>
          <HomeBadge />
        </Show>
      ),
    })

    return () => {
      clearInterval(timer)
    }
  },
})
