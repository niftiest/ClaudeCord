// Single source of truth for the model + effort choices ClaudeCord offers and
// the pricing it uses to estimate a chat's cost. Kept in shared/ so the
// New-Chat dialog, the chat-header selector, and settings all show the same
// list, and so cost math can be unit-tested without the renderer.
//
// Values are what gets passed to `claude --model <value>`: the alias forms
// ('opus'/'sonnet'/'haiku'/'fable') resolve to the current generation the CLI
// itself maps them to, and a full id ('claude-opus-4-8') pins an older one.
// Labels/hints mirror Claude Code's own model picker.

export type ModelOption = { value: string; label: string; hint: string }

export const MODELS: ModelOption[] = [
  { value: 'opus', label: 'Opus 5', hint: 'Best for everyday, complex tasks' },
  { value: 'sonnet', label: 'Sonnet 5', hint: 'Efficient for routine tasks' },
  { value: 'haiku', label: 'Haiku 4.5', hint: 'Fastest for quick answers' },
  { value: 'fable', label: 'Fable 5', hint: 'Most capable, longest-running' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', hint: 'Previous-generation Opus' }
]

/** For showing a model list: by name, newest version first within each. A label
 *  with no version comes first in its name. Claude Code's own order isn't either. */
export function sortModels<T extends { label: string }>(models: readonly T[]): T[] {
  const parts = (label: string): { name: string; version: number[] } => {
    const m = /^(.*?)\s+(\d+(?:\.\d+)*)/.exec(label)
    return { name: (m?.[1] ?? label).toLowerCase(), version: m?.[2]?.split('.').map(Number) ?? [Infinity] }
  }
  return [...models].sort((a, b) => {
    const x = parts(a.label), y = parts(b.label)
    if (x.name !== y.name) return x.name.localeCompare(y.name)
    for (let i = 0; i < Math.max(x.version.length, y.version.length); i++) {
      const diff = (y.version[i] ?? 0) - (x.version[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  })
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** Wraps a user's plain subject description ("cute elk standing near a tree",
 *  "two playing cards") with only the FORMAT/SIZE requirements an avatar needs
 *  -- never any assumption about the content (no "single subject" etc.).
 *  Deliberately AVOIDS the word "icon", which nudges image models into drawing
 *  a small inset badge on a backdrop that then shows as a ring in the round
 *  avatar. It just demands a full-bleed square whose art reaches every edge. */
export function buildAvatarPrompt(subject: string): string {
  const s = subject.trim().replace(/[.\s]+$/, '')
  return `${s}. Square image that completely fills the frame edge to edge, with the artwork ` +
    `reaching all four corners. No border, no frame, no padding, no rounded corners, ` +
    `no transparent background, no text or watermark.`
}

/** A human price line for an image model from its live OpenRouter pricing:
 *  per-image when it prices that way, else per-million tokens. Shared by the
 *  settings panel and the at-generation model dropdowns. `info` is the
 *  ImageModelInfo shape (id/name + imageOutput/prompt/completion USD, any
 *  null). Kept here (not in a component) so it's one formatter, unit-tested. */
export function formatImagePrice(info: {
  imageOutput: number | null; prompt: number | null; completion: number | null
} | null): string {
  if (info === null) return 'price unavailable'
  const trim = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 })
  const parts: string[] = []
  if (info.imageOutput !== null && info.imageOutput > 0) parts.push(`$${trim(info.imageOutput)}/image`)
  if (info.completion !== null && info.completion > 0) parts.push(`$${trim(info.completion * 1_000_000)}/M out`)
  if (parts.length === 0 && info.prompt !== null && info.prompt > 0) parts.push(`$${trim(info.prompt * 1_000_000)}/M in`)
  return parts.length > 0 ? parts.join(' · ') : 'price unavailable'
}

/** OpenRouter image-generation models offered for AI chat avatars. NOTE: chat
 *  GPT models can't generate images -- these are the image-output models
 *  OpenRouter exposes (GPT image first, since that's the requested default). */
export const IMAGE_MODELS: ModelOption[] = [
  { value: 'openai/gpt-image-1', label: 'GPT Image 1', hint: 'OpenAI image model (recommended)' },
  { value: 'openai/gpt-image-2', label: 'GPT Image 2', hint: 'Newer OpenAI image model' },
  { value: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', hint: 'Fast + very cheap' },
  { value: 'black-forest-labs/flux.2-pro', label: 'FLUX.2 Pro', hint: 'High-quality diffusion' },
  { value: 'bytedance-seed/seedream-4.5', label: 'Seedream 4.5', hint: 'Alternative image model' }
]

/** Per-million-token USD rates. cacheRead/cacheWrite follow Anthropic's
 *  standard multipliers (read ≈ 0.1× input, 5-minute write ≈ 1.25× input).
 *  These are list prices for a rough in-app estimate, NOT billing truth. */
export type Pricing = { input: number; output: number; cacheRead: number; cacheWrite: number }

const opusPricing: Pricing = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
const PRICING: Record<string, Pricing> = {
  // aliases → current generation
  opus: opusPricing,
  'claude-opus-5': opusPricing,
  'claude-opus-4-8': opusPricing,
  'claude-opus-4-7': opusPricing,
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  fable: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
}

/** Resolve a model string (alias, full id, or a dated id like
 *  `claude-opus-4-8-20260101`) to its pricing. Unknown/absent → Opus rates,
 *  the safe middle-of-the-road default rather than throwing on a model we
 *  haven't priced yet. Matching is longest-prefix so a dated snapshot still
 *  resolves to its family. */
export function resolveModelPricing(model: string | null | undefined): Pricing {
  if (typeof model !== 'string' || model.length === 0) return opusPricing
  if (PRICING[model] !== undefined) return PRICING[model]
  let best: Pricing | null = null
  let bestLen = -1
  for (const key of Object.keys(PRICING)) {
    const p = PRICING[key]
    if (p !== undefined && model.startsWith(key) && key.length > bestLen) { best = p; bestLen = key.length }
  }
  return best ?? opusPricing
}

/** Context-window size (tokens) for a model, for the context rail's fill bar.
 *  Haiku is 200k; the Opus/Sonnet/Fable generations are 1M. Longest-prefix
 *  match like pricing, defaulting to 200k (the conservative floor). */
export function contextWindowFor(model: string | null | undefined): number {
  if (typeof model === 'string') {
    if (model.startsWith('haiku') || model.startsWith('claude-haiku')) return 200_000
    if (/opus|sonnet|fable/.test(model)) return 1_000_000
  }
  return 200_000
}

export type SessionTokens = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

/** Approximate USD cost of a session's token usage at the given model's list
 *  price. Returns a plain number of dollars; the caller formats it. */
export function costOfSession(model: string | null | undefined, tokens: SessionTokens): number {
  const p = resolveModelPricing(model)
  const per = 1_000_000
  return (
    (tokens.inputTokens * p.input +
      tokens.outputTokens * p.output +
      tokens.cacheRead * p.cacheRead +
      tokens.cacheWrite * p.cacheWrite) /
    per
  )
}

/** Format a dollar amount for the header chip. Sub-cent costs read as
 *  "<$0.01" rather than "$0.00" so a cheap-but-nonzero chat isn't shown as
 *  free; every other amount shows exact cents with thousands separators
 *  (e.g. "$463.54", "$1,234.56") -- never rounded to whole dollars. */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Whole-dollar format for a headline TOTAL (no cents): "$3,232". A tiny but
 *  nonzero total shows "<$1" rather than "$0" so it doesn't read as free. */
export function formatCostWhole(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 1) return '<$1'
  return '$' + Math.round(usd).toLocaleString('en-US')
}
