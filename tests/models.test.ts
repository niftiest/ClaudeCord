import { describe, it, expect } from 'vitest'
import {
  MODELS, EFFORTS, resolveModelPricing, costOfSession, formatCost, formatCostWhole, contextWindowFor,
  buildAvatarPrompt, formatImagePrice
} from '../src/shared/models'

describe('model catalog', () => {
  it('offers the current Claude Code line-up with alias values', () => {
    expect(MODELS.map(m => m.value)).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-4-8'])
    expect(MODELS.map(m => m.label)).toEqual(['Opus 5', 'Sonnet 5', 'Haiku 4.5', 'Fable 5', 'Opus 4.8'])
    for (const m of MODELS) expect(m.hint.length).toBeGreaterThan(0)
  })

  it('lists the five effort levels in ascending order', () => {
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('resolveModelPricing', () => {
  it('matches an exact alias', () => {
    expect(resolveModelPricing('sonnet').input).toBe(3)
    expect(resolveModelPricing('haiku').output).toBe(5)
    expect(resolveModelPricing('fable').input).toBe(10)
  })

  it('resolves a dated snapshot id by longest-prefix to its family', () => {
    // claude-opus-4-8-20260101 → the 'claude-opus-4-8' family, not bare opus
    expect(resolveModelPricing('claude-opus-4-8-20260101')).toEqual(resolveModelPricing('claude-opus-4-8'))
    expect(resolveModelPricing('claude-sonnet-5-20260101').input).toBe(3)
  })

  it('falls back to Opus rates for unknown/absent models', () => {
    const opus = resolveModelPricing('opus')
    expect(resolveModelPricing(null)).toEqual(opus)
    expect(resolveModelPricing(undefined)).toEqual(opus)
    expect(resolveModelPricing('')).toEqual(opus)
    expect(resolveModelPricing('some-future-model')).toEqual(opus)
  })
})

describe('costOfSession', () => {
  it('sums every token bucket at the model rate (per MTok)', () => {
    // 1M input @ $5 + 1M output @ $25 + 1M cacheRead @ $0.5 + 1M cacheWrite @ $6.25 = $36.75
    const cost = costOfSession('opus', {
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000
    })
    expect(cost).toBeCloseTo(36.75, 5)
  })

  it('is zero for a session with no tokens', () => {
    expect(costOfSession('sonnet', { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0)
  })

  it('scales linearly and uses the given model rate', () => {
    const half = costOfSession('haiku', { inputTokens: 500_000, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })
    expect(half).toBeCloseTo(0.5, 5) // 0.5M @ $1/MTok
  })
})

describe('formatCost', () => {
  it('shows exactly free as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00')
  })
  it('shows sub-cent nonzero as <$0.01', () => {
    expect(formatCost(0.003)).toBe('<$0.01')
  })
  it('shows exact cents', () => {
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(42.007)).toBe('$42.01')
    expect(formatCost(463.54)).toBe('$463.54')
  })
  it('keeps cents and adds thousands separators for large amounts', () => {
    expect(formatCost(1234.56)).toBe('$1,234.56')
  })
})

describe('buildAvatarPrompt', () => {
  it('wraps the subject with format-only styling and avoids the word "icon"', () => {
    const p = buildAvatarPrompt('cute elk standing near a tree')
    expect(p.startsWith('cute elk standing near a tree.')).toBe(true)
    expect(p).toMatch(/fills the frame edge to edge/i)
    expect(p).toMatch(/no border/i)
    expect(p.toLowerCase()).not.toContain('icon') // "icon" triggers inset app-badge renders
    expect(p.toLowerCase()).not.toContain('single') // must not assume one subject (e.g. two playing cards)
  })
  it('trims trailing punctuation/space so the subject reads cleanly', () => {
    expect(buildAvatarPrompt('a red panda...  ')).toMatch(/^a red panda\. /)
  })
})

describe('formatImagePrice', () => {
  it('prefers per-image, else per-million-token, else unavailable', () => {
    expect(formatImagePrice({ imageOutput: 0.04, prompt: null, completion: null })).toBe('$0.04/image')
    expect(formatImagePrice({ imageOutput: null, prompt: 0.00001, completion: 0.00001 })).toBe('$10/M out')
    expect(formatImagePrice({ imageOutput: null, prompt: 0.000005, completion: null })).toBe('$5/M in')
    expect(formatImagePrice({ imageOutput: null, prompt: null, completion: null })).toBe('price unavailable')
    expect(formatImagePrice(null)).toBe('price unavailable')
  })
})

describe('contextWindowFor', () => {
  it('is 1M for opus/sonnet/fable and 200k for haiku, defaulting to 200k', () => {
    expect(contextWindowFor('opus')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000)
    expect(contextWindowFor('fable')).toBe(1_000_000)
    expect(contextWindowFor('haiku')).toBe(200_000)
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000)
    expect(contextWindowFor(null)).toBe(200_000)
  })
})

describe('formatCostWhole', () => {
  it('rounds to whole dollars with thousands separators, no cents', () => {
    expect(formatCostWhole(3232.26)).toBe('$3,232')
    expect(formatCostWhole(3232.99)).toBe('$3,233')
    expect(formatCostWhole(42)).toBe('$42')
  })
  it('shows $0 for zero and <$1 for a tiny nonzero total', () => {
    expect(formatCostWhole(0)).toBe('$0')
    expect(formatCostWhole(0.4)).toBe('<$1')
  })
})
