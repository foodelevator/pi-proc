import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

import { PROCESS_NOTIFICATION_MESSAGE_TYPE } from "./notification-scheduler";
import {
  MAX_RESTORABLE_PROCESS_NUMBER,
  type HistoricalProcessRecord,
  type ManagedProcessRecord,
  type ProcessMode,
} from "./types";

export const PROCESS_RUNTIME_END_ENTRY_TYPE = "pibg-process-runtime-ending";
export const PROCESS_RUNTIME_END_ENTRY_VERSION = 1;

export type ProcessRuntimeShutdownReason = SessionShutdownEvent["reason"];

export interface PersistedProcessOutputMetadata {
  totalBytes: number;
  totalLines: number;
  deliveredCursor: number;
  spilled: boolean;
  spillPath?: string;
}

export interface PersistedManagedProcess {
  id: string;
  command: string;
  cwd: string;
  mode: Exclude<ProcessMode, "wait">;
  pid: number;
  startedAt: number;
  state: "running" | "completed";
  completedAt?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  timedOut: boolean;
  stdinClosed: boolean;
  lastSignal?: NodeJS.Signals;
  output: PersistedProcessOutputMetadata;
}

export interface ProcessRuntimeEndingEntryData {
  kind: "process-runtime-ending";
  version: typeof PROCESS_RUNTIME_END_ENTRY_VERSION;
  runtimeId: string;
  endedAt: number;
  reason: ProcessRuntimeShutdownReason;
  targetSessionFile?: string;
  processes: PersistedManagedProcess[];
}

export interface ProcessPersistenceRecovery {
  historical: HistoricalProcessRecord[];
  maxProcessNumber: number;
  nextProcessNumber: number;
}

type UnknownRecord = Record<string, unknown>;

const PROCESS_ID = /^p([1-9]\d*)$/;
const SHUTDOWN_REASONS = new Set<ProcessRuntimeShutdownReason>([
  "quit",
  "reload",
  "new",
  "resume",
  "fork",
]);

function object(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : finiteNumber(value);
}

function nullableSignal(value: unknown): NodeJS.Signals | null | undefined {
  return value === null
    ? null
    : typeof value === "string" && value.startsWith("SIG")
    ? value as NodeJS.Signals
    : undefined;
}

function mode(value: unknown): HistoricalProcessRecord["mode"] {
  return value === "background" || value === "monitor" ? value : undefined;
}

function processNumber(id: string): number | undefined {
  const match = PROCESS_ID.exec(id);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed)
      && parsed <= MAX_RESTORABLE_PROCESS_NUMBER
    ? parsed
    : undefined;
}

function priorState(value: UnknownRecord): HistoricalProcessRecord["priorState"] {
  const candidate = value.priorState ?? value.state ?? value.status;
  if (candidate === "running" || candidate === "active") return "running";
  if (candidate === "completed" || candidate === "exited") return "completed";
  return undefined;
}

function outputMetadata(value: unknown): HistoricalProcessRecord["output"] {
  const candidate = object(value);
  if (candidate === undefined) return undefined;
  const totalBytes = nonNegativeNumber(candidate.totalBytes);
  const totalLines = nonNegativeNumber(candidate.totalLines);
  const deliveredCursor = nonNegativeNumber(candidate.deliveredCursor);
  const spillPath = string(candidate.spillPath ?? candidate.fullOutputPath);
  const spilled = boolean(candidate.spilled) ?? spillPath !== undefined;
  if (
    totalBytes === undefined
    && totalLines === undefined
    && deliveredCursor === undefined
    && spillPath === undefined
  ) return undefined;
  return {
    ...(totalBytes === undefined ? {} : { totalBytes }),
    ...(totalLines === undefined ? {} : { totalLines }),
    ...(deliveredCursor === undefined ? {} : { deliveredCursor }),
    spilled,
    ...(spillPath === undefined ? {} : { spillPath }),
  };
}

