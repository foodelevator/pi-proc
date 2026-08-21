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
        "Explicit zero-based combined-output byte offset. Omit start to consume unread output and advance the single delivered cursor shared with monitor/completion notifications, detachment results, and process_kill output. Supplying start is a non-consuming replay/range read; use reported omitted byte ranges with start to recover skipped or already-delivered output. It does not mark fetched bytes as delivered, so bytes at or beyond the shared cursor remain unread and may appear again in later automatic notifications or cursorless reads.",
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
      "Read the combined stdout/stderr transcript of a managed process. Each process has one delivered cursor shared by cursorless process_read calls, monitor/completion notifications, detachment results, and process_kill output. Without start, consumes unread combined output through a fixed snapshot, returns its tail capped at 50KB/2000 lines, reports any omitted prefix, and advances that shared cursor to the snapshot end. Supplying start performs an explicit non-consuming replay/range read; use reported omitted byte ranges with start to recover skipped or already-delivered output. An explicit read neither moves the shared cursor nor marks fetched bytes as delivered, so fetched bytes at or beyond the shared cursor remain unread and may appear again in later automatic notifications or cursorless process_read calls. Explicit ranges align inward to UTF-8 boundaries. Requested, returned, and omitted ranges use raw zero-based byte offsets, including bytes skipped for UTF-8 alignment. Length must be positive. Works for active and completed processes retained in the current runtime.",
    promptSnippet:
      "Read combined process output; cursorless reads consume the cursor shared with notifications, detachment, and process_kill, while start recovers ranges without consuming",
    promptGuidelines: [
      "process_read has one delivered cursor shared with monitor/completion notifications, detachment results, and process_kill output. Omit start to consume unread combined output and advance that shared cursor.",
      "Supplying start to process_read is an explicit non-consuming replay/range read. Use reported omitted byte ranges with start to recover skipped or already-delivered output. It does not mark fetched bytes as delivered, so bytes at or beyond the shared cursor remain unread and may appear again in later automatic notifications or cursorless process_read calls.",
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
