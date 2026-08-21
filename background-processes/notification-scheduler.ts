import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  ProcessManagerEvent,
  ProcessManagerEventListener,
} from "./process-manager";
import type {
  ManagedProcessRecord,
  OutputReadResult,
  ProcessCompletion,
} from "./types";
import {
  formatProcessState,
  type ManagedProcessStatus,
  snapshotProcessStatus,
} from "./tools/process-utils";
import { renderProcessNotificationMessage } from "./ui";

export const PROCESS_NOTIFICATION_MESSAGE_TYPE = "pibg-process-events";
export const PROCESS_NOTIFICATION_WINDOW_MS = 200;

export type ProcessNotificationEventType = "stdout" | "completed";

export interface JsonProcessCompletion {
  completedAt: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
}

export interface ProcessNotificationItem {
  id: string;
  events: ProcessNotificationEventType[];
  status: ManagedProcessStatus;
  completion?: JsonProcessCompletion;
  output: OutputReadResult;
}

export interface ProcessNotificationBatchDetails {
  kind: "process-notification";
  version: 1;
  windowStartedAt: number;
  flushedAt: number;
  limits: { maxBytes: number; maxLines: number };
  returned: { bytes: number; lines: number };
  processes: ProcessNotificationItem[];
}

export interface ProcessNotificationMessage {
  customType: typeof PROCESS_NOTIFICATION_MESSAGE_TYPE;
  content: string;
  display: true;
  details: ProcessNotificationBatchDetails;
}

interface ProcessEventSource {
  subscribeEvents(listener: ProcessManagerEventListener): () => void;
}

interface PendingProcess {
  process: ManagedProcessRecord;
  stdout: boolean;
  completion?: ProcessCompletion;
}

