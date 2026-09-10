export type WindowSpec = readonly [start: string, end: string]

export type MinuteWindow = { start: number; end: number }

export type ModelEntryObject =
  | { id: string; windows?: WindowSpec[]; weekdaysOnly?: boolean }
  | { pattern: string; windows?: WindowSpec[]; weekdaysOnly?: boolean }

export type ModelEntrySpec = string | ModelEntryObject

export type PeakHoursOptions = {
  models?: ModelEntrySpec[]
  windows?: WindowSpec[]
  weekdaysOnly?: boolean
  pollSeconds?: number
  labelPeak?: string
  labelOffPeak?: string
  subagents?: boolean
  alwaysShow?: boolean
}

export type ResolvedModelRule = {
  id: string
  windows: MinuteWindow[]
  weekdaysOnly: boolean
  regex?: RegExp
}

export type RuleSet = {
  exact: Map<string, ResolvedModelRule>
  patterns: ResolvedModelRule[]
  fallback: ResolvedModelRule
}

export type BadgeState = { label: string; peak: boolean }

export const DEFAULT_WINDOWS: WindowSpec[] = [
  ["01:00", "04:00"],
  ["06:00", "10:00"],
]

export const DEFAULT_MODELS: ModelEntrySpec[] = [
  "re:^opencode-go/deepseek-(v4-)?(flash|pro)(-vision-exp)?$",
  "re:^opencode/deepseek-(v4-)?(flash|pro)(-vision-exp)?$",
  "re:^deepseek/deepseek-(v4-)?(flash|pro)(-vision-exp)?$",
]

export function parseHHMM(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

export function parseWindow(spec: WindowSpec): MinuteWindow | undefined {
  const start = parseHHMM(spec[0])
  const end = parseHHMM(spec[1])
  if (start === undefined || end === undefined) return undefined
  return { start, end }
}

export function parseWindows(specs: readonly WindowSpec[]): MinuteWindow[] {
  const windows: MinuteWindow[] = []
  for (const spec of specs) {
    const window = parseWindow(spec)
    if (window) windows.push(window)
  }
  return windows
}

export function inWindow(minutes: number, window: MinuteWindow): boolean {
  if (window.end <= window.start) return minutes >= window.start || minutes < window.end
  return minutes >= window.start && minutes < window.end
}

export function isPeakUtc(now: Date, windows: readonly MinuteWindow[], weekdaysOnly = true): boolean {
  if (weekdaysOnly) {
    const day = now.getUTCDay()
    if (day === 0 || day === 6) return false
  }
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  return windows.some((window) => inWindow(minutes, window))
}

export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`.trim().toLowerCase()
}

function buildRule(
  id: string,
  spec: { windows?: WindowSpec[]; weekdaysOnly?: boolean },
  defaultWindows: MinuteWindow[],
  defaultWeekdays: boolean,
): ResolvedModelRule {
  return {
    id,
    windows: spec.windows?.length ? parseWindows(spec.windows) : defaultWindows,
    weekdaysOnly: spec.weekdaysOnly ?? defaultWeekdays,
  }
}

export function resolveRules(options: PeakHoursOptions = {}): RuleSet {
  const defaultWindows = parseWindows(options.windows?.length ? options.windows : DEFAULT_WINDOWS)
  const defaultWeekdays = options.weekdaysOnly ?? true
  const entries = options.models?.length ? options.models : DEFAULT_MODELS
  const exact = new Map<string, ResolvedModelRule>()
  const patterns: ResolvedModelRule[] = []
  for (const entry of entries) {
    if (typeof entry === "string") {
      const trimmed = entry.trim()
      if (!trimmed) continue
      if (trimmed.toLowerCase().startsWith("re:")) {
        const source = trimmed.slice(3)
        if (!source.trim()) continue
        const regex = compileRegex(source)
        if (!regex) continue
        patterns.push({ id: source, regex, windows: defaultWindows, weekdaysOnly: defaultWeekdays })
      } else {
        const id = trimmed.toLowerCase()
        exact.set(id, buildRule(id, {}, defaultWindows, defaultWeekdays))
      }
    } else if ("pattern" in entry) {
      const source = entry.pattern
      if (!source.trim()) continue
      const regex = compileRegex(source)
      if (!regex) continue
      patterns.push({
        id: source,
        regex,
        windows: entry.windows?.length ? parseWindows(entry.windows) : defaultWindows,
        weekdaysOnly: entry.weekdaysOnly ?? defaultWeekdays,
      })
    } else {
      const id = entry.id.trim().toLowerCase()
      if (!id) continue
      exact.set(id, buildRule(id, entry, defaultWindows, defaultWeekdays))
    }
  }
  return {
    exact,
    patterns,
    fallback: { id: "", windows: defaultWindows, weekdaysOnly: defaultWeekdays },
  }
}

function compileRegex(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "i")
  } catch {
    return undefined
  }
}

export function matchRule(rules: RuleSet, key: string): ResolvedModelRule | undefined {
  const exact = rules.exact.get(key)
  if (exact) return exact
  for (const rule of rules.patterns) {
    if (rule.regex!.test(key)) return rule
  }
  return undefined
}

export function badgeFor(
  now: Date,
  rule: ResolvedModelRule | undefined,
  labels: { peak: string; offPeak: string },
): BadgeState | undefined {
  if (!rule) return undefined
  const peak = isPeakUtc(now, rule.windows, rule.weekdaysOnly)
  return { label: peak ? labels.peak : labels.offPeak, peak }
}

export function mergeBadges(states: Array<BadgeState | undefined>): BadgeState | undefined {
  let result: BadgeState | undefined
  for (const state of states) {
    if (!state) continue
    if (!result) {
      result = state
      continue
    }
    if (state.peak && !result.peak) result = state
  }
  return result
}
