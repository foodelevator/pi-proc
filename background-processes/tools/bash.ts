import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type BashToolDetails,
  type ExtensionAPI,
  type ToolDefinition,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { OutputStore } from "../output-store";
import type { ProcessManager } from "../process-manager";
import type {
  ForegroundExecution,
  ManagedProcessRecord,
  OutputReadResult,
  PublicProcessMode,
} from "../types";
import { renderBashCall, renderBashResult } from "../ui";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
export const BASH_UPDATE_THROTTLE_MS = 100;
const BASH_SNAPSHOT_TAIL_BYTES = DEFAULT_MAX_BYTES * 4;

export const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  mode: Type.Optional(
    StringEnum(["wait", "background", "monitor"] as const, {
      description:
        "Execution mode (default: wait). Background and monitor return a managed process ID immediately for use with process_read, process_write, process_kill, and process_list.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout)",
    }),
  ),
});

export type BackgroundBashToolInput = Static<typeof bashSchema>;

export interface BashProcessDescriptor {
  kind: "started";
  /** Present when a wait was converted to background by a steering message. */
  reason?: "detached_by_steering";
  id: string;
  mode: PublicProcessMode;
  command: string;
  cwd: string;
  pid: number;
  startedAt: number;
  timeoutSeconds?: number;
}

/** Details remain compatible with Pi's built-in bash renderer and persistence. */
export interface BackgroundBashToolDetails extends BashToolDetails {
  process?: BashProcessDescriptor;
  /** Combined stdout/stderr unread when a foreground wait was detached. */
  output?: OutputReadResult;
}

