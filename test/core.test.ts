import { describe, expect, test } from "bun:test"
import {
  badgeFor,
  inWindow,
  isPeakUtc,
  matchRule,
  mergeBadges,
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
  test("3 patterns for the deepseek family across opencode-go, opencode zen and deepseek", () =>
    expect(defaults.patterns.map((rule) => rule.id)).toEqual([
      "^opencode-go/deepseek-(v4-)?(flash|pro)(-vision-exp)?$",
      "^opencode/deepseek-(v4-)?(flash|pro)(-vision-exp)?$",
      "^deepseek/deepseek-(v4-)?(flash|pro)(-vision-exp)?$",
    ]))
  test("deepseek-v4-flash on opencode-go matches", () =>
    expect(matchRule(defaults, modelKey("opencode-go", "deepseek-v4-flash"))).toBeDefined())
  test("deepseek-v4-pro on opencode matches", () =>
    expect(matchRule(defaults, modelKey("opencode", "deepseek-v4-pro"))).toBeDefined())
  test("deepseek-v4-flash-vision-exp on deepseek matches", () =>
    expect(matchRule(defaults, modelKey("deepseek", "deepseek-v4-flash-vision-exp"))).toBeDefined())
  test("deepseek-flash alias matches", () =>
    expect(matchRule(defaults, modelKey("opencode-go", "deepseek-flash"))).toBeDefined())
  test("non-deepseek model not matched", () =>
    expect(matchRule(defaults, modelKey("opencode-go", "glm-5.3-flash"))).toBeUndefined())
  test("qwen model not matched", () =>
    expect(matchRule(defaults, modelKey("opencode-go", "qwen3.8-flash"))).toBeUndefined())
  test("windows", () =>
    expect(matchRule(defaults, modelKey("opencode-go", "deepseek-v4-flash"))?.windows).toEqual(windows))
  test("weekdaysOnly", () =>
    expect(matchRule(defaults, modelKey("opencode-go", "deepseek-v4-flash"))?.weekdaysOnly).toBe(true))
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
    expect(matchRule(custom, modelKey("opencode-go", "deepseek-v4-flash"))?.windows).toEqual([{ start: 540, end: 660 }]))
  test("string entry inherits top-level weekdaysOnly", () =>
    expect(matchRule(custom, modelKey("opencode-go", "deepseek-v4-flash"))?.weekdaysOnly).toBe(false))
  test("object entry overrides windows", () =>
    expect(matchRule(custom, modelKey("zai", "glm-5.3"))?.windows).toEqual([{ start: 840, end: 1080 }]))
  test("object entry overrides weekdaysOnly", () =>
    expect(matchRule(custom, modelKey("zai", "glm-5.3"))?.weekdaysOnly).toBe(true))
})

describe("resolveRules normalization", () => {
  const normalized = resolveRules({ models: [" OPENCODE-GO/DeepSeek-V4-Flash ", "", { id: "" }] })
  test("keys normalized and empties skipped", () =>
    expect([...normalized.exact.keys()]).toEqual(["opencode-go/deepseek-v4-flash"]))
})

