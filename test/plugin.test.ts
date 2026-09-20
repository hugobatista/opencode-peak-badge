import { plugin as registerBunPlugin } from "bun"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import solid from "@opentui/solid/bun-plugin"

registerBunPlugin(solid)

// Isolate the plugin's model.json source from the real TUI state dir. The
// plugin resolves `<XDG_STATE_HOME>/opencode` on setup, so this must be set
// before any harness is created.
const stateRoot = mkdtempSync(join(tmpdir(), "peak-badge-state-"))
const modelDir = join(stateRoot, "opencode")
mkdirSync(modelDir, { recursive: true })
process.env.XDG_STATE_HOME = stateRoot

const modelFile = join(modelDir, "model.json")

function writeModelFile(recent: Array<{ providerID: string; modelID: string }> | undefined): void {
  if (recent === undefined) rmSync(modelFile, { force: true })
  else writeFileSync(modelFile, JSON.stringify({ recent }))
}

const mod = await import("../src/index.tsx")

const RGBA = (r: number) => ({ r, g: 0, b: 0, a: 1 })

type Badge = { label: string; peak: boolean } | undefined
type ModelRef = { providerID: string; id: string }
type SlotClaim = {
  append?: string
  prepend?: string
  render: (input: { sessionID?: string; mode?: string; showDetails?: boolean }) => unknown
}

type SessionSeed = { id: string; parentID?: string; model?: ModelRef }

type Harness = {
  events: Array<{ type: string; handler: (e: unknown) => void }>
  claims: SlotClaim[]
  cleanup: () => void
  badge: (sessionID?: string) => Badge
  badgeText: (sessionID?: string) => string
  refresh: () => void
  applyRecentModel: () => Promise<void>
  refreshHomeModel: () => Promise<void>
  setDefaultModel: (model: ModelRef | null) => void
  setSession: (session: SessionSeed) => void
  setRunning: (id: string, running: boolean) => void
  emit: (type: string, data: unknown) => void
}

function createHarness(config: {
  defaultModel: ModelRef | null
  options?: Record<string, unknown>
  sessions?: SessionSeed[]
  running?: string[]
}): Harness {
  const events: Array<{ type: string; handler: (e: unknown) => void }> = []
  const claims: SlotClaim[] = []
  const sessions = new Map<string, { parentID?: string; model?: ModelRef }>()
  const running = new Set<string>(config.running ?? [])
  let defaultModel = config.defaultModel

  for (const session of config.sessions ?? []) {
    sessions.set(session.id, { parentID: session.parentID, model: session.model })
  }

  function children(id: string): string[] {
    const out: string[] = []
    for (const [sessionID, record] of sessions) {
      if (record.parentID === id) out.push(sessionID)
    }
    return out
  }

  const ctx = {
    options: config.options ?? {},
    location: { directory: "/project" },
    app: { version: "2.0.10", channel: "dev" },
    client: {
      model: {
        default: async () => ({ location: { directory: "/project" }, data: defaultModel }),
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          model: sessions.get(sessionID)?.model,
        }),
      },
    },
    data: {
      on: (type: string, handler: (e: unknown) => void) => {
        events.push({ type, handler })
        return () => {}
      },
      session: {
        get: (id: string) => {
          const record = sessions.get(id)
          return record ? { id, model: record.model } : undefined
        },
        family: (id: string) => children(id),
        status: (id: string) => (running.has(id) ? "running" : "idle"),
        sync: async () => {},
      },
    },
    theme: {
      text: { muted: RGBA(128), feedback: { warning: { base: RGBA(255) } } },
    },
    ui: {
      slot: (claim: SlotClaim) => {
        claims.push(claim)
        return () => {}
      },
    },
    storage: { memory: () => [{}, () => {}] },
  }

  const cleanup = mod.default.setup(ctx as never) as unknown as () => void

  return {
    events,
    claims,
    cleanup,
    badge: mod.__test.badge as (sessionID?: string) => Badge,
    badgeText: mod.__test.badgeText as (sessionID?: string) => string,
    refresh: mod.__test.refresh as () => void,
    applyRecentModel: mod.__test.applyRecentModel as () => Promise<void>,
    refreshHomeModel: mod.__test.refreshHomeModel as () => Promise<void>,
    setDefaultModel: (model) => {
      defaultModel = model
    },
    setSession: (session) => {
      sessions.set(session.id, { parentID: session.parentID, model: session.model })
    },
    setRunning: (id, value) => {
      if (value) running.add(id)
      else running.delete(id)
    },
    emit: (type, data) => {
      for (const event of events) {
        if (event.type === type) event.handler({ type, data })
      }
    },
  }
}

