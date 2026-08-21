import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { OutputStore } from "./output-store";

export interface ByteRange {
  /** Inclusive byte offset. */
  start: number;
  /** Exclusive byte offset. */
  end: number;
}

export type OutputTruncationReason = "bytes" | "lines";

export interface OutputTruncation {
  truncated: boolean;
  by: OutputTruncationReason[];
  omittedBytes: number;
}

export interface OutputCursorMetadata {
  before: number;
  after: number;
  /** True only when this read moved the delivered cursor. */
  advanced: boolean;
}

export interface OutputReadResult {
  /** UTF-8 decoding of the exact bytes in returnedRange. */
  content: string;
  requestedRange: ByteRange;
  returnedRange: ByteRange;
  omittedRanges: ByteRange[];
  truncation: OutputTruncation;
  cursor: OutputCursorMetadata;
  /** Output totals at the fixed snapshot used for this read. */
  totalBytes: number;
  totalLines: number;
  returnedBytes: number;
  returnedLines: number;
  spillPath?: string;
}

export interface OutputReadOptions {
  /** An explicit zero-based byte offset. Omit to consume from the delivered cursor. */
  start?: number;
  /** Requested byte budget. Reads never return more than the store's configured maximum. */
  length?: number;
}

export interface OutputStoreStats {
  totalBytes: number;
  totalLines: number;
  deliveredCursor: number;
  spilled: boolean;
  spillPath?: string;
  /** The byte range currently resident in memory. */
  memoryRange: ByteRange;
  memoryBytes: number;
}

export interface OutputStoreOptions {
  /** Spill after this many bytes are exceeded. Defaults to Pi's 50 KB output limit. */
  maxInMemoryBytes?: number;
  /** Spill after this many lines are exceeded. Defaults to Pi's 2000-line limit. */
  maxInMemoryLines?: number;
  /** Maximum bytes returned by one read. Defaults to Pi's 50 KB output limit. */
  maxReadBytes?: number;
  /** Maximum lines returned by one read. Defaults to Pi's 2000-line limit. */
  maxReadLines?: number;
  tempDirectory?: string;
  tempFilePrefix?: string;
  /** Primarily for deterministic tests. The returned path must not already exist. */
  createSpillPath?: () => string;
}

export type ProcessMode = "wait" | "background" | "monitor";
export type PublicProcessMode = Exclude<ProcessMode, "wait">;
export type ProcessOutputSource = "stdout" | "stderr";

export interface PiSessionEnvironment {
  sessionId?: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
}

export interface ProcessCompletion {
  completedAt: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: Error;
}

export interface ProcessExecution {
  /** Set only after a foreground execution is promoted. */
  id?: string;
  command: string;
  cwd: string;
  mode: ProcessMode;
  child: ChildProcessWithoutNullStreams;
  pid: number;
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  timedOut: boolean;
  stdinClosed: boolean;
  lastSignal?: NodeJS.Signals;
  outputStore: OutputStore;
  readonly deliveredCursor: number;
  completion: Promise<ProcessCompletion>;
}

/** A wait-mode execution, private to its caller unless it is promoted. */
export type ForegroundWaitOutcome =
  | { type: "completed"; completion: ProcessCompletion }
  | { type: "detached"; process: ManagedProcessRecord }
  | { type: "aborted" }
  | { type: "timed-out" };

export interface ForegroundExecution extends ProcessExecution {
  /** Resolves if steering promotes this execution; otherwise remains pending. */
  detachment: Promise<ManagedProcessRecord>;
  /** The single winning reason why the foreground tool should stop waiting. */
  waitOutcome: Promise<ForegroundWaitOutcome>;
}

export interface ManagedProcessRecord extends ProcessExecution {
  id: string;
  mode: PublicProcessMode;
}

export interface HistoricalProcessRecord {
  id: string;
  command?: string;
  message?: string;
}

export interface StartProcessOptions {
  mode?: ProcessMode;
  cwd?: string;
  /** Milliseconds; the process group is sent SIGKILL when this expires. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  sessionEnvironment?: PiSessionEnvironment;
}

export interface ProcessSignalResult {
  signal: NodeJS.Signals;
  sent: boolean;
  exited: boolean;
  completion?: ProcessCompletion;
  /** Present when the signal operation consumed the process's unread output. */
  output?: OutputReadResult;
}

export interface ProcessShutdownSignalFailure {
  pid: number;
  id?: string;
  signal: NodeJS.Signals;
  error: Error;
}

export interface ProcessShutdownResult {
  signaled: number[];
  forceKilled: number[];
  signalFailures: ProcessShutdownSignalFailure[];
}