export interface ProcessNotificationSchedulerOptions {
  eventSource: ProcessEventSource;
  isIdle: () => boolean;
  sendMessage: (
    message: ProcessNotificationMessage,
    options: { triggerTurn: true; deliverAs: "steer" },
  ) => void;
  windowMs?: number;
  maxBytes?: number;
  maxLines?: number;
  now?: () => number;
  onError?: (error: Error) => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function fairAllocations(demands: readonly number[], budget: number): number[] {
  const allocations = new Array<number>(demands.length).fill(0);
  const remaining = new Set(demands.map((_demand, index) => index));
  let available = budget;

  while (remaining.size > 0 && available > 0) {
    const share = Math.floor(available / remaining.size);
    const remainder = available % remaining.size;
    let satisfied = false;
    let position = 0;

    for (const index of [...remaining]) {
      const offered = share + (position < remainder ? 1 : 0);
      position++;
      if (demands[index] <= offered) {
        allocations[index] = demands[index];
        available -= demands[index];
        remaining.delete(index);
        satisfied = true;
      }
    }
    if (satisfied) continue;

    position = 0;
    for (const index of remaining) {
      const amount = share + (position < remainder ? 1 : 0);
      allocations[index] = amount;
      available -= amount;
      position++;
    }
    break;
  }

  return allocations;
}

function jsonCompletion(completion: ProcessCompletion): JsonProcessCompletion {
  return {
    completedAt: completion.completedAt,
    exitCode: completion.exitCode,
    exitSignal: completion.exitSignal,
    timedOut: completion.timedOut,
    ...(completion.error === undefined
      ? {}
      : { error: completion.error.message }),
  };
}

function consumedSnapshot(output: OutputReadResult): OutputReadResult {
  return {
    ...output,
    cursor: {
      before: output.cursor.before,
      after: output.totalBytes,
      advanced: output.totalBytes !== output.cursor.before,
    },
  };
}

function rangeText(range: { start: number; end: number }): string {
  return `[${range.start}, ${range.end})`;
}

function formatItem(item: ProcessNotificationItem): string {
  const eventText = item.events.join(", ");
  const output = item.output;
  const omitted = output.omittedRanges.length === 0
    ? "none"
    : output.omittedRanges.map(rangeText).join(", ");
  const command = item.status.command.replaceAll(/\r?\n/g, " ");
  const lines = [
    `[process ${item.id} | ${item.status.mode} | ${formatProcessState(item.status)} | events: ${eventText}]`,
    `command: ${command}`,
    `combined stdout/stderr bytes: requested ${rangeText(output.requestedRange)}; returned ${rangeText(output.returnedRange)}; omitted ${omitted}`,
  ];
  if (output.spillPath !== undefined) {
    lines.push(`full output spill: ${output.spillPath}`);
  }
  lines.push(output.content.length === 0 ? "output: (empty)" : `output:\n${output.content}`);
  return lines.join("\n");
}

function buildMessage(
  pending: readonly PendingProcess[],
  windowStartedAt: number,
  flushedAt: number,
  maxBytes: number,
  maxLines: number,
): {
  message?: ProcessNotificationMessage;
  commits: Array<{ process: ManagedProcessRecord; end: number }>;
} {
  const candidates = pending.map((entry) => {
    const preview = entry.process.outputStore.peekImplicit(maxBytes, maxLines);
    return { entry, preview };
  }).filter(({ entry, preview }) =>
    entry.completion !== undefined || preview.requestedRange.end > preview.requestedRange.start
  );
  if (candidates.length === 0) return { commits: [] };

  const byteDemands = candidates.map(({ preview }) =>
    preview.requestedRange.end - preview.requestedRange.start
  );
  const lineDemands = candidates.map(({ preview }) => preview.returnedLines);
  const byteAllocations = fairAllocations(byteDemands, maxBytes);
  const lineAllocations = fairAllocations(lineDemands, maxLines);

  const items = candidates.map(({ entry }, index): ProcessNotificationItem => {
    const output = consumedSnapshot(entry.process.outputStore.peekImplicit(
      byteAllocations[index],
      lineAllocations[index],
    ));
    return {
      id: entry.process.id,
      events: [
        ...(entry.stdout ? ["stdout" as const] : []),
        ...(entry.completion === undefined ? [] : ["completed" as const]),
      ],
      status: snapshotProcessStatus(entry.process, output, flushedAt),
      ...(entry.completion === undefined
        ? {}
        : { completion: jsonCompletion(entry.completion) }),
      output,
    };
  });
  const returned = items.reduce(
    (total, item) => ({
      bytes: total.bytes + item.output.returnedBytes,
      lines: total.lines + item.output.returnedLines,
    }),
    { bytes: 0, lines: 0 },
  );
  const details: ProcessNotificationBatchDetails = {
    kind: "process-notification",
    version: 1,
    windowStartedAt,
    flushedAt,
    limits: { maxBytes, maxLines },
    returned,
    processes: items,
  };
  return {
    message: {
      customType: PROCESS_NOTIFICATION_MESSAGE_TYPE,
      content: `Managed process notification batch (${items.length} process${items.length === 1 ? "" : "es"}):\n\n${items.map(formatItem).join("\n\n")}`,
      display: true,
      details,
    },
    commits: items.map((item, index) => ({
      process: candidates[index].entry.process,
      end: item.output.totalBytes,
    })),
  };
}

/** One fixed-window notification batcher shared by every managed process. */
export class ProcessNotificationScheduler {
  readonly #options: Required<Pick<
    ProcessNotificationSchedulerOptions,
    "isIdle" | "sendMessage" | "now"
  >> & ProcessNotificationSchedulerOptions;
  readonly #unsubscribe: () => void;
  #pending = new Map<string, PendingProcess>();
  #windowStartedAt: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #expiredWhileBusy = false;
  #reportingError = false;
  #closed = false;