function observation(value: UnknownRecord): HistoricalProcessRecord | undefined {
  const id = string(value.id);
  if (id === undefined || processNumber(id) === undefined) return undefined;
  const output = outputMetadata(value.output);
  const directSpillPath = string(value.spillPath ?? value.fullOutputPath);
  const normalizedOutput = output ?? (directSpillPath === undefined
    ? undefined
    : { spilled: true, spillPath: directSpillPath });
  return {
    id,
    ...(string(value.command) === undefined ? {} : { command: string(value.command) }),
    ...(string(value.cwd) === undefined ? {} : { cwd: string(value.cwd) }),
    ...(mode(value.mode) === undefined ? {} : { mode: mode(value.mode) }),
    ...(finiteNumber(value.pid) === undefined ? {} : { pid: finiteNumber(value.pid) }),
    ...(nonNegativeNumber(value.startedAt) === undefined
      ? {}
      : { startedAt: nonNegativeNumber(value.startedAt) }),
    ...(nonNegativeNumber(value.completedAt) === undefined
      ? {}
      : { completedAt: nonNegativeNumber(value.completedAt) }),
    ...(nullableNumber(value.exitCode) === undefined
      ? {}
      : { exitCode: nullableNumber(value.exitCode) }),
    ...(nullableSignal(value.exitSignal) === undefined
      ? {}
      : { exitSignal: nullableSignal(value.exitSignal) }),
    ...(boolean(value.timedOut) === undefined ? {} : { timedOut: boolean(value.timedOut) }),
    ...(boolean(value.stdinClosed) === undefined
      ? {}
      : { stdinClosed: boolean(value.stdinClosed) }),
    ...(nullableSignal(value.lastSignal) === undefined
      || nullableSignal(value.lastSignal) === null
      ? {}
      : { lastSignal: nullableSignal(value.lastSignal) as NodeJS.Signals }),
    ...(priorState(value) === undefined ? {} : { priorState: priorState(value) }),
    ...(normalizedOutput === undefined ? {} : { output: normalizedOutput }),
  };
}

function mergeObservation(
  existing: HistoricalProcessRecord | undefined,
  incoming: HistoricalProcessRecord,
): HistoricalProcessRecord {
  if (existing === undefined) return incoming;
  const output = existing.output === undefined && incoming.output === undefined
    ? undefined
    : {
        ...existing.output,
        ...incoming.output,
        spilled: incoming.output?.spilled ?? existing.output?.spilled ?? false,
      };
  return {
    ...existing,
    ...incoming,
    ...(output === undefined ? {} : { output }),
  };
}

function endingMessage(
  id: string,
  prior: HistoricalProcessRecord["priorState"],
  reason: ProcessRuntimeShutdownReason,
): string {
  if (prior === "completed") {
    return `Process \`${id}\` belonged to a previous runtime and had already completed before ${reason}.`;
  }
  switch (reason) {
    case "reload":
      return `Process \`${id}\` belonged to a previous runtime and was terminated during reload.`;
    case "new":
    case "resume":
    case "fork":
      return `Process \`${id}\` belonged to a previous runtime and was terminated during session replacement (${reason}).`;
    case "quit":
      return `Process \`${id}\` belonged to a previous runtime and was terminated during session shutdown.`;
  }
}

function unknownMessage(record: HistoricalProcessRecord): string {
  if (record.priorState === "completed") {
    return `Process \`${record.id}\` belonged to a previous runtime and was last known to be completed, but that runtime has no graceful shutdown record.`;
  }
  return `Process \`${record.id}\` belonged to a previous runtime that ended unexpectedly; its final status is unknown.`;
}

function ingestObservation(
  value: unknown,
  ingest: (record: HistoricalProcessRecord) => void,
): void {
  const candidate = object(value);
  const parsed = candidate === undefined ? undefined : observation(candidate);
  if (parsed !== undefined) ingest(parsed);
}

function ingestObservationArray(
  value: unknown,
  ingest: (record: HistoricalProcessRecord) => void,
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) ingestObservation(item, ingest);
}

/** Only inspect the documented details slots emitted by this extension's tools. */
function ingestToolDetails(
  toolName: string,
  value: unknown,
  ingest: (record: HistoricalProcessRecord) => void,
): void {
  const details = object(value);
  if (details === undefined) return;
  if (toolName === "process_list") {
    ingestObservationArray(details.processes, ingest);
    return;
  }
  if (
    toolName === "bash"
    || toolName === "process_read"
    || toolName === "process_write"
    || toolName === "process_kill"
  ) {
    ingestObservation(details.process, ingest);
  }
}

/** Parse current and legacy notification detail arrays without inspecting content. */
function ingestNotificationDetails(
  value: unknown,
  ingest: (record: HistoricalProcessRecord) => void,
): void {
  const details = object(value);
  if (!Array.isArray(details?.processes)) return;
  for (const itemValue of details.processes) {
    const item = object(itemValue);
    if (item === undefined) continue;
    // Legacy notifications stored process metadata directly on each item.
    ingestObservation(item, ingest);
    // Current notifications put the complete process snapshot under status.
    ingestObservation(item.status, ingest);
  }
}

