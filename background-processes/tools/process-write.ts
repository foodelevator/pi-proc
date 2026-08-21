import {
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { ProcessStateError } from "../process-manager";
import {
  formatProcessState,
  type ManagedProcessStatus,
  type ProcessToolOptions,
  requireProcessManager,
  snapshotProcessStatus,
} from "./process-utils";

export const processWriteSchema = Type.Object({
  id: Type.String({ description: "Active managed process ID, for example p1" }),
  data: Type.Optional(
    Type.String({
      description:
        "Exact UTF-8 data to write. No newline is added; include \\n explicitly when the process expects Enter.",
    }),
  ),
  close: Type.Optional(
    Type.Boolean({
      description: "End the process's stdin after writing data (default: false)",
    }),
  ),
});

export type ProcessWriteToolInput = Static<typeof processWriteSchema>;

export interface ProcessWriteToolDetails {
  process: ManagedProcessStatus;
  bytesWritten: number;
  stdinClosed: boolean;
}

function writeFailure(id: string, error: unknown): Error {
  if (error instanceof ProcessStateError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to write to process \`${id}\` stdin: ${reason}`, {
    cause: error,
  });
}

export function createProcessWriteTool(
  options: ProcessToolOptions,
): ToolDefinition<typeof processWriteSchema, ProcessWriteToolDetails> {
  return {
    name: "process_write",
    label: "Process Write",
    description:
      "Write exact UTF-8 data to an active managed process's stdin. This tool never appends a newline: callers must include \\n in data when the program expects Enter. Writes respect stream backpressure. Set close=true to flush the data and then send EOF. Closed stdin, completed processes, historical IDs, and unknown IDs are errors.",
    promptSnippet: "Write exact stdin bytes or send EOF to a managed process",
    promptGuidelines: [
      "process_write does not add a newline; include \\n in data explicitly when submitting a line, and use close=true only when the process should receive EOF.",
    ],
    parameters: processWriteSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Process write aborted");
      const manager = requireProcessManager(options);
      const close = params.close ?? false;
      try {
        await manager.writeProcess(params.id, params.data, close);
      } catch (error) {
        // Prefer the manager's precise completed-state error if the process exited
        // while an otherwise valid stream write was in flight.
        try {
          manager.getActiveProcess(params.id);
        } catch (stateError) {
          throw stateError;
        }
        throw writeFailure(params.id, error);
      }

      const record = manager.getProcess(params.id);
      const processStatus = snapshotProcessStatus(record);
      const bytesWritten = params.data === undefined
        ? 0
        : Buffer.byteLength(params.data, "utf8");
      const action = params.data === undefined
        ? "Wrote no data"
        : `Wrote ${bytesWritten} UTF-8 bytes exactly (no newline added)`;
      const closeText = close ? " Sent EOF after the write." : "";
      return {
        content: [{
          type: "text",
          text:
            `${action} to process \`${params.id}\` stdin.${closeText} Process is ${formatProcessState(processStatus)}.`,
        }],
        details: {
          process: processStatus,
          bytesWritten,
          stdinClosed: processStatus.stdinClosed,
        },
      };
    },
  };
}

export function registerProcessWriteTool(
  pi: ExtensionAPI,
  options: ProcessToolOptions,
): void {
  pi.registerTool(createProcessWriteTool(options));
}