  constructor(options: ProcessNotificationSchedulerOptions) {
    const windowMs = requireNonNegativeInteger(
      options.windowMs ?? PROCESS_NOTIFICATION_WINDOW_MS,
      "windowMs",
    );
    const maxBytes = requireNonNegativeInteger(
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      "maxBytes",
    );
    const maxLines = requireNonNegativeInteger(
      options.maxLines ?? DEFAULT_MAX_LINES,
      "maxLines",
    );
    this.#options = {
      ...options,
      windowMs,
      maxBytes,
      maxLines,
      now: options.now ?? Date.now,
    };
    this.#unsubscribe = options.eventSource.subscribeEvents((event) => {
      this.#handleEvent(event);
    });
  }

  get pendingProcessCount(): number {
    return this.#pending.size;
  }

  get hasTimer(): boolean {
    return this.#timer !== undefined;
  }

  handleTurnEnd(): void {
    this.#releaseExpiredBatch();
  }

  handleAgentSettled(): void {
    this.#releaseExpiredBatch();
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#clearTimer();
    this.#pending.clear();
    this.#windowStartedAt = undefined;
    this.#expiredWhileBusy = false;
  }

  #handleEvent(event: ProcessManagerEvent): void {
    if (this.#closed) return;
    const current = this.#pending.get(event.process.id) ?? {
      process: event.process,
      stdout: false,
    };
    current.process = event.process;
    if (event.type === "stdout-activity") current.stdout = true;
    else current.completion = event.completion;
    this.#pending.set(event.process.id, current);

    if (this.#windowStartedAt === undefined) {
      this.#windowStartedAt = this.#options.now();
      this.#armTimer();
    } else if (this.#expiredWhileBusy) {
      // A busy window has already earned immediate lifecycle delivery. Keep
      // that eligibility, but re-arm a fixed recheck from fresh activity so a
      // missed lifecycle edge can never leave the global batch permanently stuck.
      this.#armTimer();
    }
  }

  #armTimer(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#closed || this.#pending.size === 0) return;
      let idle: boolean;
      try {
        idle = this.#options.isIdle();
      } catch (error) {
        // Publish the releasable state before invoking external error handling.
        // An error reporter is allowed to synchronously trigger lifecycle work.
        this.#expiredWhileBusy = true;
        this.#armTimer();
        this.#report(error);
        return;
      }
      if (idle) this.#flush();
      else this.#expiredWhileBusy = true;
    }, this.#options.windowMs);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #releaseExpiredBatch(): void {
    if (this.#closed || !this.#expiredWhileBusy) return;
    this.#flush();
  }

  #flush(): void {
    if (this.#closed || this.#pending.size === 0) return;
    const batch = [...this.#pending.values()];
    const windowStartedAt = this.#windowStartedAt ?? this.#options.now();
    this.#pending = new Map();
    this.#windowStartedAt = undefined;
    this.#expiredWhileBusy = false;
    this.#clearTimer();

    const built = buildMessage(
      batch,
      windowStartedAt,
      this.#options.now(),
      this.#options.maxBytes!,
      this.#options.maxLines!,
    );
    if (built.message === undefined) return;

    try {
      this.#options.sendMessage(built.message, {
        triggerTurn: true,
        deliverAs: "steer",
      });
      for (const commit of built.commits) {
        commit.process.outputStore.advanceDeliveredCursor(commit.end);
      }
    } catch (error) {
      for (const entry of batch) {
        const current = this.#pending.get(entry.process.id);
        if (current === undefined) {
          this.#pending.set(entry.process.id, entry);
        } else {
          current.stdout ||= entry.stdout;
          current.completion ??= entry.completion;
        }
      }
      this.#windowStartedAt = windowStartedAt;
      this.#expiredWhileBusy = true;
      // A failed lifecycle flush may have consumed the final turn/settled edge.
      // Always leave an independent retry armed before reporting the failure.
      this.#armTimer();
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    if (this.#reportingError) return;
    this.#reportingError = true;
    try {
      this.#options.onError?.(asError(error));
    } catch {
      // Error reporting must not destabilize process notification supervision.
    } finally {
      this.#reportingError = false;
    }
  }
}

/** Compact by default; expansion renders bounded structured process details. */
export function registerProcessNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ProcessNotificationBatchDetails>(
    PROCESS_NOTIFICATION_MESSAGE_TYPE,
    (message, options, theme) => renderProcessNotificationMessage(
      {
        content: typeof message.content === "string"
          ? message.content
          : "Managed process notification",
        details: message.details,
      },
      options,
      theme,
    ),
  );
}
