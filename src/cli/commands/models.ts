import { loadConfig } from '../../config/load.js';
import type { ModelCapabilities } from '../../core/model.js';
import { usableWindow } from '../../core/context.js';
import { capabilitiesFor, pricedModels } from '../../providers/catalog.js';
import { type Env, parseModelSpec, PROVIDER_NAMES } from '../../providers/registry.js';
import { formatTokens } from '../format.js';
import { userFacingMessage } from '../setup.js';
import type { Output } from './run.js';

/**
 * `heaw models`: the model heaw would use and what it knows about it, the providers, and the
 * models with a built-in price. Needs no credentials.
 */
export async function modelsCommand(
  options: { model?: string },
  context: {
    cwd: string;
    env: Env;
    stdout: Output;
    stderr: Output;
    packageEntry?: string | undefined;
  },
): Promise<number> {
  let config;
  try {
    ({ config } = await loadConfig({
      cwd: context.cwd,
      env: context.env,
      packageEntry: context.packageEntry,
    }));
  } catch (error) {
    const message = userFacingMessage(error);
    if (message === undefined) throw error;
    context.stderr.write(`${message}\n`);
    return 2;
  }

  const lines: string[] = [];
  const fromEnv = context.env.HEAW_MODEL?.trim() || undefined;
  const spec = options.model ?? fromEnv ?? config.model;
  const source = options.model ? '--model' : fromEnv ? 'HEAW_MODEL' : 'heaw.config.ts';
  if (spec) {
    try {
      const { modelId } = parseModelSpec(spec);
      const capabilities = { ...capabilitiesFor(modelId), ...config.models?.[spec] };
      lines.push(`Model: ${spec} (from ${source})`, ...describe(capabilities));
    } catch (error) {
      lines.push(`Model: ${spec} (from ${source}) — ${(error as Error).message}`);
    }
  } else {
    lines.push('Model: none selected. Set model in heaw.config.ts, HEAW_MODEL, or use --model.');
  }

  const custom = Object.entries(config.providers ?? {})
    .filter(([name]) => !PROVIDER_NAMES.includes(name))
    .map(([name, settings]) => `${name} (${settings.type ?? 'unknown type'})`);
  lines.push(
    '',
    `Providers: ${PROVIDER_NAMES.join(', ')}${custom.length ? `; from heaw.config.ts: ${custom.join(', ')}` : ''}`,
    `Built-in prices: ${pricedModels().join(', ')}.`,
    "Others: set models: { 'provider:model': { pricing: { input, output } } } in heaw.config.ts (USD per million tokens).",
  );
  context.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function describe(capabilities: ModelCapabilities): string[] {
  const features = (
    [
      ['tools', capabilities.toolCalling],
      ['parallel tool calls', capabilities.parallelToolCalls],
      ['images', capabilities.vision],
      ['reasoning', capabilities.reasoning],
      ['prompt caching', capabilities.promptCaching],
    ] as const
  )
    .filter(([, has]) => has)
    .map(([name]) => name);
  const price = capabilities.pricing;
  // $2.50, but $0.025 as it is.
  const usd = (value: number) => `$${value >= 0.1 ? value.toFixed(2) : value}`;
  return [
    `  Context: ${formatTokens(capabilities.contextWindow)} tokens (${formatTokens(usableWindow(capabilities))} for input), answers up to ${formatTokens(capabilities.maxOutputTokens)}`,
    `  Supports: ${features.join(', ') || 'text only'}`,
    price
      ? `  Price per million tokens: ${usd(price.input)} input${price.cacheRead !== undefined ? `, ${usd(price.cacheRead)} cached` : ''}, ${usd(price.output)} output`
      : '  Price: unknown, so costs are not shown and cost limits are refused.',
  ];
}
