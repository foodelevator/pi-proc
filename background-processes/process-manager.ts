import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";

import { OutputStore } from "./output-store";
import {
  assertSupportedPlatform,
  createPiProcessEnvironment,
  spawnShellProcess,
  type DetachedProcessGroupTracker,
  type ShellConfig,
  type SupportedPlatform,
} from "./shell";
import type {
  ForegroundExecution,
  HistoricalProcessRecord,
  ManagedProcessRecord,
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

export const TERMINATING_SIGNAL_WAIT_MS = 2_000;
export const SHUTDOWN_GRACE_MS = 500;
const MAX_TIMER_MS = 2_147_483_647;

const TERMINATING_SIGNALS = new Set<string>([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGABRT",
  "SIGFPE",
  "SIGKILL",
  "SIGSEGV",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGUSR1",
  "SIGUSR2",
  "SIGBUS",
  "SIGEMT",
  "SIGIOT",
  "SIGIO",
  "SIGPOLL",
  "SIGPROF",
  "SIGSYS",
  "SIGTRAP",
  "SIGSTKFLT",
  "SIGPWR",
  "SIGVTALRM",
  "SIGXCPU",
  "SIGXFSZ",
]);

export type ProcessLookupFailure = "unknown" | "historical";
export type ProcessStateFailure =
  | "active"
  | "completed"
  | "stdin-closed"
  | "not-foreground"
  | "manager-closed";

export class ProcessLookupError extends Error {
  constructor(
    readonly id: string,
    readonly kind: ProcessLookupFailure,
    historicalMessage?: string,
  ) {
    super(
      kind === "historical"
        ? historicalMessage
          ?? `Process \`${id}\` belonged to a previous runtime`
        : `Unknown process ID: ${id}`,
    );
    this.name = "ProcessLookupError";
  }
}

export class ProcessStateError extends Error {
  constructor(
    readonly kind: ProcessStateFailure,
    message: string,
  ) {
    super(message);
    this.name = "ProcessStateError";
  }
}

export class ProcessSpawnError extends Error {
  constructor(command: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to spawn command \`${command}\`: ${reason}`, { cause });
    this.name = "ProcessSpawnError";
  }
}

export type ProcessOutputListener = (
  source: ProcessOutputSource,
  chunk: Buffer,
) => void;

export interface ProcessManagerCallbacks {
  onOutput?: (
    execution: ProcessExecution,
    source: ProcessOutputSource,
    chunk: Buffer,
  ) => void;
  /** Called only for stdout, after the chunk is in the combined output store. */
  onStdoutActivity?: (execution: ProcessExecution, chunk: Buffer) => void;
  onStarted?: (execution: ProcessExecution) => void;
  onPromoted?: (record: ManagedProcessRecord) => void;
  onCompleted?: (
    execution: ProcessExecution,
    completion: ProcessCompletion,
  ) => void;
  onCallbackError?: (error: Error) => void;
}

export interface ProcessManagerOptions extends ProcessManagerCallbacks {
  cwd?: string;
  platform?: NodeJS.Platform;
  shellPath?: string;
  /** Test seam; production uses Pi's exported getShellConfig(). */
  shellConfig?: ShellConfig;
  baseEnvironment?: NodeJS.ProcessEnv;
  sessionEnvironment?:
    | PiSessionEnvironment
    | (() => PiSessionEnvironment);
  outputStoreFactory?: () => OutputStore;
  pipeIdleMs?: number;
  /** Test/custom-runtime seam; defaults to shell.ts process-exit tracking. */
  detachedProcessGroupTracker?: DetachedProcessGroupTracker;
  terminatingSignalWaitMs?: number;
  shutdownGraceMs?: number;
  shutdownForceWaitMs?: number;
  initialProcessNumber?: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface InternalProcess extends ProcessExecution {
  id?: string;
  mode: ProcessMode;
  child: ChildProcessWithoutNullStreams;
  detachment: Promise<ManagedProcessRecord>;
  resolveDetachment: (record: ManagedProcessRecord) => void;
  resolveCompletion: (completion: ProcessCompletion) => void;
  timeoutHandle?: NodeJS.Timeout;
  stdinQueue: Promise<void>;
  tracked: boolean;
  completionResult?: ProcessCompletion;
  completionNotified: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function requireTimer(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new RangeError(
      `${name} must be greater than 0 and no more than ${MAX_TIMER_MS} milliseconds`,
    );
  }
  return value;
}

function requireNonNegativeTimer(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new RangeError(
      `${name} must be between 0 and ${MAX_TIMER_MS} milliseconds`,
    );
  }
  return value;
}

function requireProcessNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("initialProcessNumber must be a positive safe integer");
  }
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function normalizeSignal(signal: string): NodeJS.Signals {
  const normalized = signal.toUpperCase().startsWith("SIG")
    ? signal.toUpperCase()
    : `SIG${signal.toUpperCase()}`;
  if (!(normalized in osConstants.signals)) {
    throw new RangeError(`Unsupported signal on this platform: ${signal}`);
  }
  return normalized as NodeJS.Signals;
}

export function isNormallyTerminatingSignal(
  signal: string,
  platform: SupportedPlatform = process.platform as SupportedPlatform,
): boolean {
  const normalized = normalizeSignal(signal);
  if (normalized === "SIGIO" && platform === "darwin") return false;
  return TERMINATING_SIGNALS.has(normalized);
}

function callSafely(
  callbackError: ((error: Error) => void) | undefined,
  callback: (() => void) | undefined,
): void {
  if (callback === undefined) return;
  try {
    callback();
  } catch (error) {
    try {
      callbackError?.(asError(error));
    } catch {
      // A reporting callback must not destabilize process supervision either.
    }
  }
}

async function writeChunk(
  child: ChildProcessWithoutNullStreams,
  data: string,
): Promise<void> {
  if (data.length === 0) return;
  const stdin = child.stdin;
  await new Promise<void>((resolve, reject) => {
    let callbackDone = false;
    let drainDone = true;
    let settled = false;

    const cleanup = (): void => {
      stdin.removeListener("error", handleError);
      stdin.removeListener("close", handleClose);
      stdin.removeListener("drain", handleDrain);
    };
    const finish = (): void => {
      if (settled || !callbackDone || !drainDone) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleError = (error: Error): void => {
      fail(error);
    };
    const handleClose = (): void => {
      fail(new Error("Process stdin closed before the write completed"));
    };
    const handleDrain = (): void => {
      drainDone = true;
      finish();
    };

    stdin.once("error", handleError);
    stdin.once("close", handleClose);
    const accepted = stdin.write(data, "utf8", (error?: Error | null) => {
      if (error) {
        fail(error);
        return;
      }
      callbackDone = true;
      finish();
    });
    if (!accepted) {
      drainDone = false;
      stdin.once("drain", handleDrain);
    }
  });
}

async function closeStdin(child: ChildProcessWithoutNullStreams): Promise<void> {
  const stdin = child.stdin;
  if (stdin.destroyed || stdin.writableEnded) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stdin.removeListener("error", handleError);
      stdin.removeListener("close", handleClose);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const handleError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleClose = (): void => {
      if (!stdin.writableFinished) {
        handleError(new Error("Process stdin closed before EOF was flushed"));
      }
    };

    stdin.once("error", handleError);
    stdin.once("close", handleClose);
    stdin.end(finish);
  });
}

export class ProcessManager {
  readonly #platform: SupportedPlatform;
  readonly #cwd: string;
  readonly #shellPath: string | undefined;
  readonly #shellConfig: ShellConfig | undefined;
  readonly #baseEnvironment: NodeJS.ProcessEnv;
  readonly #sessionEnvironment:
    | PiSessionEnvironment
    | (() => PiSessionEnvironment);
  readonly #outputStoreFactory: () => OutputStore;
  readonly #pipeIdleMs: number | undefined;
  readonly #detachedProcessGroupTracker: DetachedProcessGroupTracker | undefined;
  readonly #terminatingSignalWaitMs: number;
  readonly #shutdownGraceMs: number;
  readonly #shutdownForceWaitMs: number;
  readonly #callbacks: ProcessManagerCallbacks;

