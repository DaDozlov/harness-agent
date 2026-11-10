import { z } from 'zod';
import type {
  Tool,
  ToolContext,
  ToolKind,
  ToolOutput,
  ToolPrecheckContext,
} from '../core/tools.js';

export interface ToolDefinition<Schema extends z.ZodType> {
  name: string;
  /** Tells the model what the tool does and when to use it. Write it for the model. */
  description: string;
  kind: ToolKind;
  parameters: Schema;
  concurrency?: 'parallel' | 'serial';
  /** `path`: permission rules match the subject as a path glob. */
  subjectType?: 'path' | 'text';
  /** Ask the user every time, in every mode (see `Tool.alwaysAsk`). */
  alwaysAsk?: boolean;
  /** How long output is cut (see `Tool.output`). */
  output?: Tool['output'];
  /** What permission rules match against, e.g. the path or command. */
  subject?: (args: z.output<Schema>) => string | undefined;
  /** Why the call cannot run now, checked before the user is asked (see `Tool.precheck`). */
  precheck?: (
    args: z.output<Schema>,
    context: ToolPrecheckContext,
  ) => Promise<string | undefined> | string | undefined;
  run(args: z.output<Schema>, context: ToolContext): ToolOutput | Promise<ToolOutput>;
}

/**
 * Creates a tool from a zod schema: the schema becomes the JSON Schema the model sees and
 * validates every call, so `run` receives typed, checked arguments.
 */
export function defineTool<Schema extends z.ZodType>(definition: ToolDefinition<Schema>): Tool {
  const inputSchema: Record<string, unknown> = {
    ...z.toJSONSchema(definition.parameters, { target: 'draft-7', io: 'input' }),
  };
  delete inputSchema.$schema;
  const { subject } = definition;

  return {
    name: definition.name,
    description: definition.description,
    kind: definition.kind,
    inputSchema,
    concurrency: definition.concurrency,
    subjectType: definition.subjectType,
    alwaysAsk: definition.alwaysAsk,
    ...(definition.output && { output: definition.output }),
    parse(args) {
      const result = definition.parameters.safeParse(args);
      return result.success
        ? { ok: true, args: result.data }
        : { ok: false, error: z.prettifyError(result.error) };
    },
    ...(subject && { subject: (args: unknown) => subject(args as z.output<Schema>) }),
    ...(definition.precheck && {
      precheck: async (args: unknown, context: ToolPrecheckContext) =>
        definition.precheck!(args as z.output<Schema>, context),
    }),
    run: async (args, context) => definition.run(args as z.output<Schema>, context),
  };
}
