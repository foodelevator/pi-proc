import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  ProcessStateFailure,
} from "./process-manager";
export {
  assertSupportedPlatform,
  createPiProcessEnvironment,
  POST_EXIT_PIPE_IDLE_MS,
  spawnShellProcess,
  UnsupportedPlatformError,
} from "./shell";
export type {
  ShellConfig,
  ShellProcessCompletion,
  SpawnedShellProcess,
  SpawnShellOptions,
  SupportedPlatform,
} from "./shell";
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
  ProcessSignalResult,
  PublicProcessMode,
  StartProcessOptions,
} from "./types";

/** Pi extension entry point. Tool and event registration is added in later stages. */
export default function backgroundProcesses(pi: ExtensionAPI): void {
  void pi;
}
