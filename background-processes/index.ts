import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  ProcessNotificationScheduler,
  registerProcessNotificationRenderer,
} from "./notification-scheduler";
import {
  createRuntimeEndingEntryData,
  PROCESS_RUNTIME_END_ENTRY_TYPE,
  reconstructProcessPersistence,
} from "./persistence";
import { ProcessManager } from "./process-manager";
import { registerBashTool } from "./tools/bash";
import { registerProcessKillTool } from "./tools/process-kill";
import { registerProcessListTool } from "./tools/process-list";
import { registerProcessReadTool } from "./tools/process-read";
import { registerProcessWriteTool } from "./tools/process-write";
import {
  installRunningProcessesWidget,
  type RunningProcessesWidgetController,
} from "./ui";

export { OutputStore } from "./output-store";
export {
  createRuntimeEndingEntryData,
  PROCESS_RUNTIME_END_ENTRY_TYPE,
  PROCESS_RUNTIME_END_ENTRY_VERSION,
  reconstructProcessPersistence,
  snapshotPersistedProcess,
} from "./persistence";
export type {
  PersistedManagedProcess,
  PersistedProcessOutputMetadata,
  ProcessPersistenceRecovery,
  ProcessRuntimeEndingEntryData,
  ProcessRuntimeShutdownReason,
} from "./persistence";
export {
  PROCESS_NOTIFICATION_MESSAGE_TYPE,
  PROCESS_NOTIFICATION_WINDOW_MS,
  ProcessNotificationScheduler,
  registerProcessNotificationRenderer,
} from "./notification-scheduler";
export type {
  JsonProcessCompletion,
  ProcessNotificationBatchDetails,
  ProcessNotificationEventType,
  ProcessNotificationItem,
  ProcessNotificationMessage,
  ProcessNotificationSchedulerOptions,
} from "./notification-scheduler";
export {
  isNormallyTerminatingSignal,
  normalizeSignal,
  ProcessLookupError,
  ProcessManager,
  ProcessSpawnError,
  ProcessStateError,
  SHUTDOWN_GRACE_MS,
  TERMINATING_SIGNAL_WAIT_MS,
} from "./process-manager";
export type {
  ProcessLookupFailure,
  ProcessManagerCallbacks,
  ProcessManagerEvent,
  ProcessManagerEventListener,
  ProcessManagerOptions,
  ProcessOutputListener,
  SignalProcessAndWaitOptions,
  ProcessStateFailure,
} from "./process-manager";
export {
  assertSupportedPlatform,
  createPiProcessEnvironment,
  killTrackedDetachedProcessGroups,
  POST_EXIT_PIPE_IDLE_MS,
  spawnShellProcess,
  UnsupportedPlatformError,
} from "./shell";
export type {
  DetachedProcessGroupTracker,
  ShellConfig,
  ShellProcessCompletion,
  SpawnedShellProcess,
  SpawnShellOptions,
  SupportedPlatform,
} from "./shell";
export {
  bashSchema,
  BASH_UPDATE_THROTTLE_MS,
  createBashTool,
  registerBashTool,
} from "./tools/bash";
export type {
  BackgroundBashToolDetails,
  BackgroundBashToolInput,
  BashProcessDescriptor,
  BashToolOptions,
} from "./tools/bash";
export {
  createProcessKillTool,
  platformSignalNames,
  processKillSchema,
  registerProcessKillTool,
} from "./tools/process-kill";
export type {
  ProcessKillToolDetails,
  ProcessKillToolInput,
} from "./tools/process-kill";
export {
  createProcessListTool,
  processListSchema,
  registerProcessListTool,
} from "./tools/process-list";
export type {
  ProcessListToolDetails,
  ProcessListToolInput,
} from "./tools/process-list";
export {
  createProcessReadTool,
  processReadSchema,
  registerProcessReadTool,
} from "./tools/process-read";
export type {
  ProcessReadToolDetails,
  ProcessReadToolInput,
} from "./tools/process-read";
export {
  createProcessWriteTool,
  processWriteSchema,
  registerProcessWriteTool,
} from "./tools/process-write";
export type {
  ProcessWriteToolDetails,
  ProcessWriteToolInput,
} from "./tools/process-write";
export {
  createRunningProcessesWidget,
  installRunningProcessesWidget,
  normalizeCommandLine,
  renderProcessNotificationMessage,
  RUNNING_PROCESSES_WIDGET_KEY,
} from "./ui";
export type { RunningProcessesWidgetController } from "./ui";
export type {
  HistoricalProcessStatus,
  ManagedProcessOutputStatus,
  ManagedProcessStatus,
  ProcessToolOptions,
} from "./tools/process-utils";
export { MAX_RESTORABLE_PROCESS_NUMBER } from "./types";
export type {
  ByteRange,
  ForegroundExecution,
  ForegroundWaitOutcome,
  HistoricalProcessOutputMetadata,
  HistoricalProcessRecord,
  ManagedProcessRecord,
  OutputCursorMetadata,
  OutputReadOptions,
  OutputReadResult,
  OutputStoreOptions,
  OutputStoreStats,
  OutputTruncation,
  OutputTruncationReason,
  PiSessionEnvironment,
  ProcessCompletion,
  ProcessExecution,
  ProcessMode,
  ProcessOutputSource,
  ProcessShutdownResult,
  ProcessShutdownSignalFailure,
  ProcessSignalResult,
  PublicProcessMode,
  StartProcessOptions,
} from "./types";

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function reportNotificationError(
  ctx: ExtensionContext,
  error: Error,
): void {
  const message = `Background process notification error: ${error.message}`;
  try {
    ctx.ui.notify(message, "error");
  } catch {
    try {
      process.stderr.write(`[pi-proc] ${message}\n`);
    } catch {
      // A stale UI and a closed stderr must not destabilize process cleanup.
    }
  }
}

