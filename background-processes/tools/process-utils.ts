import type { ProcessManager } from "../process-manager";
import type {
  HistoricalProcessRecord,
  ManagedProcessRecord,
  OutputReadResult,
} from "../types";

export interface ManagedProcessOutputStatus {
  totalBytes: number;
  totalLines: number;
  deliveredCursor: number;
  spilled: boolean;
  spillPath?: string;
}

export interface ManagedProcessStatus {
  id: string;
  state: "running" | "completed";
  command: string;
  cwd: string;
  mode: ManagedProcessRecord["mode"];
  pid: number;
  startedAt: number;
  completedAt?: number;
  durationMs: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  timedOut: boolean;
  stdinClosed: boolean;
  lastSignal?: NodeJS.Signals;
  output: ManagedProcessOutputStatus;
}

export interface HistoricalProcessStatus {
  id: string;
  state: "historical";
  priorState?: "running" | "completed";
  command?: string;
  cwd?: string;
  mode?: ManagedProcessRecord["mode"];
  pid?: number;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  timedOut?: boolean;
  stdinClosed?: boolean;
  lastSignal?: NodeJS.Signals;
  runtimeEnd: "graceful" | "unknown";
  shutdownReason?: HistoricalProcessRecord["shutdownReason"];
  reason: string;
  output: NonNullable<HistoricalProcessRecord["output"]>;
}

export interface ProcessToolOptions {
  getManager: () => ProcessManager | undefined;
}

export class ProcessToolAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessToolAbortError";
  }
}

/**
 * Stop awaiting an operation when Pi aborts the tool while continuing to
 * observe the underlying promise. This prevents late failures from becoming
 * unhandled rejections and removes the abort listener on every settlement path.
 */
export function raceWithAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal === undefined) return operation;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", handleAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const handleAbort = (): void => {
      rejectOnce(new ProcessToolAbortError(message));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    void operation.then(resolveOnce, rejectOnce);
    if (signal.aborted) handleAbort();
  });
}

export function requireProcessManager(options: ProcessToolOptions): ProcessManager {
  const manager = options.getManager();
  if (manager === undefined) {
    throw new Error("Process manager is unavailable for this session");
  }
  return manager;
}

export function snapshotProcessStatus(
  record: ManagedProcessRecord,
  outputSnapshot?: OutputReadResult,
  now = Date.now(),
): ManagedProcessStatus {
  const completed = record.completedAt !== undefined;
  const stats = record.outputStore.stats;
  const output: ManagedProcessOutputStatus = outputSnapshot === undefined
    ? {
        totalBytes: stats.totalBytes,
        totalLines: stats.totalLines,
        deliveredCursor: stats.deliveredCursor,
        spilled: stats.spilled,
        ...(stats.spillPath === undefined ? {} : { spillPath: stats.spillPath }),
      }
    : {
        totalBytes: outputSnapshot.totalBytes,
        totalLines: outputSnapshot.totalLines,
        deliveredCursor: outputSnapshot.cursor.after,
        spilled: outputSnapshot.spillPath !== undefined,
        ...(outputSnapshot.spillPath === undefined
          ? {}
          : { spillPath: outputSnapshot.spillPath }),
      };

  return {
    id: record.id,
    state: completed ? "completed" : "running",
    command: record.command,
    cwd: record.cwd,
    mode: record.mode,
    pid: record.pid,
    startedAt: record.startedAt,
    ...(record.completedAt === undefined
      ? {}
      : { completedAt: record.completedAt }),
    durationMs: Math.max(
      0,
      (record.completedAt ?? now) - record.startedAt,
    ),
    ...(completed ? { exitCode: record.exitCode ?? null } : {}),
    ...(completed ? { exitSignal: record.exitSignal ?? null } : {}),
    timedOut: record.timedOut,
    stdinClosed: record.stdinClosed,
    ...(record.lastSignal === undefined
      ? {}
      : { lastSignal: record.lastSignal }),
    output,
  };
}

export function snapshotHistoricalProcessStatus(
  record: HistoricalProcessRecord,
): HistoricalProcessStatus {
  return {
    id: record.id,
    state: "historical",
    ...(record.priorState === undefined ? {} : { priorState: record.priorState }),
    ...(record.command === undefined ? {} : { command: record.command }),
    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
    ...(record.mode === undefined ? {} : { mode: record.mode }),
    ...(record.pid === undefined ? {} : { pid: record.pid }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.exitSignal === undefined ? {} : { exitSignal: record.exitSignal }),
    ...(record.timedOut === undefined ? {} : { timedOut: record.timedOut }),
    ...(record.stdinClosed === undefined ? {} : { stdinClosed: record.stdinClosed }),
    ...(record.lastSignal === undefined ? {} : { lastSignal: record.lastSignal }),
    runtimeEnd: record.runtimeEnd ?? "unknown",
    ...(record.shutdownReason === undefined
      ? {}
      : { shutdownReason: record.shutdownReason }),
    reason: record.message
      ?? `Process \`${record.id}\` belonged to a previous runtime`,
    output: record.output ?? { spilled: false },
  };
}

export function formatProcessState(status: ManagedProcessStatus): string {
  if (status.state === "running") return "running";
  if (status.timedOut) {
    return status.exitSignal === null || status.exitSignal === undefined
      ? "timed out"
      : `timed out; terminated by ${status.exitSignal}`;
  }
  if (status.exitSignal !== null && status.exitSignal !== undefined) {
    return `completed; terminated by ${status.exitSignal}`;
  }
  return `completed; exit code ${status.exitCode ?? "unknown"}`;
}

function formatRange(start: number, end: number): string {
  return `[${start}, ${end})`;
}

export function formatOutputSnapshot(output: OutputReadResult): string {
  const metadata = [
    `Combined stdout/stderr snapshot: requested bytes ${formatRange(output.requestedRange.start, output.requestedRange.end)}; returned bytes ${formatRange(output.returnedRange.start, output.returnedRange.end)}; total ${output.totalBytes} bytes in ${output.totalLines} lines.`,
  ];
  if (output.omittedRanges.length > 0) {
    metadata.push(
      `Omitted byte ranges: ${output.omittedRanges.map((range) => formatRange(range.start, range.end)).join(", ")} (${output.truncation.omittedBytes} bytes omitted).`,
    );
  }
  if (output.spillPath !== undefined) {
    metadata.push(`Full combined output spill file: ${output.spillPath}`);
  }
  metadata.push(
    output.content.length === 0
      ? "Returned output: (empty)"
      : `Returned output:\n${output.content}`,
  );
  return metadata.join("\n");
}