  readonly #records = new Map<string, InternalProcess>();
  readonly #foreground = new Set<InternalProcess>();
  readonly #pendingExecutions = new Set<InternalProcess>();
  readonly #pendingStarts = new Set<
    Promise<ForegroundExecution | ManagedProcessRecord>
  >();
  readonly #owned = new WeakSet<ProcessExecution>();
  readonly #outputListeners = new WeakMap<
    ProcessExecution,
    Set<ProcessOutputListener>
  >();
  readonly #historical = new Map<string, HistoricalProcessRecord>();
  #nextProcessNumber: number;
  #acceptingStarts = true;
  #shutdownPromise: Promise<ProcessShutdownResult> | undefined;

  constructor(options: ProcessManagerOptions = {}) {
    const platform = options.platform ?? process.platform;
    assertSupportedPlatform(platform);
    this.#platform = platform;
    this.#cwd = options.cwd ?? process.cwd();
    this.#shellPath = options.shellPath;
    this.#shellConfig = options.shellConfig;
    this.#baseEnvironment = options.baseEnvironment ?? process.env;
    this.#sessionEnvironment = options.sessionEnvironment ?? {};
    this.#outputStoreFactory = options.outputStoreFactory
      ?? (() => new OutputStore({ tempFilePrefix: "pibg-process" }));
    this.#pipeIdleMs = options.pipeIdleMs;
    this.#detachedProcessGroupTracker = options.detachedProcessGroupTracker;
    this.#terminatingSignalWaitMs = requireNonNegativeTimer(
      options.terminatingSignalWaitMs ?? TERMINATING_SIGNAL_WAIT_MS,
      "terminatingSignalWaitMs",
    );
    this.#shutdownGraceMs = requireNonNegativeTimer(
      options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS,
      "shutdownGraceMs",
    );
    this.#shutdownForceWaitMs = requireNonNegativeTimer(
      options.shutdownForceWaitMs ?? TERMINATING_SIGNAL_WAIT_MS,
      "shutdownForceWaitMs",
    );
    this.#nextProcessNumber = requireProcessNumber(
      options.initialProcessNumber ?? 1,
    );
    this.#callbacks = options;
  }

  get platform(): SupportedPlatform {
    return this.#platform;
  }

  get isShuttingDown(): boolean {
    return !this.#acceptingStarts;
  }

  get records(): readonly ManagedProcessRecord[] {
    return [...this.#records.values()] as ManagedProcessRecord[];
  }

  get activeRecords(): readonly ManagedProcessRecord[] {
    return [...this.#records.values()].filter(
      (record) => record.completedAt === undefined,
    ) as ManagedProcessRecord[];
  }

  get foregroundExecutions(): readonly ForegroundExecution[] {
    return [...this.#foreground] as ForegroundExecution[];
  }

  /** Subscribe to combined output after it has been appended to the store. */
  subscribeOutput(
    execution: ProcessExecution,
    listener: ProcessOutputListener,
  ): () => void {
    if (!this.#owned.has(execution)) {
      throw new ProcessStateError(
        "not-foreground",
        "Execution is not owned by this manager",
      );
    }
    const listeners = this.#outputListeners.get(execution) ?? new Set();
    listeners.add(listener);
    this.#outputListeners.set(execution, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#outputListeners.delete(execution);
    };
  }

  start(
    command: string,
    options: StartProcessOptions & { mode: PublicProcessMode },
  ): Promise<ManagedProcessRecord>;
  start(
    command: string,
    options?: StartProcessOptions & { mode?: "wait" },
  ): Promise<ForegroundExecution>;
  start(
    command: string,
    options: StartProcessOptions = {},
  ): Promise<ForegroundExecution | ManagedProcessRecord> {
    const operation = this.#startProcess(command, options);
    this.#pendingStarts.add(operation);
    const removePending = (): void => {
      this.#pendingStarts.delete(operation);
    };
    void operation.then(removePending, removePending);
    return operation;
  }

  async #startProcess(
    command: string,
    options: StartProcessOptions,
  ): Promise<ForegroundExecution | ManagedProcessRecord> {
    const mode = options.mode ?? "wait";
    const internal = await this.#spawn(command, mode, options);
    if (mode === "wait") {
      if (internal.completedAt === undefined) this.#foreground.add(internal);
      this.#track(internal);
      return internal as ForegroundExecution;
    }

    const record = this.#makePublic(internal, mode);
    this.#track(record as InternalProcess);
    return record;
  }

  startForeground(
    command: string,
    options: Omit<StartProcessOptions, "mode"> = {},
  ): Promise<ForegroundExecution> {
    return this.start(command, { ...options, mode: "wait" });
  }

  startManaged(
    command: string,
    options: Omit<StartProcessOptions, "mode"> & { mode?: PublicProcessMode } = {},
  ): Promise<ManagedProcessRecord> {
    return this.start(command, {
      ...options,
      mode: options.mode ?? "background",
    });
  }

  promoteForeground(
    execution: ForegroundExecution,
    mode: PublicProcessMode = "background",
  ): ManagedProcessRecord {
    const internal = execution as InternalProcess;
    if (!this.#owned.has(execution)) {
      throw new ProcessStateError(
        "not-foreground",
        "Execution is not owned by this manager",
      );
    }
    if (internal.completedAt !== undefined) {
      throw new ProcessStateError(
        "completed",
        "Cannot detach a completed foreground process",
      );
    }
    if (!this.#foreground.has(internal)) {
      throw new ProcessStateError(
        "not-foreground",
        "Execution is not an active foreground process",
      );
    }

    this.#foreground.delete(internal);
    const record = this.#makePublic(internal, mode);
    internal.resolveDetachment(record);
    callSafely(this.#callbacks.onCallbackError, () => {
      this.#callbacks.onPromoted?.(record);
    });
    return record;
  }

  detachAllForeground(): ManagedProcessRecord[] {
    const detached: ManagedProcessRecord[] = [];
    for (const execution of [...this.#foreground]) {
      if (execution.completedAt === undefined) {
        detached.push(
          this.promoteForeground(execution as ForegroundExecution),
        );
      }
    }
    return detached;
  }

  getProcess(id: string): ManagedProcessRecord {
    const record = this.#records.get(id);
    if (record !== undefined) return record as ManagedProcessRecord;
    const historical = this.#historical.get(id);
    if (historical !== undefined) {
      throw new ProcessLookupError(id, "historical", historical.message);
    }
    throw new ProcessLookupError(id, "unknown");
  }

  getActiveProcess(id: string): ManagedProcessRecord {
    const record = this.getProcess(id);
    if (record.completedAt !== undefined) {
      throw new ProcessStateError(
        "completed",
        `Process \`${id}\` has already completed`,
      );
    }
    return record;
  }

  getCompletedProcess(id: string): ManagedProcessRecord {
    const record = this.getProcess(id);
    if (record.completedAt === undefined) {
      throw new ProcessStateError(
        "active",
        `Process \`${id}\` is still active`,
      );
    }
    return record;
  }

  registerHistoricalProcess(record: HistoricalProcessRecord): void {
    if (this.#records.has(record.id)) return;
    this.#historical.set(record.id, record);

    const match = /^p([1-9]\d*)$/.exec(record.id);
    if (match === null) return;
    const processNumber = Number(match[1]);
    if (!Number.isSafeInteger(processNumber)) return;
    if (processNumber === Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Historical process ID is too large: ${record.id}`);
    }
    this.#nextProcessNumber = Math.max(
      this.#nextProcessNumber,
      processNumber + 1,
    );
  }

  get historicalRecords(): readonly HistoricalProcessRecord[] {
    return [...this.#historical.values()];
  }

  async writeProcess(
    id: string,
    data?: string,
    close = false,
  ): Promise<void> {
    const record = this.getActiveProcess(id) as InternalProcess;
    if (record.stdinClosed) {
      throw new ProcessStateError(
        "stdin-closed",
        `Process \`${id}\` stdin is closed`,
      );
    }
    if (close) record.stdinClosed = true;

    const operation = record.stdinQueue.then(async () => {
      if (data !== undefined) await writeChunk(record.child, data);
      if (close) await closeStdin(record.child);
    });
    record.stdinQueue = operation.catch(() => {
      if (record.child.stdin.destroyed) record.stdinClosed = true;
    });
    return operation;
  }

  signalProcess(id: string, signal = "SIGTERM"): boolean {
    return this.signalExecution(this.getActiveProcess(id), signal);
  }

  signalExecution(execution: ProcessExecution, signal = "SIGTERM"): boolean {
    if (!this.#owned.has(execution)) {
      throw new ProcessStateError(
        "not-foreground",
        "Execution is not owned by this manager",
      );
    }
    const normalized = normalizeSignal(signal);
    const internal = execution as InternalProcess;
    if (internal.completedAt !== undefined) return false;
    try {
      process.kill(-internal.pid, normalized);
      internal.lastSignal = normalized;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  async signalProcessAndWait(
    id: string,
    signal = "SIGTERM",
  ): Promise<ProcessSignalResult> {
    const record = this.getActiveProcess(id);
    const normalized = normalizeSignal(signal);
    const sent = this.signalExecution(record, normalized);
    if (!isNormallyTerminatingSignal(normalized, this.#platform)) {
      return { signal: normalized, sent, exited: false };
    }

    const completion = await this.waitForCompletion(
      record,
      this.#terminatingSignalWaitMs,
    );
    return {
      signal: normalized,
      sent,
      exited: completion !== undefined,
      ...(completion === undefined ? {} : { completion }),
    };
  }

  async waitForCompletion(
    execution: ProcessExecution,
    timeoutMs: number,
  ): Promise<ProcessCompletion | undefined> {
    if (!this.#owned.has(execution)) {
      throw new ProcessStateError(
        "not-foreground",
        "Execution is not owned by this manager",
      );
    }
    const delay = requireNonNegativeTimer(timeoutMs, "timeoutMs");
    if (execution.completedAt !== undefined) return execution.completion;
    if (delay === 0) return undefined;

    return new Promise<ProcessCompletion | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), delay);
      void execution.completion.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  shutdown(): Promise<ProcessShutdownResult> {
    this.#shutdownPromise ??= this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #spawn(
    command: string,
    mode: ProcessMode,
    options: StartProcessOptions,
  ): Promise<InternalProcess> {
    if (!this.#acceptingStarts) {
      throw new ProcessStateError(
        "manager-closed",
        "Process manager is shutting down and cannot start new commands",
      );
    }
    const timeoutMs = requireTimer(options.timeoutMs, "timeoutMs");
    const cwd = options.cwd ?? this.#cwd;
    try {
      await access(cwd, fsConstants.F_OK);
    } catch {
      throw new ProcessSpawnError(
        command,
        new Error(`Working directory does not exist: ${cwd}`),
      );
    }
    if (!this.#acceptingStarts) {
      throw new ProcessStateError(
        "manager-closed",
        "Process manager shut down while the command was starting",
      );
    }

    const sessionEnvironment = options.sessionEnvironment
      ?? (typeof this.#sessionEnvironment === "function"
        ? this.#sessionEnvironment()
        : this.#sessionEnvironment);
    const env = createPiProcessEnvironment(
      sessionEnvironment,
      options.env ?? this.#baseEnvironment,
    );
    const outputStore = this.#outputStoreFactory();
    const completionDeferred = deferred<ProcessCompletion>();
    const detachmentDeferred = deferred<ManagedProcessRecord>();
    const processHolder: { current?: InternalProcess } = {};

    let shell;
    try {
      shell = spawnShellProcess(command, {
        cwd,
        env,
        outputStore,
        ...(this.#shellPath === undefined ? {} : { shellPath: this.#shellPath }),
        ...(this.#shellConfig === undefined
          ? {}
          : { shellConfig: this.#shellConfig }),
        ...(this.#pipeIdleMs === undefined
          ? {}
          : { pipeIdleMs: this.#pipeIdleMs }),
        ...(this.#detachedProcessGroupTracker === undefined
          ? {}
          : {
              detachedProcessGroupTracker: this.#detachedProcessGroupTracker,
            }),
        onOutput: (source, chunk) => {
          const execution = processHolder.current;
          if (execution !== undefined) {
            callSafely(this.#callbacks.onCallbackError, () => {
              this.#callbacks.onOutput?.(execution, source, chunk);
            });
            this.#notifyOutputListeners(execution, source, chunk);
          }
        },
        onStdoutActivity: (chunk) => {
          const execution = processHolder.current;
          if (execution !== undefined) {
            callSafely(this.#callbacks.onCallbackError, () => {
              this.#callbacks.onStdoutActivity?.(execution, chunk);
            });
          }
        },
        onCallbackError: this.#callbacks.onCallbackError,
      });
    } catch (error) {
      outputStore.close();
      throw new ProcessSpawnError(command, error);
    }

    const internal: InternalProcess = {
      command,
      cwd,
      mode,
      child: shell.child,
      pid: 0,
      startedAt: Date.now(),
      timedOut: false,
      stdinClosed: false,
      outputStore,
      get deliveredCursor() {
        return outputStore.deliveredCursor;
      },
      completion: completionDeferred.promise,
      detachment: detachmentDeferred.promise,
      resolveDetachment: detachmentDeferred.resolve,
      resolveCompletion: completionDeferred.resolve,
      stdinQueue: Promise.resolve(),
      tracked: false,
      completionNotified: false,
    };
    processHolder.current = internal;
    this.#owned.add(internal);
    void shell.completion.then((result) => {
      this.#complete(internal, result);
    });

    try {
      internal.pid = await shell.spawned;
    } catch (error) {
      throw new ProcessSpawnError(command, error);
    }
    if (internal.completedAt === undefined) {
      this.#pendingExecutions.add(internal);
    }
    if (!this.#acceptingStarts) {
      throw new ProcessStateError(
        "manager-closed",
        "Process manager shut down while the command was spawning",
      );
    }

    if (timeoutMs !== undefined && internal.completedAt === undefined) {
      internal.timeoutHandle = setTimeout(() => {
        if (internal.completedAt !== undefined) return;
        internal.timedOut = true;
        try {
          this.signalExecution(internal, "SIGKILL");
        } catch (error) {
          callSafely(this.#callbacks.onCallbackError, () => {
            throw error;
          });
        }
      }, timeoutMs);
      internal.timeoutHandle.unref();
    }
    this.#pendingExecutions.delete(internal);
    return internal;
  }

  #notifyOutputListeners(
    execution: InternalProcess,
    source: ProcessOutputSource,
    chunk: Buffer,
  ): void {
    const listeners = this.#outputListeners.get(execution);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      callSafely(this.#callbacks.onCallbackError, () => {
        listener(source, chunk);
      });
    }
  }

  #makePublic(
    internal: InternalProcess,
    mode: PublicProcessMode,
  ): ManagedProcessRecord {
    internal.id = `p${this.#nextProcessNumber++}`;
    internal.mode = mode;
    this.#records.set(internal.id, internal);
    return internal as ManagedProcessRecord;
  }

  #complete(
    internal: InternalProcess,
    result: {
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
      error?: Error;
    },
  ): void {
    if (internal.completedAt !== undefined) return;
    if (internal.timeoutHandle !== undefined) {
      clearTimeout(internal.timeoutHandle);
      internal.timeoutHandle = undefined;
    }
    internal.stdinClosed = true;
    internal.completedAt = Date.now();
    internal.exitCode = result.exitCode;
    internal.exitSignal = result.exitSignal;
    this.#foreground.delete(internal);
    this.#pendingExecutions.delete(internal);

    const completion: ProcessCompletion = {
      completedAt: internal.completedAt,
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      timedOut: internal.timedOut,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    internal.completionResult = completion;
    internal.resolveCompletion(completion);
    this.#notifyCompletion(internal);
  }

  #track(internal: InternalProcess): void {
    internal.tracked = true;
    callSafely(this.#callbacks.onCallbackError, () => {
      this.#callbacks.onStarted?.(internal);
    });
    this.#notifyCompletion(internal);
  }

  #notifyCompletion(internal: InternalProcess): void {
    if (
      !internal.tracked
      || internal.completionNotified
      || internal.completionResult === undefined
    ) {
      return;
    }
    internal.completionNotified = true;
    const completion = internal.completionResult;
    callSafely(this.#callbacks.onCallbackError, () => {
      this.#callbacks.onCompleted?.(internal, completion);
    });
  }

  #activeExecutions(): InternalProcess[] {
    const active = new Set<InternalProcess>();
    for (const execution of this.#pendingExecutions) {
      if (execution.completedAt === undefined) active.add(execution);
    }
    for (const execution of this.#foreground) {
      if (execution.completedAt === undefined) active.add(execution);
    }
    for (const record of this.#records.values()) {
      if (record.completedAt === undefined) active.add(record);
    }
    return [...active];
  }

  async #waitForAll(
    executions: readonly InternalProcess[],
    timeoutMs: number,
  ): Promise<void> {
    if (executions.length === 0 || timeoutMs === 0) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      void Promise.all(
        executions.map((execution) => execution.completion),
      ).then(finish);
    });
  }

  async #performShutdown(): Promise<ProcessShutdownResult> {
    this.#acceptingStarts = false;
    await Promise.allSettled([...this.#pendingStarts]);

    const active = this.#activeExecutions();
    const signaled: number[] = [];
    const forceKilled: number[] = [];
    const signalFailures: ProcessShutdownSignalFailure[] = [];

    for (const execution of active) {
      if (this.#tryShutdownSignal(execution, "SIGTERM", signalFailures)) {
        signaled.push(execution.pid);
      }
    }
    await this.#waitForAll(active, this.#shutdownGraceMs);

    const survivors = active.filter(
      (execution) => execution.completedAt === undefined,
    );
    for (const execution of survivors) {
      if (this.#tryShutdownSignal(execution, "SIGKILL", signalFailures)) {
        forceKilled.push(execution.pid);
      }
    }
    await this.#waitForAll(survivors, this.#shutdownForceWaitMs);

    for (const execution of active) {
      if (execution.completedAt === undefined) {
        execution.child.stdin.destroy();
        execution.child.stdout.destroy();
        execution.child.stderr.destroy();
      }
      execution.outputStore.close();
    }
    for (const record of this.#records.values()) record.outputStore.close();
    return { signaled, forceKilled, signalFailures };
  }

  #tryShutdownSignal(
    execution: InternalProcess,
    signal: NodeJS.Signals,
    failures: ProcessShutdownSignalFailure[],
  ): boolean {
    try {
      return this.signalExecution(execution, signal);
    } catch (error) {
      const failure: ProcessShutdownSignalFailure = {
        pid: execution.pid,
        ...(execution.id === undefined ? {} : { id: execution.id }),
        signal,
        error: asError(error),
      };
      failures.push(failure);
      try {
        this.#callbacks.onCallbackError?.(failure.error);
      } catch {
        // Shutdown must continue even if the optional error reporter fails.
      }
      return false;
    }
  }
}