function hasSessionEntries(ctx: ExtensionContext): boolean {
  return typeof (ctx.sessionManager as unknown as {
    getEntries?: unknown;
  }).getEntries === "function";
}

function sessionEntries(ctx: ExtensionContext): readonly unknown[] {
  const getEntries = (ctx.sessionManager as unknown as {
    getEntries?: () => readonly unknown[];
  }).getEntries;
  if (typeof getEntries !== "function") return [];
  try {
    const entries = getEntries.call(ctx.sessionManager);
    return Array.isArray(entries) ? entries : [];
  } catch {
    // A malformed/legacy embedding must not prevent session startup.
    return [];
  }
}

function sessionEnvironment(ctx: ExtensionContext) {
  const model = ctx.model;
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    ...(ctx.sessionManager.getSessionFile() === undefined
      ? {}
      : { sessionFile: ctx.sessionManager.getSessionFile() }),
    ...(model === undefined
      ? {}
      : { provider: model.provider, model: model.id }),
    ...(ctx.thinkingLevel === undefined
      ? {}
      : { reasoningLevel: ctx.thinkingLevel }),
  };
}

export interface BackgroundProcessesExtensionOptions {
  /** Test/embedding seam. Production creates the standard ProcessManager. */
  createManager?: (
    options: ConstructorParameters<typeof ProcessManager>[0],
  ) => ProcessManager;
}

