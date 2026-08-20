import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { ProcessManager } from "./process-manager";
import { registerWaitBashTool } from "./tools/bash";

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
  createWaitBashTool,
  registerWaitBashTool,
} from "./tools/bash";
export type {
  BackgroundBashToolInput,
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

/** Register the wait-compatible override and one manager per Pi session runtime. */
export default function backgroundProcesses(pi: ExtensionAPI): void {
  let manager: ProcessManager | undefined;

  registerWaitBashTool(pi, { getManager: () => manager });

  pi.on("session_start", async (_event, ctx) => {
    const previous = manager;
    manager = undefined;
    if (previous !== undefined) await previous.shutdown();
    manager = new ProcessManager({
      cwd: ctx.cwd,
      sessionEnvironment: () => sessionEnvironment(ctx),
    });
  });

  pi.on("session_shutdown", async () => {
    const current = manager;
    manager = undefined;
    if (current !== undefined) await current.shutdown();
  });
}
