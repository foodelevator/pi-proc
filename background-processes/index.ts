import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { ProcessManager } from "./process-manager";
import { registerBashTool } from "./tools/bash";

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
  createWaitBashTool,
  registerBashTool,
  registerWaitBashTool,
} from "./tools/bash";
export type {
  BackgroundBashToolDetails,
  BackgroundBashToolInput,
  BashProcessDescriptor,
  BashToolOptions,
  WaitBashToolOptions,
} from "./tools/bash";
export type {
  ByteRange,
  ForegroundExecution,
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

/** Build the bash override with one manager per Pi session runtime. */
export function createBackgroundProcessesExtension(
  options: BackgroundProcessesExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const createManager = options.createManager
    ?? ((managerOptions) => new ProcessManager(managerOptions));

  return (pi) => {
    let manager: ProcessManager | undefined;

    registerBashTool(pi, { getManager: () => manager });

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
