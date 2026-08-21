import {
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { OutputReadResult } from "../types";
import { renderProcessReadCall, renderProcessReadResult } from "../ui";
import {
  formatOutputSnapshot,
  formatProcessState,
  type ManagedProcessStatus,
  type ProcessToolOptions,
  requireProcessManager,
  snapshotProcessStatus,
} from "./process-utils";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export const processReadSchema = Type.Object({
  id: Type.String({ description: "Managed process ID, for example p1" }),
  start: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_SAFE_INTEGER,
      description:
        "Explicit zero-based combined-output byte offset. Omit to consume unread output from the process cursor.",
    }),
  ),
  length: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_SAFE_INTEGER,
      description:
        "Positive maximum requested bytes. Returned output is always capped at 50KB and 2000 lines.",
    }),
  ),
});

export type ProcessReadToolInput = Static<typeof processReadSchema>;

export interface ProcessReadToolDetails {
  process: ManagedProcessStatus;
  output: OutputReadResult;
}

export function createProcessReadTool(
  options: ProcessToolOptions,
): ToolDefinition<typeof processReadSchema, ProcessReadToolDetails> {
  return {
    name: "process_read",
    label: "Process Read",
    description:
      "Read the combined stdout/stderr transcript of a managed process. Without start, returns the unread tail through a fixed snapshot, capped at 50KB/2000 lines, reports any omitted prefix, and advances the implicit cursor to the snapshot end. With start, reads forward without moving the cursor and aligns the returned range inward to UTF-8 boundaries. Requested, returned, and omitted ranges always report raw zero-based byte offsets, including bytes skipped for UTF-8 alignment. Length must be positive. Works for active and completed processes retained in the current runtime.",
    promptSnippet:
      "Read combined stdout/stderr from an active or completed managed process",
    promptGuidelines: [
      "Use process_read without start to consume new managed-process output; use an explicit start byte to recover omitted or previously delivered output without moving the implicit cursor.",
    ],
    parameters: processReadSchema,
    renderCall: renderProcessReadCall,
    renderResult: renderProcessReadResult,

    execute(_toolCallId, params, signal) {
      return Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error("Process read aborted");
        if (
          params.length !== undefined
          && (!Number.isSafeInteger(params.length) || params.length < 1)
        ) {
          throw new RangeError("Process read length must be a positive safe integer");
        }
        const manager = requireProcessManager(options);
        const record = manager.getProcess(params.id);
        const output = record.outputStore.read({
          ...(params.start === undefined ? {} : { start: params.start }),
          ...(params.length === undefined ? {} : { length: params.length }),
        });
        const processStatus = snapshotProcessStatus(record, output);
        return {
          content: [{
            type: "text" as const,
            text:
              `Process \`${record.id}\` is ${formatProcessState(processStatus)}.\n${formatOutputSnapshot(output)}`,
          }],
          details: { process: processStatus, output },
        };
      });
    },
  };
}

export function registerProcessReadTool(
  pi: ExtensionAPI,
  options: ProcessToolOptions,
): void {
  pi.registerTool(createProcessReadTool(options));
}
