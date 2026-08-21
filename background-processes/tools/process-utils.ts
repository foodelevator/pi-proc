import type { ProcessManager } from "../process-manager";
import type {
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

export interface ProcessToolOptions {
  getManager: () => ProcessManager | undefined;
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
