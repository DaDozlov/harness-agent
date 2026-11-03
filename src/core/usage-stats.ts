import { estimateTokens } from './context.js';
import type { EngineEvent } from './events.js';

export interface ToolUsage {
  tool: string;
  calls: number;
  /** Estimated tokens its results added to the conversation, which every later request resends. */
  resultTokens: number;
  /** Calls with the same arguments as an earlier call of the same tool. */
  repeated: number;
}

export interface UsageBreakdown {
  /** The tools whose results added the most first. */
  tools: ToolUsage[];
  modelCalls: number;
  /** Input tokens of the largest single request. */
  largestRequest: number;
}

/**
 * Where a session's tokens go (docs/DESIGN.md §4.14): model calls, and which tools fill the
 * context and how often they repeat a call, the usual causes of rising costs.
 */
export class UsageStats {
  readonly #tools = new Map<string, ToolUsage>();
  readonly #seenCalls = new Set<string>();
  #modelCalls = 0;
  #largestRequest = 0;

  add(event: EngineEvent): void {
    if (event.type === 'tool.start') {
      const usage = this.#tool(event.tool);
      usage.calls += 1;
      const key = `${event.tool}\u0000${JSON.stringify(event.args) ?? ''}`;
      if (this.#seenCalls.has(key)) usage.repeated += 1;
      else this.#seenCalls.add(key);
    } else if (event.type === 'tool.end') {
      this.#tool(event.tool).resultTokens += estimateTokens(event.output);
    } else if (event.type === 'usage') {
      this.#modelCalls += 1;
      this.#largestRequest = Math.max(this.#largestRequest, event.usage.inputTokens);
    }
  }

  breakdown(): UsageBreakdown {
    return {
      tools: [...this.#tools.values()]
        .map((usage) => ({ ...usage }))
        .sort((a, b) => b.resultTokens - a.resultTokens),
      modelCalls: this.#modelCalls,
      largestRequest: this.#largestRequest,
    };
  }

  #tool(name: string): ToolUsage {
    let usage = this.#tools.get(name);
    if (!usage) {
      usage = { tool: name, calls: 0, resultTokens: 0, repeated: 0 };
      this.#tools.set(name, usage);
    }
    return usage;
  }
}
