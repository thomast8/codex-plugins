import { serializeError } from "./errors.js";

export interface ToolTextResult extends Record<string, unknown> {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function toolResult(payload: unknown): ToolTextResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

export function toolError(error: unknown): ToolTextResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: serializeError(error)
          },
          null,
          2
        )
      }
    ]
  };
}

export async function handleTool(
  operation: () => Promise<unknown>
): Promise<ToolTextResult> {
  try {
    return toolResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}
