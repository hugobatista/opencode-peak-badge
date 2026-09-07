import { plugin as registerBunPlugin } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import solid from "@opentui/solid/bun-plugin"

registerBunPlugin(solid)

const mod = await import("../src/index.tsx")

const RGBA = (r: number) => ({ r, g: 0, b: 0, a: 1 })

type Badge = { label: string; peak: boolean } | undefined
type Instance = {
  badge: (sessionID?: string) => Badge
  refresh: () => void
  events: Array<{ type: string; handler: (e: unknown) => void }>
  disposed: Array<() => void>
  registered: Array<Record<string, unknown>>
}

function makeApi(configModel: string, history: Array<Record<string, unknown>> = []) {
  const events: Array<{ type: string; handler: (e: unknown) => void }> = []
  const registered: Array<Record<string, unknown>> = []
  const disposed: Array<() => void> = []
  const api = {
    event: {
      on: (type: string, handler: (e: unknown) => void) => {
        events.push({ type, handler })
        return () => {}
      },
    },
    slots: {
      register: (p: Record<string, unknown>) => {
        registered.push(p)
        return "peak-badge:1"
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn: () => void) => {
        disposed.push(fn)
      },
    },
    state: {
      config: { model: configModel },
      session: { messages: (_id: string) => history },
    },
  }
  return { api, events, registered, disposed }
}

async function init(configModel: string, history: Array<Record<string, unknown>> = []): Promise<Instance> {
  const instance = makeApi(configModel, history)
  await mod.default.tui(instance.api as unknown as TuiPluginApi, undefined, {
    state: "first",
    id: "peak-badge",
  } as TuiPluginMeta)
  return {
    ...instance,
    badge: mod.__test.badge as (sessionID?: string) => Badge,
    refresh: mod.__test.refresh as () => void,
  }
}

const setFake = (iso: string) => {
  process.env.OPENCODE_PEAK_HOURS_FAKE_TIME = iso
}
const clearFake = () => {
  delete process.env.OPENCODE_PEAK_HOURS_FAKE_TIME
}

const cleanups: Array<() => void> = []

describe("module shape", () => {
  test("default export has id and tui fn, no server", () => {
    expect(mod.default?.id).toBe("peak-badge")
    expect(typeof mod.default?.tui).toBe("function")
    expect(mod.default?.server).toBeUndefined()
  })
})

describe("plugin init", () => {
  let instance: Instance
  beforeAll(async () => {
    instance = await init("opencode-go/deepseek-v4-flash")
    cleanups.push(...instance.disposed)
  })

  test("registers both slots", () => {
    const slots = instance.registered[0] as { slots: Record<string, unknown> }
    expect(Object.keys(slots.slots).sort()).toEqual(["home_prompt_right", "session_prompt_right"])
  })

  test("slot render requires the live TUI renderer", () => {
    const slots = instance.registered[0] as { slots: Record<string, (ctx: unknown, props: unknown) => unknown> }
    try {
      slots.slots.session_prompt_right!(
        { theme: { current: { warning: RGBA(255), textMuted: RGBA(128) } } },
        { session_id: "s1" },
      )
      throw new Error("expected slot render to fail outside the TUI")
    } catch (error) {
      expect(error instanceof Error && error.message).toBe("No renderer found")
    }
  })
})

describe("config fallback and states", () => {
  let instance: Instance
  beforeAll(async () => {
    instance = await init("opencode-go/deepseek-v4-flash")
    cleanups.push(...instance.disposed)
  })

  test("tracked default model -> [PEAK] in peak", () => {
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("home slot uses default model -> [PEAK] in peak", () => {
    expect(instance.badge(undefined)).toEqual({ label: "[PEAK]", peak: true })
  })

  test("[OFF-PEAK] still shows in off-peak", () => {
    setFake("2026-09-07T12:00:00Z")
    instance.refresh()
    expect(instance.badge("s1")).toEqual({ label: "[OFF-PEAK]", peak: false })
  })

  test("[OFF-PEAK] on weekends", () => {
    setFake("2026-09-12T07:00:00Z")
    instance.refresh()
    expect(instance.badge("s1")).toEqual({ label: "[OFF-PEAK]", peak: false })
  })
})

describe("untracked default model", () => {
  let instance: Instance
  beforeAll(async () => {
    instance = await init("opencode-go/glm-5.3-flash")
    cleanups.push(...instance.disposed)
  })

  test("no badge", () => {
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s2")).toBeUndefined()
  })
})

describe("model tracking", () => {
  let instance: Instance
  let switched!: { handler: (e: unknown) => void }
  let deleted!: { handler: (e: unknown) => void }
  beforeAll(async () => {
    instance = await init("opencode-go/deepseek-v4-flash")
    cleanups.push(...instance.disposed)
    switched = instance.events.find((e) => e.type === "session.next.model.switched")!
    deleted = instance.events.find((e) => e.type === "session.deleted")!
  })

  test("switched to v4-pro -> [PEAK]", () => {
    setFake("2026-09-07T08:30:00Z")
    switched.handler({
      id: "evt1",
      type: "session.next.model.switched",
      properties: { timestamp: 1, sessionID: "s3", model: { id: "deepseek-v4-pro", providerID: "opencode-go", variant: "" } },
    })
    instance.refresh()
    expect(instance.badge("s3")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("switched to untracked model -> no badge", () => {
    switched.handler({
      id: "evt3",
      type: "session.next.model.switched",
      properties: { timestamp: 2, sessionID: "s3", model: { id: "glm-5.3-flash", providerID: "opencode-go", variant: "" } },
    })
    instance.refresh()
    expect(instance.badge("s3")).toBeUndefined()
  })

  test("session.deleted falls back to config default", () => {
    deleted.handler({ id: "evt2", type: "session.deleted", properties: { info: { id: "s3" } } })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s3")).toEqual({ label: "[PEAK]", peak: true })
  })
})

describe("history seeding", () => {
  test("seeds model from last assistant message", async () => {
    const seeded = await init("opencode-go/glm-5.3-flash", [
      { role: "assistant", modelID: "deepseek-v4-flash", providerID: "opencode-go" },
    ])
    cleanups.push(...seeded.disposed)
    setFake("2026-09-07T08:30:00Z")
    seeded.refresh()
    expect(seeded.badge("s4")).toEqual({ label: "[PEAK]", peak: true })
  })
})

afterAll(() => {
  clearFake()
  for (const fn of cleanups) fn()
})
