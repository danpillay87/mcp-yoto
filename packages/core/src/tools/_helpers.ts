import type { z } from "zod";
import { YotoError } from "../errors.js";

/**
 * A minimal, framework-agnostic tool result shape. Phase 1 wires this into
 * the real MCP SDK v2 tool-registration API (title/description/icon/all
 * four annotation hints/output schema, per the plan's 14-tool table); Phase
 * 0 fixes the parse -> handler -> result contract so every tool is built
 * the same way from day one.
 */
export interface ToolResult<TOutput> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: TOutput;
  isError?: boolean;
}

export interface DefineToolOptions<TInput, TOutput> {
  name: string;
  inputSchema: z.ZodType<TInput>;
  handler: (input: TInput) => Promise<TOutput>;
  /** Renders structuredContent into a human-readable summary line. */
  describe?: (output: TOutput) => string;
}

export interface ToolDefinition<TOutput = unknown> {
  name: string;
  run(rawInput: unknown): Promise<ToolResult<TOutput>>;
}

export function defineTool<TInput, TOutput>(
  options: DefineToolOptions<TInput, TOutput>,
): ToolDefinition<TOutput> {
  return {
    name: options.name,
    async run(rawInput: unknown): Promise<ToolResult<TOutput>> {
      try {
        const input = options.inputSchema.parse(rawInput);
        const output = await options.handler(input);
        const text = options.describe ? options.describe(output) : JSON.stringify(output);
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return toToolResult(error);
      }
    },
  };
}

export function toToolResult(error: unknown): ToolResult<never> {
  if (error instanceof YotoError) {
    const suffix = error.hint ? ` (${error.hint})` : "";
    return {
      content: [{ type: "text", text: `${error.code}: ${error.message}${suffix}` }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `UNEXPECTED_ERROR: ${message}` }], isError: true };
}
