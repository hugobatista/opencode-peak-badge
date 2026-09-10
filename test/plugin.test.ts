import { plugin as registerBunPlugin } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import solid from "@opentui/solid/bun-plugin"

registerBunPlugin(solid)

const mod = await import("../src/index.tsx")

const RGBA = (r: number) => ({ r, g: 0, b: 0, a: 1 })

type Badge = { label: string; peak: boolean } | undefined
type Instance = {
  badge: (sessionID?: string) => Badge
  badgeText: (sessionID?: string) => string
  refresh: () => void
  applyRecentModel: () => Promise<void>
  events: Array<{ type: string; handler: (e: unknown) => void }>
  disposed: Array<() => void>
  registered: Array<Record<string, unknown>>
}

function makeApi(
  configModel: string,
  history: Array<Record<string, unknown>> = [],
  sessionGet: (sessionID: string) => { model?: { id: string; providerID: string } } | undefined = () => undefined,
  statePath = "",
  statusOf: (sessionID: string) => { type: string } | undefined = () => undefined,
) {
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
      session: {
        messages: (_id: string) => history,
        status: statusOf,
      },
      path: { state: statePath },
    },
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ data: sessionGet(sessionID) }),
      },
    },
  }
  return { api, events, registered, disposed }
}

async function init(
  configModel: string,
  history: Array<Record<string, unknown>> = [],
  sessionGet: (sessionID: string) => { model?: { id: string; providerID: string } } | undefined = () => undefined,
  statePath = "",
  statusOf: (sessionID: string) => { type: string } | undefined = () => undefined,
  rawOptions?: Record<string, unknown>,
): Promise<Instance> {
  const instance = makeApi(configModel, history, sessionGet, statePath, statusOf)
  await mod.default.tui(instance.api as unknown as TuiPluginApi, rawOptions, {
    state: "first",
    id: "peak-badge",
  } as TuiPluginMeta)
  return {
    ...instance,
    badge: mod.__test.badge as (sessionID?: string) => Badge,
    badgeText: mod.__test.badgeText as (sessionID?: string) => string,
    refresh: mod.__test.refresh as () => void,
    applyRecentModel: mod.__test.applyRecentModel as () => Promise<void>,
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

describe("detected model in badge text", () => {
  test("default: badge text shows label only, no model", async () => {
    const instance = await init("opencode-go/deepseek-v4-flash")
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badgeText("s1")).toBe("[PEAK]")
  })

  test("default: no badge text when no rule matches", async () => {
    const instance = await init("opencode-go/glm-5.3-flash")
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badgeText("s1")).toBe("")
  })

  test("default: picked model does not appear in badge text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peak-badge-"))
    writeFileSync(
      join(dir, "model.json"),
      JSON.stringify({ recent: [{ providerID: "opencode-go", modelID: "deepseek-v4-flash" }] }),
    )
    const instance = await init("opencode-go/glm-5.3-flash", [], () => undefined, dir)
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badgeText("s1")).toBe("")
    await instance.applyRecentModel()
    expect(instance.badgeText("s1")).toBe("[PEAK]")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("debug mode shows model", () => {
  test("debug: true shows model key alongside the label", async () => {
    const instance = await init("opencode-go/deepseek-v4-flash", [], () => undefined, "", undefined, { debug: true })
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badgeText("s1")).toBe("[PEAK] opencode-go/deepseek-v4-flash")
  })

  test("debug: true shows only model key when no rule matches", async () => {
    const instance = await init("opencode-go/glm-5.3-flash", [], () => undefined, "", undefined, { debug: true })
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badgeText("s1")).toBe("opencode-go/glm-5.3-flash")
  })

  test("debug: true shows picked model after session pick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peak-badge-"))
    writeFileSync(
      join(dir, "model.json"),
      JSON.stringify({ recent: [{ providerID: "opencode-go", modelID: "deepseek-v4-flash" }] }),
    )
    const instance = await init("opencode-go/glm-5.3-flash", [], () => undefined, dir, undefined, { debug: true })
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badgeText("s1")).toBe("opencode-go/glm-5.3-flash")
    await instance.applyRecentModel()
    expect(instance.badgeText("s1")).toBe("[PEAK] opencode-go/deepseek-v4-flash")
    rmSync(dir, { recursive: true, force: true })
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