/** Build the managed bash and process tools with one manager per Pi session runtime. */
export function createBackgroundProcessesExtension(
  options: BackgroundProcessesExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const createManager = options.createManager
    ?? ((managerOptions) => new ProcessManager(managerOptions));

  return (pi) => {
    let manager: ProcessManager | undefined;
    let notifications: ProcessNotificationScheduler | undefined;
    let runningProcessesWidget: RunningProcessesWidgetController | undefined;
    let runtimeId: string | undefined;

    registerProcessNotificationRenderer(pi);

    const toolOptions = { getManager: () => manager };
    registerBashTool(pi, toolOptions);
    registerProcessReadTool(pi, toolOptions);
    registerProcessWriteTool(pi, toolOptions);
    registerProcessKillTool(pi, toolOptions);
    registerProcessListTool(pi, toolOptions);

    pi.on("input", (event) => {
      if (
        event.streamingBehavior === "steer"
        && (event.source === "interactive" || event.source === "rpc")
      ) {
        manager?.detachAllForeground();
      }
      return { action: "continue" };
    });

    pi.on("turn_end", () => {
      notifications?.handleTurnEnd();
    });

    pi.on("agent_settled", () => {
      notifications?.handleAgentSettled();
    });

    pi.on("session_start", async (_event, ctx) => {
      const previous = manager;
      const previousNotifications = notifications;
      const previousWidget = runningProcessesWidget;
      runningProcessesWidget = undefined;
      previousWidget?.dispose();
      previousNotifications?.shutdown();
      previous?.beginShutdown();

      const recovery = reconstructProcessPersistence(sessionEntries(ctx));
      const next = createManager({
        cwd: ctx.cwd,
        sessionEnvironment: () => sessionEnvironment(ctx),
        initialProcessNumber: recovery.nextProcessNumber,
        onStarted: (execution) => {
          if (execution.id !== undefined) runningProcessesWidget?.refresh();
        },
        onPromoted: () => {
          runningProcessesWidget?.refresh();
        },
        onCompleted: (execution) => {
          if (execution.id !== undefined) runningProcessesWidget?.refresh();
        },
      });
      for (const historical of recovery.historical) {
        next.registerHistoricalProcess(historical);
      }
      const nextNotifications = new ProcessNotificationScheduler({
        eventSource: next,
        isIdle: () => ctx.isIdle(),
        sendMessage: (message, delivery) => {
          pi.sendMessage(message, delivery);
        },
        onError: (error) => {
          reportNotificationError(ctx, error);
        },
      });
      manager = next;
      notifications = nextNotifications;
      runningProcessesWidget = installRunningProcessesWidget(next, ctx);
      runtimeId = randomUUID();
      if (previous !== undefined) await previous.shutdown();
    });

    pi.on("session_shutdown", async (event, ctx) => {
      const current = manager;
      const currentNotifications = notifications;
      const currentWidget = runningProcessesWidget;
      const currentRuntimeId = runtimeId;
      manager = undefined;
      notifications = undefined;
      runningProcessesWidget = undefined;
      runtimeId = undefined;

      // No process event, retry timer, or stale session callback may run after
      // persistence begins. /tree emits neither shutdown nor start and therefore
      // intentionally leaves this runtime untouched.
      currentWidget?.dispose();
      currentNotifications?.shutdown();
      current?.beginShutdown();

      let persistenceError: unknown;
      if (
        current !== undefined
        && current.records.length > 0
        && currentRuntimeId !== undefined
        && hasSessionEntries(ctx)
      ) {
        const appendEntry = (pi as unknown as {
          appendEntry?: ExtensionAPI["appendEntry"];
        }).appendEntry;
        if (typeof appendEntry === "function") {
          try {
            appendEntry.call(
              pi,
              PROCESS_RUNTIME_END_ENTRY_TYPE,
              createRuntimeEndingEntryData(
                currentRuntimeId,
                event.reason,
                current.records,
                event.targetSessionFile === undefined
                  ? {}
                  : { targetSessionFile: event.targetSessionFile },
              ),
            );
          } catch (error) {
            persistenceError = error;
          }
        }
      }

      let shutdownError: unknown;
      try {
        if (current !== undefined) await current.shutdown();
      } catch (error) {
        shutdownError = error;
      }
      if (shutdownError !== undefined && persistenceError !== undefined) {
        throw new AggregateError(
          [persistenceError, shutdownError],
          "Failed to persist and shut down managed processes",
        );
      }
      if (shutdownError !== undefined) throw asError(shutdownError);
      if (persistenceError !== undefined) throw asError(persistenceError);
    });
  };
}

/** Register the production managed-process bash override. */
export default createBackgroundProcessesExtension();
