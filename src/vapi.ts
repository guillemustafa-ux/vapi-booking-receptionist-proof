/**
 * The slice of Vapi's Server URL contract this receiver uses (docs/sources.md):
 *
 *   tool-calls                    -> { results: [{ name, toolCallId, result | error }] },
 *                                    `result` and `error` flat strings, HTTP 200 even on failure
 *   transfer-destination-request  -> { destination, message } or { error }
 *   anything else                 -> informational: 200 with an empty object
 */

export interface VapiCall {
  id: string;
  customer?: { number?: string };
}

export interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: Record<string, unknown> | string };
}

export interface ServerMessage {
  message: {
    type: string;
    call?: VapiCall;
    timestamp?: string | number;
    toolCallList?: ToolCall[];
  };
}

export type ToolResult = { name: string; toolCallId: string; result: string } | { name: string; toolCallId: string; error: string };

export interface ToolCallsResponse {
  results: ToolResult[];
}

export type TransferResponse =
  | { destination: { type: 'number'; number: string }; message: { type: 'request-start'; message: string } }
  | { error: string };

/** Arguments arrive as an object in the documented examples; a JSON string is accepted too. */
export function toolArguments(call: ToolCall): Record<string, unknown> {
  const args = call.function.arguments;
  if (typeof args === 'string') {
    const parsed: unknown = JSON.parse(args);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be an object');
    return parsed as Record<string, unknown>;
  }
  return args ?? {};
}

/** Shape check of the envelope; tool arguments are validated per tool. */
export function isServerMessage(body: unknown): body is ServerMessage {
  if (body === null || typeof body !== 'object') return false;
  const m = (body as { message?: unknown }).message;
  if (m === null || typeof m !== 'object') return false;
  const { type, call, toolCallList } = m as { type?: unknown; call?: unknown; toolCallList?: unknown };
  if (typeof type !== 'string') return false;
  if (type === 'tool-calls' || type === 'transfer-destination-request') {
    if (call === null || typeof call !== 'object' || typeof (call as { id?: unknown }).id !== 'string') return false;
  }
  if (type === 'tool-calls') {
    if (!Array.isArray(toolCallList)) return false;
    return toolCallList.every(
      (t: unknown) =>
        t !== null &&
        typeof t === 'object' &&
        typeof (t as ToolCall).id === 'string' &&
        typeof (t as ToolCall).function?.name === 'string',
    );
  }
  return true;
}
