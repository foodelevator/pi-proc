import {
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import {
  formatProcessState,
  type ManagedProcessStatus,
  type ProcessToolOptions,
  requireProcessManager,
  snapshotProcessStatus,
} from "./process-utils";

export const processListSchema = Type.Object({
  include_completed: Type.Optional(
    Type.Boolean({
      description:
        "Include completed processes retained in this runtime (default: false)",
    }),
  ),
});

export type ProcessListToolInput = Static<typeof processListSchema>;

export interface ProcessListToolDetails {
  includeCompleted: boolean;
  processes: ManagedProcessStatus[];
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function singleLine(command: string): string {
  return command.replace(/[\r\n]+/g, " ");
}

export function createProcessListTool(
  options: ProcessToolOptions,
): ToolDefinition<typeof processListSchema, ProcessListToolDetails> {
  return {
    name: "process_list",
    label: "Process List",
    description:
      "List managed processes from the current runtime. By default returns active processes only; set include_completed=true to include retained completed processes. Each record includes command, mode, PID, timing, exit status, stdin state, output byte/line counts, delivery cursor, and spill path when present. Historical-runtime tombstones are not restored yet.",
    promptSnippet: "List active managed processes, optionally including completed ones",
    promptGuidelines: [
      "Use process_list to discover managed process IDs and status; pass include_completed=true only when completed-process history is relevant.",
    ],
    parameters: processListSchema,

    execute(_toolCallId, params, signal) {
      return Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error("Process list aborted");
        const manager = requireProcessManager(options);
        const includeCompleted = params.include_completed ?? false;
        const records = includeCompleted ? manager.records : manager.activeRecords;
        const now = Date.now();
        const processes = records.map((record) =>
          snapshotProcessStatus(record, undefined, now)
        );
        const emptyText = includeCompleted
          ? "No managed processes exist in this runtime."
          : "No active managed processes."
        const text = processes.length === 0
          ? emptyText
          : processes.map((processStatus) => {
              const output = processStatus.output;
              const spill = output.spillPath === undefined
                ? ""
                : `; spill ${output.spillPath}`;
              return `${processStatus.id}  ${formatProcessState(processStatus)}  ${processStatus.mode}  PID ${processStatus.pid}  ${formatDuration(processStatus.durationMs)}  ${output.totalBytes} bytes/${output.totalLines} lines${spill}  ${singleLine(processStatus.command)}`;
            }).join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { includeCompleted, processes },
        };
      });
    },
  };
}

export function registerProcessListTool(
  pi: ExtensionAPI,
  options: ProcessToolOptions,
): void {
  pi.registerTool(createProcessListTool(options));
}