const setFake = (iso: string) => {
  process.env.OPENCODE_PEAK_HOURS_FAKE_TIME = iso
}
const clearFake = () => {
  delete process.env.OPENCODE_PEAK_HOURS_FAKE_TIME
}

const DS_FLASH: ModelRef = { providerID: "opencode-go", id: "deepseek-v4-flash" }
const GLM: ModelRef = { providerID: "opencode-go", id: "glm-5.3-flash" }

const cleanups: Array<() => void> = []

// The default model is fetched asynchronously during setup; await that first
// fetch so the home/session fallback is deterministic in tests.
async function init(
  defaultModel: ModelRef | null,
  options?: Record<string, unknown>,
  sessions?: SessionSeed[],
  running?: string[],
): Promise<Harness> {
  // Start every test without a picked model so only explicit fixtures apply.
  writeModelFile(undefined)
  const harness = createHarness({ defaultModel, options, sessions, running })
  cleanups.push(harness.cleanup)
  await harness.applyRecentModel()
  await harness.refreshHomeModel()
  return harness
}

describe("module shape", () => {
  test("default export has id and setup fn, no tui/server", () => {
    expect(mod.default?.id).toBe("peak-badge")
    expect(typeof mod.default?.setup).toBe("function")
    expect((mod.default as unknown as Record<string, unknown>).tui).toBeUndefined()
    expect((mod.default as unknown as Record<string, unknown>).server).toBeUndefined()
  })
})

describe("slots", () => {
  test("claims the session and home footer status slots", async () => {
    const harness = await init(DS_FLASH)
    const paths = harness.claims.map((claim) => claim.append).sort()
    expect(paths).toEqual(["home.footer.status", "prompt.footer.status"])
  })

  test("session slot renders nothing without a sessionID", async () => {
    const harness = await init(DS_FLASH)
    const session = harness.claims.find((claim) => claim.append === "prompt.footer.status")!
    expect(session.render({ sessionID: undefined, mode: "normal", showDetails: false })).toBeNull()
  })
})

