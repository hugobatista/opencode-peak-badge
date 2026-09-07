import { describe, expect, test } from "bun:test"
import {
  badgeFor,
  inWindow,
  isPeakUtc,
  modelKey,
  parseHHMM,
  parseWindows,
  resolveRules,
} from "../src/core"

const windows = parseWindows([["01:00", "04:00"], ["06:00", "10:00"]])
const d = (iso: string) => new Date(iso)

describe("parseHHMM", () => {
  test("01:00 -> 60", () => expect(parseHHMM("01:00")).toBe(60))
  test("10:00 -> 600", () => expect(parseHHMM("10:00")).toBe(600))
  test("25:00 invalid", () => expect(parseHHMM("25:00")).toBeUndefined())
  test("garbage invalid", () => expect(parseHHMM("abc")).toBeUndefined())
})

describe("parseWindows", () => {
  test("default windows", () => expect(parseWindows([["01:00", "04:00"], ["06:00", "10:00"]])).toEqual([
    { start: 60, end: 240 },
    { start: 360, end: 600 },
  ]))
  test("drops invalid windows", () =>
    expect(parseWindows([["01:00", "04:00"], ["xx", "10:00"]])).toEqual([{ start: 60, end: 240 }]))
})

describe("isPeakUtc (DeepSeek windows: 01:00-04:00, 06:00-10:00 UTC, Mon-Fri)", () => {
  test("Mon 08:30 -> peak", () => expect(isPeakUtc(d("2026-09-07T08:30:00Z"), windows)).toBe(true))
  test("Mon 02:30 -> peak", () => expect(isPeakUtc(d("2026-09-07T02:30:00Z"), windows)).toBe(true))
  test("Mon 04:30 gap -> off-peak", () => expect(isPeakUtc(d("2026-09-07T04:30:00Z"), windows)).toBe(false))
  test("Mon 12:00 -> off-peak", () => expect(isPeakUtc(d("2026-09-07T12:00:00Z"), windows)).toBe(false))
  test("boundary start 06:00 inclusive", () => expect(isPeakUtc(d("2026-09-07T06:00:00Z"), windows)).toBe(true))
  test("boundary end 04:00 exclusive", () => expect(isPeakUtc(d("2026-09-07T04:00:00Z"), windows)).toBe(false))
  test("boundary end 10:00 exclusive", () => expect(isPeakUtc(d("2026-09-07T10:00:00Z"), windows)).toBe(false))
  test("boundary start 01:00 inclusive", () => expect(isPeakUtc(d("2026-09-07T01:00:00Z"), windows)).toBe(true))
  test("Sat 07:00 weekend -> off-peak", () => expect(isPeakUtc(d("2026-09-12T07:00:00Z"), windows)).toBe(false))
  test("Sun 02:30 weekend -> off-peak", () => expect(isPeakUtc(d("2026-09-13T02:30:00Z"), windows)).toBe(false))
  test("weekdaysOnly=false, Sat 07:00 -> peak", () =>
    expect(isPeakUtc(d("2026-09-12T07:00:00Z"), windows, false)).toBe(true))
})

describe("inWindow (wrap past midnight)", () => {
  const wrap = [{ start: 1380, end: 120 }]
  test("23:30 in", () => expect(inWindow(23 * 60 + 30, wrap[0]!)).toBe(true))
  test("01:00 in", () => expect(inWindow(60, wrap[0]!)).toBe(true))
  test("12:00 out", () => expect(inWindow(720, wrap[0]!)).toBe(false))
})

describe("modelKey", () => {
  test("lowercases", () => expect(modelKey("opencode-go", "DeepSeek-V4-Flash")).toBe("opencode-go/deepseek-v4-flash"))
})

describe("resolveRules defaults", () => {
  const defaults = resolveRules({})
  test("3 deepseek models", () =>
    expect([...defaults.keys()]).toEqual([
      "opencode-go/deepseek-v4-flash",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/deepseek-v4-flash-vision-exp",
    ]))
  test("windows", () => expect(defaults.get("opencode-go/deepseek-v4-flash")?.windows).toEqual(windows))
  test("weekdaysOnly", () => expect(defaults.get("opencode-go/deepseek-v4-flash")?.weekdaysOnly).toBe(true))
})

describe("resolveRules inheritance and per-entry override", () => {
  const custom = resolveRules({
    windows: [["09:00", "11:00"]],
    weekdaysOnly: false,
    models: [
      "opencode-go/deepseek-v4-flash",
      { id: "zai/glm-5.3", windows: [["14:00", "18:00"]], weekdaysOnly: true },
    ],
  })
  test("string entry inherits top-level windows", () =>
    expect(custom.get("opencode-go/deepseek-v4-flash")?.windows).toEqual([{ start: 540, end: 660 }]))
  test("string entry inherits top-level weekdaysOnly", () =>
    expect(custom.get("opencode-go/deepseek-v4-flash")?.weekdaysOnly).toBe(false))
  test("object entry overrides windows", () => expect(custom.get("zai/glm-5.3")?.windows).toEqual([{ start: 840, end: 1080 }]))
  test("object entry overrides weekdaysOnly", () => expect(custom.get("zai/glm-5.3")?.weekdaysOnly).toBe(true))
})

describe("resolveRules normalization", () => {
  const normalized = resolveRules({ models: [" OPENCODE-GO/DeepSeek-V4-Flash ", "", { id: "" }] })
  test("keys normalized and empties skipped", () =>
    expect([...normalized.keys()]).toEqual(["opencode-go/deepseek-v4-flash"]))
})

describe("badgeFor", () => {
  const flash = resolveRules({}).get("opencode-go/deepseek-v4-flash")
  const labels = { peak: "[PEAK]", offPeak: "[OFF-PEAK]" }
  test("peak", () => expect(badgeFor(d("2026-09-07T08:30:00Z"), flash, labels)).toEqual({ label: "[PEAK]", peak: true }))
  test("off-peak", () => expect(badgeFor(d("2026-09-07T12:00:00Z"), flash, labels)).toEqual({ label: "[OFF-PEAK]", peak: false }))
  test("weekend", () => expect(badgeFor(d("2026-09-12T07:00:00Z"), flash, labels)).toEqual({ label: "[OFF-PEAK]", peak: false }))
  test("no rule -> undefined", () => expect(badgeFor(d("2026-09-07T08:30:00Z"), undefined, labels)).toBeUndefined())
  test("untracked model -> undefined", () =>
    expect(badgeFor(d("2026-09-07T08:30:00Z"), resolveRules({}).get("opencode-go/glm-5.3-flash"), labels)).toBeUndefined())
})
