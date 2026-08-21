import {
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import {
  formatProcessState,
  type HistoricalProcessStatus,
  type ManagedProcessStatus,
  type ProcessToolOptions,
  requireProcessManager,
  snapshotHistoricalProcessStatus,
  snapshotProcessStatus,
} from "./process-utils";

export const processListSchema = Type.Object({
  include_completed: Type.Optional(
    Type.Boolean({
      description:
        "Include completed processes from this runtime and historical-runtime tombstones (default: false)",
    }),
  ),
});

export type ProcessListToolInput = Static<typeof processListSchema>;

export interface ProcessListToolDetails {
  includeCompleted: boolean;
  processes: Array<ManagedProcessStatus | HistoricalProcessStatus>;
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
      "List managed processes. By default returns active processes only from this runtime; set include_completed=true to include retained completed processes and historical-runtime tombstones. Records preserve command, mode, timing, last status, shutdown reason, output counts, and spill path when known.",
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
        const processes: Array<ManagedProcessStatus | HistoricalProcessStatus> = [
          ...records.map((record) => snapshotProcessStatus(record, undefined, now)),
          ...(includeCompleted
            ? manager.historicalRecords.map(snapshotHistoricalProcessStatus)
            : []),
        ];
        const emptyText = includeCompleted
          ? "No current or historical managed processes exist."
          : "No active managed processes."
        const text = processes.length === 0
          ? emptyText
          : processes.map((processStatus) => {
              if (processStatus.state === "historical") {
                const output = processStatus.output;
                const outputText = output.totalBytes === undefined
                  && output.totalLines === undefined
                  ? "output unknown"
                  : `${output.totalBytes ?? "?"} bytes/${output.totalLines ?? "?"} lines`;
                const spill = output.spillPath === undefined
                  ? ""
                  : `; spill ${output.spillPath}`;
                const metadata = [
                  processStatus.mode,
                  processStatus.pid === undefined ? undefined : `PID ${processStatus.pid}`,
                  processStatus.priorState === undefined
                    ? undefined
                    : `last ${processStatus.priorState}`,
                ].filter((item): item is string => item !== undefined).join("  ");
                const command = processStatus.command === undefined
                  ? "(command unknown)"
                  : singleLine(processStatus.command);
                return `${processStatus.id}  historical${metadata === "" ? "" : `  ${metadata}`}  ${outputText}${spill}  ${command}\n  ${processStatus.reason}`;
              }
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