export interface BashToolOptions {
  getManager: () => ProcessManager | undefined;
  /**
   * Consume a turn-scoped steer that arrived before this wait finished
   * spawning. Active waits are detached directly by the input handler.
   */
  consumeSteeringDetachment?: (toolCallId: string) => boolean;
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
  const tail = truncateTail(
    output.snapshotTextTail(BASH_SNAPSHOT_TAIL_BYTES),
    { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES },
  );
  const truncated = output.totalLines > DEFAULT_MAX_LINES
    || output.totalBytes > DEFAULT_MAX_BYTES;
  const truncation: TruncationResult = {
    ...tail,
    truncated,
    truncatedBy: truncated
      ? tail.truncatedBy
        ?? (output.totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines")
      : null,
    totalLines: output.totalLines,
    totalBytes: output.totalBytes,
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  };
  return {
    content: truncation.content,
    truncation,
    ...(output.spillPath === undefined
      ? {}
      : { fullOutputPath: output.spillPath }),
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

function processDescriptor(
  record: ManagedProcessRecord,
  timeoutSeconds: number | undefined,
  reason?: "detached_by_steering",
): BashProcessDescriptor {
  return {
    kind: "started",
    ...(reason === undefined ? {} : { reason }),
    id: record.id,
    mode: record.mode,
    command: record.command,
    cwd: record.cwd,
    pid: record.pid,
    startedAt: record.startedAt,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

function startedProcessResult(
  record: ManagedProcessRecord,
  timeoutSeconds: number | undefined,
): {
  content: [{ type: "text"; text: string }];
  details: BackgroundBashToolDetails;
} {
  const timeoutText = timeoutSeconds === undefined
    ? ""
    : ` Timeout: ${timeoutSeconds} seconds.`;
  return {
    content: [{
      type: "text",
      text:
        `Started ${record.mode} process \`${record.id}\` (PID ${record.pid}).${timeoutText}`,
    }],
    details: { process: processDescriptor(record, timeoutSeconds) },
  };
}

function detachedProcessResult(
  record: ManagedProcessRecord,
  timeoutSeconds: number | undefined,
  output: OutputReadResult,
): {
  content: [{ type: "text"; text: string }];
  details: BackgroundBashToolDetails;
} {
  const timeoutText = timeoutSeconds === undefined
    ? ""
    : ` Timeout remains active at ${timeoutSeconds} seconds.`;
  const outputText = output.content.length === 0
    ? ""
    : `\n\nOutput so far:\n${output.content}`;
  const omittedText = output.omittedRanges.length === 0
    ? ""
    : `\n\n[Showing combined output bytes ${output.returnedRange.start}-${output.returnedRange.end} of ${output.totalBytes}; omitted ${output.truncation.omittedBytes} earlier bytes.]`;
  return {
    content: [{
      type: "text",
      text:
        `Detached foreground command as background process \`${record.id}\` (PID ${record.pid}) due to steering.${timeoutText}${outputText}${omittedText}`,
    }],
    details: {
      process: processDescriptor(
        record,
        timeoutSeconds,
        "detached_by_steering",
      ),
      output,
    },
  };
}

export function createBashTool(
  options: BashToolOptions,
): ToolDefinition<typeof bashSchema, BackgroundBashToolDetails | undefined> {
  const updateThrottleMs = options.updateThrottleMs
    ?? BASH_UPDATE_THROTTLE_MS;
  if (!Number.isFinite(updateThrottleMs) || updateThrottleMs < 0) {
    throw new RangeError("updateThrottleMs must be a non-negative finite number");
  }

  return {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Mode defaults to wait. Wait returns stdout and stderr, truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first), and streams updates. If the user sends a steering message while a wait is running or pending in the current assistant turn, the wait is converted to a managed background process and returns its output so far. Background and monitor start a retained managed process and return its process ID immediately; use process_read, process_write, process_kill, and process_list to manage it. Background processes automatically notify on completion; monitor processes also notify on stdout activity, including combined unread stderr in the same globally batched message. If wait output is truncated, full output is saved to a temp file. Optional timeouts apply in every mode. Shell-level &, nohup, and programs self-daemonization are not integrated: prefer to use mode instead.`,
    promptSnippet:
      "Execute bash commands, optionally as managed background or monitor processes",
    promptGuidelines: [
      "Inspect PI_* environment variables if you need current model and session details.",
      "Use bash mode background or monitor instead of shell-level &, nohup, or daemonization, then manage the returned ID with process_read, process_write, process_kill, and process_list.",
    ],
    parameters: bashSchema,
    renderCall: renderBashCall,
    renderResult: renderBashResult,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mode = params.mode ?? "wait";
      const timeoutMs = resolveTimeoutMs(params.timeout);
      if (signal?.aborted) throw new Error("Command aborted");
      if (
        mode !== "wait"
        && ctx?.mode !== "tui"
        && ctx?.mode !== "rpc"
      ) {
        throw new Error(
          `Bash mode \`${mode}\` is available only in TUI and RPC modes; current mode is \`${ctx?.mode}\`. Use mode \`wait\` instead.`,
        );
      }

      const manager = options.getManager();
      if (manager === undefined) {
        throw new Error("Bash process manager is unavailable for this session");
      }
      if (mode !== "wait") {
        const record = await manager.startManaged(params.command, {
          mode,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        return startedProcessResult(record, params.timeout);
      }

      let execution: ForegroundExecution | undefined;
      let unsubscribeOutput: (() => void) | undefined;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;
      let abortRequested = false;
      let abortListenerAttached = false;
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
      const removeAbortListener = (): void => {
        if (!abortListenerAttached) return;
        signal?.removeEventListener("abort", handleAbort);
        abortListenerAttached = false;
      };
      const handleAbort = (): void => {
        abortRequested = true;
        if (execution === undefined) return;
        try {
          manager.abortForeground(execution);
        } catch (error) {
          abortSignalError = error instanceof Error
            ? error
            : new Error(String(error));
        }
      };

      onUpdate?.({ content: [], details: undefined });
      signal?.addEventListener("abort", handleAbort, { once: true });
      abortListenerAttached = signal !== undefined;

      try {
        execution = await manager.startForeground(params.command, {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        if (
          options.consumeSteeringDetachment?.(toolCallId) === true
          && manager.foregroundExecutions.includes(execution)
        ) {
          // Steering may have arrived while the model was still producing this
          // tool call or while startForeground was spawning the process.
          manager.promoteForeground(execution);
        }
        unsubscribeOutput = manager.subscribeOutput(
          execution,
          scheduleOutputUpdate,
        );
        if (execution.outputStore.totalBytes > 0) scheduleOutputUpdate();
        if (signal?.aborted || abortRequested) handleAbort();

        const outcome = await execution.waitOutcome;
        if (outcome.type === "detached") {
          // Promotion wins atomically in the manager. Disable the tool's signal
          // before yielding the detached result so later agent abort cannot kill it.
          removeAbortListener();
          unsubscribeOutput?.();
          unsubscribeOutput = undefined;
          clearUpdateTimer();
          emitOutputUpdate();
          return detachedProcessResult(
            outcome.process,
            params.timeout,
            outcome.process.outputStore.readImplicit(),
          );
        }

        const completion = outcome.type === "completed"
          ? outcome.completion
          : await execution.completion;
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = snapshotOutput(execution.outputStore);
        const { text: outputText, details } = formatOutput(
          execution.outputStore,
          snapshot,
        );

        if (outcome.type === "aborted") {
          const message = abortSignalError === undefined
            ? "Command aborted"
            : `Command aborted (${abortSignalError.message})`;
          throw new Error(appendStatus(outputText === "(no output)" ? "" : outputText, message));
        }
        if (outcome.type === "timed-out" || completion.timedOut) {
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
        removeAbortListener();
        unsubscribeOutput?.();
        clearUpdateTimer();
      }
    },
  };
}

export function registerBashTool(
  pi: ExtensionAPI,
  options: BashToolOptions,
): void {
  pi.registerTool(createBashTool(options));
}
