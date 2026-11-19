import type { ToolCall, ToolResult, TransferResponse, VapiCall } from './vapi.js';

/** What the Server URL needs from a receptionist; the honest and the naive side both implement it. */
export interface Receptionist {
  /** One result per tool call, in the order received. */
  handleToolCalls(call: VapiCall, toolCalls: ToolCall[]): Promise<ToolResult[]>;
  transferDestination(call: VapiCall): TransferResponse;
  close(): void;
}
