export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Included in `outputTokens`. */
  reasoningTokens: number;
  /** Included in `inputTokens`. */
  cacheReadTokens: number;
  /** Included in `inputTokens`. */
  cacheWriteTokens: number;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** USD per million tokens. Cached input costs the input price unless its own price is given. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** What `usage` cost in USD, or undefined when the price is unknown. */
export function costOf(usage: Usage, pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined;
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const total =
    uncached * pricing.input +
    usage.cacheReadTokens * (pricing.cacheRead ?? pricing.input) +
    usage.cacheWriteTokens * (pricing.cacheWrite ?? pricing.input) +
    usage.outputTokens * pricing.output;
  return total / 1_000_000;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
