import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type BashToolDetails,
  type ExtensionAPI,
  type ToolDefinition,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { OutputStore } from "../output-store";
import type { ProcessManager } from "../process-manager";
import type { ForegroundExecution } from "../types";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
export const BASH_UPDATE_THROTTLE_MS = 100;

export const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  mode: Type.Optional(
    Type.Enum(["wait", "background", "monitor"], {
      description: "Execution mode (default: wait)",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout)",
    }),
  ),
});

export type BackgroundBashToolInput = Static<typeof bashSchema>;

export interface WaitBashToolOptions {
  getManager: () => ProcessManager | undefined;
  /** Test seam; production matches Pi's 100 ms update throttle. */
  updateThrottleMs?: number;
}

interface BashOutputSnapshot {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

function snapshotOutput(output: OutputStore): BashOutputSnapshot {
  const read = output.snapshotTail();
  const truncatedBy = read.truncation.truncated
    ? read.truncation.by.includes("lines")
      ? "lines"
      : "bytes"
    : null;
  const startsMidLine = read.returnedRange.start > 0
    && output.readRange(read.returnedRange.start - 1, 1).content !== "\n";
  const lastLinePartial = truncatedBy === "bytes"
    && read.returnedLines === 1
    && startsMidLine;
  const truncation: TruncationResult = {
    content: read.content,
    truncated: read.truncation.truncated,
    truncatedBy,
    totalLines: read.totalLines,
    totalBytes: read.totalBytes,
    outputLines: read.returnedLines,
    outputBytes: read.returnedBytes,
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  };
  return {
    content: read.content,
    truncation,
    ...(read.spillPath === undefined ? {} : { fullOutputPath: read.spillPath }),
  };
}

function partialResult(snapshot: BashOutputSnapshot) {
  return {
    content: [{ type: "text" as const, text: snapshot.content || "" }],
    details: {
      truncation: snapshot.truncation.truncated
        ? snapshot.truncation
        : undefined,
      fullOutputPath: snapshot.fullOutputPath,
    },
  };
}

function formatOutput(
  output: OutputStore,
  snapshot: BashOutputSnapshot,
  emptyText = "(no output)",
): { text: string; details: BashToolDetails | undefined } {
  const { truncation } = snapshot;
  let text = snapshot.content || emptyText;
  if (!truncation.truncated) return { text, details: undefined };

  const details: BashToolDetails = {
    truncation,
    fullOutputPath: snapshot.fullOutputPath,
  };
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(output.lastLineBytes)}). Full output: ${snapshot.fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
  }
  return { text, details };
}

function appendStatus(text: string, status: string): string {
  return `${text ? `${text}\n\n` : ""}${status}`;
}

export function createWaitBashTool(
  options: WaitBashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
  const updateThrottleMs = options.updateThrottleMs
    ?? BASH_UPDATE_THROTTLE_MS;
  if (!Number.isFinite(updateThrottleMs) || updateThrottleMs < 0) {
    throw new RangeError("updateThrottleMs must be a non-negative finite number");
  }

  return {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Mode defaults to wait; background and monitor are reserved for managed execution. Optionally provide a timeout in seconds.`,
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: [
      "You can inspect PI_* environment variables for current model and session details.",
    ],
    parameters: bashSchema,

    async execute(_toolCallId, params, signal, onUpdate) {
      const mode = params.mode ?? "wait";
      if (mode !== "wait") {
        throw new Error(
          `Bash mode \`${mode}\` is not implemented yet; use mode \`wait\``,
        );
      }
      const timeoutMs = resolveTimeoutMs(params.timeout);
      if (signal?.aborted) throw new Error("Command aborted");

      const manager = options.getManager();
      if (manager === undefined) {
        throw new Error("Bash process manager is unavailable before session_start");
      }

      let execution: ForegroundExecution | undefined;
      let unsubscribeOutput: (() => void) | undefined;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;
      let aborted = false;
      let abortSignalError: Error | undefined;

      const emitOutputUpdate = (): void => {
        if (onUpdate === undefined || !updateDirty || execution === undefined) {
          return;
        }
        updateDirty = false;
        lastUpdateAt = Date.now();
        onUpdate(partialResult(snapshotOutput(execution.outputStore)));
      };
      const clearUpdateTimer = (): void => {
        if (updateTimer === undefined) return;
        clearTimeout(updateTimer);
        updateTimer = undefined;
      };
      const scheduleOutputUpdate = (): void => {
        if (onUpdate === undefined) return;
        updateDirty = true;
        const delay = updateThrottleMs - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };
      const handleAbort = (): void => {
        aborted = true;
        if (execution === undefined || execution.completedAt !== undefined) return;
        try {
          manager.signalExecution(execution, "SIGKILL");
        } catch (error) {
          abortSignalError = error instanceof Error
            ? error
            : new Error(String(error));
        }
      };

      onUpdate?.({ content: [], details: undefined });
      signal?.addEventListener("abort", handleAbort, { once: true });

      try {
        execution = await manager.startForeground(params.command, {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        unsubscribeOutput = manager.subscribeOutput(
          execution,
          scheduleOutputUpdate,
        );
        if (execution.outputStore.totalBytes > 0) scheduleOutputUpdate();
        if (signal?.aborted || aborted) handleAbort();

        const completion = await execution.completion;
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = snapshotOutput(execution.outputStore);
        const { text: outputText, details } = formatOutput(
          execution.outputStore,
          snapshot,
        );

        if (signal?.aborted || aborted) {
          const message = abortSignalError === undefined
            ? "Command aborted"
            : `Command aborted (${abortSignalError.message})`;
          throw new Error(appendStatus(outputText === "(no output)" ? "" : outputText, message));
        }
        if (completion.timedOut) {
          throw new Error(
            appendStatus(
              outputText === "(no output)" ? "" : outputText,
              `Command timed out after ${params.timeout} seconds`,
            ),
          );
        }
        if (completion.error !== undefined) {
          throw new Error(
            appendStatus(
              outputText === "(no output)" ? "" : outputText,
              `Command failed: ${completion.error.message}`,
            ),
            { cause: completion.error },
          );
        }
        if (completion.exitCode !== 0 && completion.exitCode !== null) {
          throw new Error(
            appendStatus(outputText, `Command exited with code ${completion.exitCode}`),
          );
        }
        return { content: [{ type: "text", text: outputText }], details };
      } finally {
        signal?.removeEventListener("abort", handleAbort);
        unsubscribeOutput?.();
        clearUpdateTimer();
      }
    },
  };
}

export function registerWaitBashTool(
  pi: ExtensionAPI,
  options: WaitBashToolOptions,
): void {
  pi.registerTool(createWaitBashTool(options));
}
