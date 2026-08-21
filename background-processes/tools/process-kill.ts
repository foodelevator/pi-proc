import { constants as osConstants } from "node:os";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import {
  isNormallyTerminatingSignal,
  normalizeSignal,
} from "../process-manager";
import type { OutputReadResult } from "../types";
import {
  formatOutputSnapshot,
  formatProcessState,
  type ManagedProcessStatus,
  type ProcessToolOptions,
  requireProcessManager,
  snapshotProcessStatus,
} from "./process-utils";

export const platformSignalNames = Object.freeze(
  Object.keys(osConstants.signals).sort(),
);

// Every supported POSIX platform has signals. Keep a tuple for StringEnum's
// provider-compatible schema while runtime normalization remains authoritative.
const platformSignalTuple = platformSignalNames as unknown as readonly [
  string,
  ...string[],
];

export const processKillSchema = Type.Object({
  id: Type.String({ description: "Active managed process ID, for example p1" }),
  signal: Type.Optional(
    StringEnum(platformSignalTuple, {
      description:
        "Current-platform symbolic signal (default: SIGTERM). The entire process group is signaled.",
    }),
  ),
});

export type ProcessKillToolInput = Static<typeof processKillSchema>;

export interface ProcessKillToolDetails {
  process: ManagedProcessStatus;
  signal: NodeJS.Signals;
  sent: boolean;
  exited: boolean;
  waitedForExit: boolean;
  output: OutputReadResult;
}

export function createProcessKillTool(
  options: ProcessToolOptions,
): ToolDefinition<typeof processKillSchema, ProcessKillToolDetails> {
  return {
    name: "process_kill",
    label: "Process Kill",
    description:
      "Send a current-platform symbolic signal to an active managed process's entire process group (default SIGTERM). For signals that normally terminate, waits up to two seconds for exit; it never escalates automatically. The result reports whether the process exited and consumes its unread combined stdout/stderr. If it survives, its later output/completion reporting remains enabled and SIGKILL can be requested explicitly. Completed, historical, and unknown IDs are errors.",
    promptSnippet: "Signal an active managed process group and read its final output",
    promptGuidelines: [
      "Use process_kill with its default SIGTERM for graceful termination; if the process survives, call process_kill again with SIGKILL only when force termination is appropriate.",
    ],
    parameters: processKillSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Process signal aborted");
      const manager = requireProcessManager(options);
      const normalized = normalizeSignal(params.signal ?? "SIGTERM");
      const waitedForExit = isNormallyTerminatingSignal(
        normalized,
        manager.platform,
      );
      const result = await manager.signalProcessAndWait(
        params.id,
        normalized,
        {
          includeUnreadOutput: true,
          suppressCompletionNotification: true,
        },
      );
      const output = result.output;
      if (output === undefined) {
        throw new Error("Internal error: process signal did not return output");
      }
      const record = manager.getProcess(params.id);
      const processStatus = snapshotProcessStatus(record, output);
      const signalText = result.sent
        ? `Sent ${normalized} to process \`${params.id}\`'s process group.`
        : `Process \`${params.id}\`'s process group was already gone when sending ${normalized}.`;
      const survivalText = result.exited
        ? ` Process is ${formatProcessState(processStatus)}.`
        : waitedForExit
        ? " Process is still running after the wait; no escalation was performed. Use process_kill with SIGKILL to force termination if needed."
        : " Process remains active; this signal is not normally terminating, so no exit wait was performed.";
      return {
        content: [{
          type: "text",
          text: `${signalText}${survivalText}\n${formatOutputSnapshot(output)}`,
        }],
        details: {
          process: processStatus,
          signal: normalized,
          sent: result.sent,
          exited: result.exited,
          waitedForExit,
          output,
        },
      };
    },
  };
}

export function registerProcessKillTool(
  pi: ExtensionAPI,
  options: ProcessToolOptions,
): void {
  pi.registerTool(createProcessKillTool(options));
}