describe("home model from recent model.json", () => {
  test("resolves badge from recent[0] when config has no model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peak-badge-"))
    writeFileSync(
      join(dir, "model.json"),
      JSON.stringify({ recent: [{ providerID: "opencode-go", modelID: "deepseek-v4-flash" }] }),
    )
    const instance = await init("", [], () => undefined, dir)
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    await instance.applyRecentModel()
    instance.refresh()
    expect(instance.badge(undefined)).toEqual({ label: "[PEAK]", peak: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test("falls back to off-peak on weekends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peak-badge-"))
    writeFileSync(
      join(dir, "model.json"),
      JSON.stringify({ recent: [{ providerID: "opencode-go", modelID: "deepseek-v4-flash" }] }),
    )
    const instance = await init("", [], () => undefined, dir)
    cleanups.push(...instance.disposed)
    setFake("2026-09-12T07:00:00Z")
    await instance.applyRecentModel()
    instance.refresh()
    expect(instance.badge(undefined)).toEqual({ label: "[OFF-PEAK]", peak: false })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("model picked in a session", () => {
  test("pick updates the session badge before a prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peak-badge-"))
    writeFileSync(
      join(dir, "model.json"),
      JSON.stringify({ recent: [{ providerID: "opencode-go", modelID: "deepseek-v4-flash" }] }),
    )
    const instance = await init("opencode-go/glm-5.3-flash", [], () => undefined, dir)
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s1")).toBeUndefined()
    await instance.applyRecentModel()
    expect(instance.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test("navigating away and back clears the picked model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peak-badge-"))
    writeFileSync(
      join(dir, "model.json"),
      JSON.stringify({ recent: [{ providerID: "opencode-go", modelID: "deepseek-v4-flash" }] }),
    )
    const instance = await init("opencode-go/glm-5.3-flash", [], () => undefined, dir)
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    instance.badge("s1")
    await instance.applyRecentModel()
    expect(instance.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
    instance.badge("s2")
    expect(instance.badge("s1")).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  test("session.get does not clobber a newer event-tracked model", async () => {
    const instance = await init("opencode-go/glm-5.3-flash", [], () => ({
      model: { id: "glm-5.3-flash", providerID: "opencode-go" },
    }))
    cleanups.push(...instance.disposed)
    const switched = instance.events.find((e) => e.type === "session.next.model.switched")!
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s1")).toBeUndefined()
    switched.handler({
      id: "w1",
      type: "session.next.model.switched",
      properties: { timestamp: 1, sessionID: "s1", model: { id: "deepseek-v4-pro", providerID: "opencode-go", variant: "" } },
    })
    expect(instance.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(instance.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
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

describe("model resolution at session start", () => {
  test("session.created seeds model before any prompt", async () => {
    const instance = await init("opencode-go/glm-5.3-flash")
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "evt-c1",
      type: "session.created",
      properties: { sessionID: "s10", info: { model: { id: "deepseek-v4-flash", providerID: "opencode-go" } } },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s10")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("session.updated updates the tracked model", async () => {
    const instance = await init("opencode-go/glm-5.3-flash")
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    const updated = instance.events.find((e) => e.type === "session.updated")!
    created.handler({
      id: "evt-c2",
      type: "session.created",
      properties: { sessionID: "s11", info: { model: { id: "deepseek-v4-flash", providerID: "opencode-go" } } },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s11")).toEqual({ label: "[PEAK]", peak: true })
    updated.handler({
      id: "evt-u2",
      type: "session.updated",
      properties: { sessionID: "s11", info: { model: { id: "glm-5.3-flash", providerID: "opencode-go" } } },
    })
    expect(instance.badge("s11")).toBeUndefined()
  })

  test("async session.get fallback resolves the badge", async () => {
    const instance = await init("opencode-go/glm-5.3-flash", [], (sessionID) =>
      sessionID === "s99" ? { model: { id: "deepseek-v4-flash", providerID: "opencode-go" } } : undefined,
    )
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s99")).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(instance.badge("s99")).toEqual({ label: "[PEAK]", peak: true })
  })
})

describe("subagent tracking", () => {
  test("busy tracked child -> badge in peak", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("busy tracked child off-peak -> [OFF-PEAK]", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T12:00:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[OFF-PEAK]", peak: false })
  })

  test("idle child is not shown", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "idle" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toBeUndefined()
  })

  test("untracked child is not shown", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "glm-5.3-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toBeUndefined()
  })

  test("peak wins when main is off-peak and child is peak", async () => {
    const instance = await init(
      "opencode-go/deepseek-v4-pro",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
      {
        models: [
          { id: "opencode-go/deepseek-v4-pro", windows: [["12:00", "14:00"]], weekdaysOnly: false },
          "re:^opencode-go/deepseek-v4-flash$",
        ],
      },
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("subagents:false ignores children", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
      { subagents: false },
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toBeUndefined()
  })

  test("deleted child clears the badge", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    const deleted = instance.events.find((e) => e.type === "session.deleted")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
    deleted.handler({ id: "d1", type: "session.deleted", properties: { info: { id: "child1" } } })
    instance.refresh()
    expect(instance.badge("main1")).toBeUndefined()
  })

  test("child model set via session.updated", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    const updated = instance.events.find((e) => e.type === "session.updated")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: { sessionID: "child1", info: { parentID: "main1" } },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toBeUndefined()
    updated.handler({
      id: "u1",
      type: "session.updated",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("child model switched via session.next.model.switched", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    const switched = instance.events.find((e) => e.type === "session.next.model.switched")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "glm-5.3-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toBeUndefined()
    switched.handler({
      id: "w1",
      type: "session.next.model.switched",
      properties: {
        timestamp: 1,
        sessionID: "child1",
        model: { id: "deepseek-v4-flash", providerID: "opencode-go", variant: "" },
      },
    })
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("nested busy grandchild -> [PEAK]", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "grandchild1" ? { type: "busy" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "glm-5.3-flash", providerID: "opencode-go" } },
      },
    })
    created.handler({
      id: "g1",
      type: "session.created",
      properties: {
        sessionID: "grandchild1",
        info: { parentID: "child1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("deleted parent clears its children", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    const deleted = instance.events.find((e) => e.type === "session.deleted")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
    deleted.handler({ id: "d1", type: "session.deleted", properties: { info: { id: "main1" } } })
    instance.refresh()
    expect(instance.badge("main1")).toBeUndefined()
  })

  test("session.status listener refreshes busy child", async () => {
    let statusOf: (id: string) => { type: string } | undefined = () => undefined
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => statusOf(id),
    )
    cleanups.push(...instance.disposed)
    expect(instance.events.some((e) => e.type === "session.status")).toBe(true)
    const created = instance.events.find((e) => e.type === "session.created")!
    const statusEvent = instance.events.find((e) => e.type === "session.status")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toBeUndefined()
    statusOf = () => ({ type: "busy" })
    statusEvent.handler({
      id: "s1",
      type: "session.status",
      properties: { sessionID: "child1", status: { type: "busy" } },
    })
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })
})

describe("alwaysShow", () => {
  test("untracked main with alwaysShow:true -> badge from default windows", async () => {
    const instance = await init("opencode-go/glm-5.3-flash", [], () => undefined, "", undefined, {
      alwaysShow: true,
    })
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("untracked main with alwaysShow:true -> [OFF-PEAK] off-peak", async () => {
    const instance = await init("opencode-go/glm-5.3-flash", [], () => undefined, "", undefined, {
      alwaysShow: true,
    })
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T12:00:00Z")
    instance.refresh()
    expect(instance.badge("s1")).toEqual({ label: "[OFF-PEAK]", peak: false })
  })

  test("default alwaysShow:false -> no badge for untracked main", async () => {
    const instance = await init("opencode-go/glm-5.3-flash")
    cleanups.push(...instance.disposed)
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("s1")).toBeUndefined()
  })

  test("alwaysShow applies to main only, child peak still wins", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
      { alwaysShow: true },
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T08:30:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("alwaysShow off-peak main + peak child -> [PEAK]", async () => {
    const instance = await init(
      "opencode-go/glm-5.3-flash",
      [],
      () => undefined,
      "",
      (id) => (id === "child1" ? { type: "busy" } : undefined),
      {
        alwaysShow: true,
        models: [{ id: "opencode-go/deepseek-v4-flash", windows: [["12:00", "14:00"]], weekdaysOnly: false }],
      },
    )
    cleanups.push(...instance.disposed)
    const created = instance.events.find((e) => e.type === "session.created")!
    created.handler({
      id: "c1",
      type: "session.created",
      properties: {
        sessionID: "child1",
        info: { parentID: "main1", model: { id: "deepseek-v4-flash", providerID: "opencode-go" } },
      },
    })
    setFake("2026-09-07T12:00:00Z")
    instance.refresh()
    expect(instance.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })
})

afterAll(() => {
  clearFake()
  for (const fn of cleanups) fn()
})