describe("default (home) model", () => {
  test("tracked default -> [PEAK] in peak", async () => {
    const harness = await init(DS_FLASH)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toEqual({ label: "[PEAK]", peak: true })
  })

  test("[OFF-PEAK] off-peak", async () => {
    const harness = await init(DS_FLASH)
    setFake("2026-09-07T12:00:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toEqual({ label: "[OFF-PEAK]", peak: false })
  })

  test("[OFF-PEAK] on weekends", async () => {
    const harness = await init(DS_FLASH)
    setFake("2026-09-12T07:00:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toEqual({ label: "[OFF-PEAK]", peak: false })
  })

  test("untracked default -> no badge", async () => {
    const harness = await init(GLM)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toBeUndefined()
  })

  test("no default model -> no badge", async () => {
    const harness = await init(null)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toBeUndefined()
  })

  test("model.updated re-fetches the default model", async () => {
    const harness = await init(GLM)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toBeUndefined()
    harness.setDefaultModel(DS_FLASH)
    harness.emit("model.updated", {})
    await harness.refreshHomeModel()
    expect(harness.badge(undefined)).toEqual({ label: "[PEAK]", peak: true })
  })
})

describe("picked model (model.json)", () => {
  const DS_PICK = { providerID: "opencode-go", modelID: "deepseek-v4-flash" }

  test("home badge follows the picked model, not the server default", async () => {
    const harness = await init(GLM)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toBeUndefined()
    writeModelFile([DS_PICK])
    await harness.applyRecentModel()
    expect(harness.badge(undefined)).toEqual({ label: "[PEAK]", peak: true })
  })

  test("clearing model.json restores the server default", async () => {
    const harness = await init(GLM)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    writeModelFile([DS_PICK])
    await harness.applyRecentModel()
    expect(harness.badge(undefined)).toEqual({ label: "[PEAK]", peak: true })
    writeModelFile(undefined)
    await harness.applyRecentModel()
    expect(harness.badge(undefined)).toBeUndefined()
  })

  test("a pick applies to the active session until it is committed", async () => {
    const harness = await init(GLM, undefined, [{ id: "s1" }])
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("s1")).toBeUndefined()
    writeModelFile([DS_PICK])
    await harness.applyRecentModel()
    expect(harness.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
    harness.emit("session.model.selected", {
      sessionID: "s1",
      model: { providerID: "opencode-go", id: "glm-5.3-flash" },
    })
    expect(harness.badge("s1")).toBeUndefined()
  })

  test("session.created with a model feeds the badge", async () => {
    const harness = await init(GLM)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    harness.emit("session.created", { sessionID: "s9", model: { providerID: "opencode-go", id: "deepseek-v4-flash" } })
    expect(harness.badge("s9")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("session.deleted clears committed models", async () => {
    const harness = await init(GLM)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    harness.emit("session.created", { sessionID: "s1", model: { providerID: "opencode-go", id: "deepseek-v4-flash" } })
    expect(harness.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
    harness.emit("session.deleted", { sessionID: "s1" })
    expect(harness.badge("s1")).toBeUndefined()
  })
})

describe("session model", () => {
  test("uses the session model from the data store", async () => {
    const harness = await init(GLM, undefined, [{ id: "s1", model: DS_FLASH }])
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("falls back to the default model when the session has none", async () => {
    const harness = await init(DS_FLASH, undefined, [{ id: "s1" }])
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("follows a model change in the store", async () => {
    const harness = await init(GLM, undefined, [{ id: "s1", model: DS_FLASH }])
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("s1")).toEqual({ label: "[PEAK]", peak: true })
    harness.setSession({ id: "s1", model: GLM })
    expect(harness.badge("s1")).toBeUndefined()
  })

  test("debug: true shows the model key alongside the label", async () => {
    const harness = await init(DS_FLASH, { debug: true }, [{ id: "s1", model: DS_FLASH }])
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badgeText("s1")).toBe("[PEAK] opencode-go/deepseek-v4-flash")
  })

  test("debug: true shows only the model key when no rule matches", async () => {
    const harness = await init(GLM, { debug: true }, [{ id: "s1", model: GLM }])
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badgeText("s1")).toBe("opencode-go/glm-5.3-flash")
  })
})

describe("subagents", () => {
  test("running child in peak feeds the parent badge", async () => {
    const harness = await init(
      GLM,
      undefined,
      [{ id: "child1", parentID: "main1", model: DS_FLASH }],
      ["child1"],
    )
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("running child off-peak -> [OFF-PEAK]", async () => {
    const harness = await init(
      GLM,
      undefined,
      [{ id: "child1", parentID: "main1", model: DS_FLASH }],
      ["child1"],
    )
    setFake("2026-09-07T12:00:00Z")
    harness.refresh()
    expect(harness.badge("main1")).toEqual({ label: "[OFF-PEAK]", peak: false })
  })

  test("idle child is ignored", async () => {
    const harness = await init(GLM, undefined, [{ id: "child1", parentID: "main1", model: DS_FLASH }])
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("main1")).toBeUndefined()
  })

  test("nested running grandchild feeds the parent badge", async () => {
    const harness = await init(
      GLM,
      undefined,
      [
        { id: "child1", parentID: "main1", model: GLM },
        { id: "grandchild1", parentID: "child1", model: DS_FLASH },
      ],
      ["grandchild1"],
    )
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("peak child wins over an off-peak main", async () => {
    const harness = await init(
      GLM,
      {
        models: [
          { id: "opencode-go/glm-5.3-flash", windows: [["12:00", "14:00"]], weekdaysOnly: false },
          "re:^opencode-go/deepseek-v4-flash$",
        ],
      },
      [{ id: "child1", parentID: "main1", model: DS_FLASH }],
      ["child1"],
    )
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
  })

  test("subagents:false ignores children", async () => {
    const harness = await init(
      GLM,
      { subagents: false },
      [{ id: "child1", parentID: "main1", model: DS_FLASH }],
      ["child1"],
    )
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("main1")).toBeUndefined()
  })

  test("a child becoming idle drops the badge", async () => {
    const harness = await init(
      GLM,
      undefined,
      [{ id: "child1", parentID: "main1", model: DS_FLASH }],
      ["child1"],
    )
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge("main1")).toEqual({ label: "[PEAK]", peak: true })
    harness.setRunning("child1", false)
    expect(harness.badge("main1")).toBeUndefined()
  })
})

describe("alwaysShow", () => {
  test("untracked main with alwaysShow:true -> badge from default windows", async () => {
    const harness = await init(GLM, { alwaysShow: true })
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toEqual({ label: "[PEAK]", peak: true })
  })

  test("untracked main with alwaysShow:true -> [OFF-PEAK] off-peak", async () => {
    const harness = await init(GLM, { alwaysShow: true })
    setFake("2026-09-07T12:00:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toEqual({ label: "[OFF-PEAK]", peak: false })
  })

  test("alwaysShow:false -> no badge for untracked main", async () => {
    const harness = await init(GLM)
    setFake("2026-09-07T08:30:00Z")
    harness.refresh()
    expect(harness.badge(undefined)).toBeUndefined()
  })
})

afterAll(() => {
  clearFake()
  for (const fn of cleanups) fn()
  writeModelFile(undefined)
  rmSync(stateRoot, { recursive: true, force: true })
})
