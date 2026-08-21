import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { ProcessManager } from "./process-manager";
import { registerBashTool } from "./tools/bash";
import { registerProcessKillTool } from "./tools/process-kill";
import { registerProcessListTool } from "./tools/process-list";
import { registerProcessReadTool } from "./tools/process-read";
import { registerProcessWriteTool } from "./tools/process-write";

export { OutputStore } from "./output-store";
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
export type {
  ManagedProcessOutputStatus,
  ManagedProcessStatus,
  ProcessToolOptions,
} from "./tools/process-utils";
export type {
  ByteRange,
  ForegroundExecution,
  ForegroundWaitOutcome,
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

    pi.on("session_start", async (_event, ctx) => {
      const next = createManager({
        cwd: ctx.cwd,
        sessionEnvironment: () => sessionEnvironment(ctx),
      });
      const previous = manager;
      manager = next;
      if (previous !== undefined) await previous.shutdown();
    });

    pi.on("session_shutdown", async () => {
      const current = manager;
      manager = undefined;
      if (current !== undefined) await current.shutdown();
    });
  };
}

/** Register the production managed-process bash override. */
export default createBackgroundProcessesExtension();