function shutdownReason(value: unknown): ProcessRuntimeShutdownReason | undefined {
  return typeof value === "string" && SHUTDOWN_REASONS.has(
      value as ProcessRuntimeShutdownReason,
    )
    ? value as ProcessRuntimeShutdownReason
    : undefined;
}

/**
 * Reconstruct process tombstones from durable tool results, process messages,
 * and runtime-ending custom entries. Unknown shapes are ignored rather than
 * making an old or partially-written session unloadable.
 */
export function reconstructProcessPersistence(
  entries: readonly unknown[],
): ProcessPersistenceRecovery {
  const records = new Map<string, HistoricalProcessRecord>();
  const graceful = new Map<string, ProcessRuntimeShutdownReason>();
  let maxProcessNumber = 0;

  const ingest = (record: HistoricalProcessRecord): void => {
    const number = processNumber(record.id);
    if (number === undefined) return;
    maxProcessNumber = Math.max(maxProcessNumber, number);
    records.set(record.id, mergeObservation(records.get(record.id), record));
  };

  for (const rawEntry of entries) {
    const entry = object(rawEntry);
    if (entry === undefined) continue;
    const entryType = string(entry.type);
    const customType = string(entry.customType);

    if (entryType === "custom" && customType === PROCESS_RUNTIME_END_ENTRY_TYPE) {
      const data = object(entry.data);
      const reason = shutdownReason(data?.reason);
      const processes = data?.processes;
      if (Array.isArray(processes)) {
        for (const process of processes) {
          const parsed = object(process);
          const record = parsed === undefined ? undefined : observation(parsed);
          if (record === undefined) continue;
          ingest(record);
          if (reason !== undefined) graceful.set(record.id, reason);
        }
      }
      continue;
    }

    const message = object(entry.message);
    if (entryType === "message" && message?.role === "toolResult") {
      const toolName = string(message.toolName);
      if (toolName !== undefined) {
        ingestToolDetails(toolName, message.details, ingest);
      }
      continue;
    }

    const messageCustomType = string(message?.customType) ?? customType;
    if (
      messageCustomType === PROCESS_NOTIFICATION_MESSAGE_TYPE
      || customType === PROCESS_NOTIFICATION_MESSAGE_TYPE
    ) {
      ingestNotificationDetails(message?.details ?? entry.details, ingest);
    }
  }

  const historical = [...records.values()].map((record) => {
    const reason = graceful.get(record.id);
    if (reason === undefined) {
      return {
        ...record,
        runtimeEnd: "unknown" as const,
        message: unknownMessage(record),
      };
    }
    return {
      ...record,
      runtimeEnd: "graceful" as const,
      shutdownReason: reason,
      message: endingMessage(record.id, record.priorState, reason),
    };
  }).sort((left, right) =>
    (processNumber(left.id) ?? 0) - (processNumber(right.id) ?? 0)
  );

  return {
    historical,
    maxProcessNumber,
    nextProcessNumber: maxProcessNumber + 1,
  };
}

export function snapshotPersistedProcess(
  record: ManagedProcessRecord,
): PersistedManagedProcess {
  const stats = record.outputStore.stats;
  const completed = record.completedAt !== undefined;
  return {
    id: record.id,
    command: record.command,
    cwd: record.cwd,
    mode: record.mode,
    pid: record.pid,
    startedAt: record.startedAt,
    state: completed ? "completed" : "running",
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(completed ? { exitCode: record.exitCode ?? null } : {}),
    ...(completed ? { exitSignal: record.exitSignal ?? null } : {}),
    timedOut: record.timedOut,
    stdinClosed: record.stdinClosed,
    ...(record.lastSignal === undefined ? {} : { lastSignal: record.lastSignal }),
    output: {
      totalBytes: stats.totalBytes,
      totalLines: stats.totalLines,
      deliveredCursor: stats.deliveredCursor,
      spilled: stats.spilled,
      ...(stats.spillPath === undefined ? {} : { spillPath: stats.spillPath }),
    },
  };
}

export function createRuntimeEndingEntryData(
  runtimeId: string,
  reason: ProcessRuntimeShutdownReason,
  records: readonly ManagedProcessRecord[],
  options: { endedAt?: number; targetSessionFile?: string } = {},
): ProcessRuntimeEndingEntryData {
  return {
    kind: "process-runtime-ending",
    version: PROCESS_RUNTIME_END_ENTRY_VERSION,
    runtimeId,
    endedAt: options.endedAt ?? Date.now(),
    reason,
    ...(options.targetSessionFile === undefined
      ? {}
      : { targetSessionFile: options.targetSessionFile }),
    processes: records.map(snapshotPersistedProcess),
  };
}
