export type WindowSpec = readonly [start: string, end: string]

export type MinuteWindow = { start: number; end: number }

export type ModelEntrySpec =
  | string
  | {
      id: string
      windows?: WindowSpec[]
      weekdaysOnly?: boolean
    }

export type PeakHoursOptions = {
  models?: ModelEntrySpec[]
  windows?: WindowSpec[]
  weekdaysOnly?: boolean
  pollSeconds?: number
  labelPeak?: string
  labelOffPeak?: string
}

export type ResolvedModelRule = {
  id: string
  windows: MinuteWindow[]
  weekdaysOnly: boolean
}

export type BadgeState = { label: string; peak: boolean }

export const DEFAULT_WINDOWS: WindowSpec[] = [
  ["01:00", "04:00"],
  ["06:00", "10:00"],
]

export const DEFAULT_MODELS: ModelEntrySpec[] = [
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/deepseek-v4-flash-vision-exp",
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

export function resolveRules(options: PeakHoursOptions = {}): Map<string, ResolvedModelRule> {
  const defaultWindows = parseWindows(options.windows?.length ? options.windows : DEFAULT_WINDOWS)
  const defaultWeekdays = options.weekdaysOnly ?? true
  const entries = options.models?.length ? options.models : DEFAULT_MODELS
  const rules = new Map<string, ResolvedModelRule>()
  for (const entry of entries) {
    const spec = typeof entry === "string" ? { id: entry } : entry
    const id = spec.id.trim().toLowerCase()
    if (!id) continue
    rules.set(id, {
      id,
      windows: spec.windows?.length ? parseWindows(spec.windows) : defaultWindows,
      weekdaysOnly: spec.weekdaysOnly ?? defaultWeekdays,
    })
  }
  return rules
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