describe("resolveRules regex matching", () => {
  test("re: string pattern matches and inherits shared windows", () => {
    const rules = resolveRules({ models: ["re:^opencode-go/deepseek"] })
    const rule = matchRule(rules, modelKey("opencode-go", "deepseek-v4-flash"))
    expect(rule).toBeDefined()
    expect(rule?.windows).toEqual(windows)
    expect(rule?.weekdaysOnly).toBe(true)
  })

  test("{ pattern } object overrides windows", () => {
    const rules = resolveRules({
      models: [{ pattern: "^opencode-go/deepseek", windows: [["14:00", "18:00"]] }],
    })
    const rule = matchRule(rules, modelKey("opencode-go", "deepseek-flash"))
    expect(rule).toBeDefined()
    expect(rule?.windows).toEqual([{ start: 840, end: 1080 }])
  })

  test("pattern matching is case-insensitive on the full key", () => {
    const rules = resolveRules({ models: ["re:^OPENCODE-GO/DeepSeek"] })
    expect(matchRule(rules, modelKey("opencode-go", "deepseek-v4-flash"))).toBeDefined()
  })

  test("exact entry beats an earlier pattern", () => {
    const rules = resolveRules({
      models: ["re:^opencode-go/deepseek", "opencode-go/deepseek-flash"],
    })
    expect(matchRule(rules, modelKey("opencode-go", "deepseek-flash"))?.id).toBe("opencode-go/deepseek-flash")
  })

  test("patterns match in declaration order, first wins", () => {
    const rules = resolveRules({
      models: ["re:^opencode-go/deepseek-v4-flash", "re:^opencode-go/deepseek"],
    })
    expect(matchRule(rules, modelKey("opencode-go", "deepseek-v4-flash"))?.id).toBe("^opencode-go/deepseek-v4-flash")
  })

  test("invalid regex pattern is dropped", () => {
    const rules = resolveRules({ models: ["re:[", "opencode-go/deepseek-v4-flash"] })
    expect(rules.patterns).toEqual([])
    expect([...rules.exact.keys()]).toEqual(["opencode-go/deepseek-v4-flash"])
  })

  test("empty re: pattern is dropped", () => {
    const rules = resolveRules({ models: ["re:^opencode-go/deepseek", "re:"] })
    expect(rules.patterns.map((rule) => rule.id)).toEqual(["^opencode-go/deepseek"])
  })

  test("nested quantifiers (ReDoS) pattern is dropped", () => {
    const rules = resolveRules({ models: ["re:^(a+)+$", "re:^opencode-go/deepseek"] })
    expect(rules.patterns.map((rule) => rule.id)).toEqual(["^opencode-go/deepseek"])
  })
})

describe("badgeFor", () => {
  const flash = matchRule(resolveRules({}), modelKey("opencode-go", "deepseek-v4-flash"))
  const labels = { peak: "[PEAK]", offPeak: "[OFF-PEAK]" }
  test("peak", () => expect(badgeFor(d("2026-09-07T08:30:00Z"), flash, labels)).toEqual({ label: "[PEAK]", peak: true }))
  test("off-peak", () => expect(badgeFor(d("2026-09-07T12:00:00Z"), flash, labels)).toEqual({ label: "[OFF-PEAK]", peak: false }))
  test("weekend", () => expect(badgeFor(d("2026-09-12T07:00:00Z"), flash, labels)).toEqual({ label: "[OFF-PEAK]", peak: false }))
  test("no rule -> undefined", () => expect(badgeFor(d("2026-09-07T08:30:00Z"), undefined, labels)).toBeUndefined())
  test("untracked model -> undefined", () =>
    expect(badgeFor(d("2026-09-07T08:30:00Z"), matchRule(resolveRules({}), modelKey("opencode-go", "glm-5.3-flash")), labels)).toBeUndefined())
})

describe("mergeBadges", () => {
  const labels = { peak: "[PEAK]", offPeak: "[OFF-PEAK]" }
  const flash = matchRule(resolveRules({}), modelKey("opencode-go", "deepseek-v4-flash"))
  const peak = badgeFor(d("2026-09-07T08:30:00Z"), flash, labels)
  const off = badgeFor(d("2026-09-07T12:00:00Z"), flash, labels)
  test("empty -> undefined", () => expect(mergeBadges([])).toBeUndefined())
  test("all undefined -> undefined", () => expect(mergeBadges([undefined, undefined])).toBeUndefined())
  test("single off-peak passes through", () => expect(mergeBadges([off])).toEqual(off))
  test("single peak passes through", () => expect(mergeBadges([peak])).toEqual(peak))
  test("undefined and off-peak -> off-peak", () => expect(mergeBadges([undefined, off])).toEqual(off))
  test("peak wins over off-peak", () => expect(mergeBadges([off, peak])).toEqual(peak))
  test("later off-peak does not override peak", () => expect(mergeBadges([peak, off])).toEqual(peak))
})

describe("resolveRules fallback", () => {
  test("uses top-level windows and weekdaysOnly", () => {
    const rules = resolveRules({ windows: [["09:00", "11:00"]], weekdaysOnly: false })
    expect(rules.fallback.windows).toEqual([{ start: 540, end: 660 }])
    expect(rules.fallback.weekdaysOnly).toBe(false)
  })
  test("uses default windows and weekday-only when unset", () => {
    const rules = resolveRules({})
    expect(rules.fallback.windows).toEqual(windows)
    expect(rules.fallback.weekdaysOnly).toBe(true)
  })
})
