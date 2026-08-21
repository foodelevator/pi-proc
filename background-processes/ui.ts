import {
  type AgentToolResult,
  type ExtensionContext,
  formatSize,
  keyHint,
  type Theme,
  type ToolRenderResultOptions,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { ProcessNotificationBatchDetails } from "./notification-scheduler";
import type {
  ProcessManagerEventListener,
} from "./process-manager";
import type {
  ManagedProcessRecord,
  OutputReadResult,
} from "./types";
import type {
  BackgroundBashToolDetails,
  BackgroundBashToolInput,
} from "./tools/bash";
import type {
  ProcessKillToolDetails,
  ProcessKillToolInput,
} from "./tools/process-kill";
import type {
  ProcessListToolDetails,
  ProcessListToolInput,
} from "./tools/process-list";
import type {
  ProcessReadToolDetails,
  ProcessReadToolInput,
} from "./tools/process-read";
import {
  formatProcessState,
  type HistoricalProcessStatus,
  type ManagedProcessStatus,
} from "./tools/process-utils";
import type {
  ProcessWriteToolDetails,
  ProcessWriteToolInput,
} from "./tools/process-write";

export const RUNNING_PROCESSES_WIDGET_KEY = "pibg:running-processes";
const OUTPUT_PREVIEW_LINES = 5;
const LIST_PREVIEW_RECORDS = 5;

interface RunningProcessSource {
  readonly activeRecords: readonly ManagedProcessRecord[];
  subscribeEvents(listener: ProcessManagerEventListener): () => void;
}

interface RunningWidgetOptions {
  now?: () => number;
}

type LineBuilder = (width: number) => string[];

interface RenderContext {
  lastComponent: Component | undefined;
  isError: boolean;
}

interface BashRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
}

interface BashRenderContext extends RenderContext {
  state: BashRenderState;
  executionStarted: boolean;
  invalidate(): void;
}

/** A cacheable component that computes theme styling at render time. */
class WidthSafeComponent implements Component {
  #builder: LineBuilder;
  #cachedWidth: number | undefined;
  #cachedLines: string[] | undefined;

  constructor(builder: LineBuilder) {
    this.#builder = builder;
  }

  setBuilder(builder: LineBuilder): void {
    this.#builder = builder;
    this.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    if (this.#cachedWidth === safeWidth && this.#cachedLines !== undefined) {
      return this.#cachedLines;
    }
    this.#cachedLines = this.#builder(safeWidth).map((line) =>
      truncateToWidth(line, safeWidth, "…")
    );
    this.#cachedWidth = safeWidth;
    return this.#cachedLines;
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedLines = undefined;
  }
}

function componentFor(
  context: Pick<RenderContext, "lastComponent">,
  builder: LineBuilder,
): Component {
  const component = context.lastComponent instanceof WidthSafeComponent
    ? context.lastComponent
    : new WidthSafeComponent(builder);
  component.setBuilder(builder);
  return component;
}

function processNumber(id: string): number {
  const parsed = Number(id.slice(1));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function normalizeCommandLine(command: string): string {
  return stripTerminalSequences(command)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function elapsedSeconds(record: ManagedProcessRecord, now: number): number {
  return Math.max(0, Math.floor((now - record.startedAt) / 1_000));
}

export function createRunningProcessesWidget(
  source: Pick<RunningProcessSource, "activeRecords">,
  theme: Theme,
  options: RunningWidgetOptions = {},
): Component {
  const now = options.now ?? Date.now;
  return new WidthSafeComponent((width) => {
    const records = [...source.activeRecords].sort((left, right) =>
      processNumber(left.id) - processNumber(right.id)
    );
    const idWidth = records.reduce(
      (widest, record) => Math.max(widest, record.id.length),
      0,
    );
    return records.map((record) => {
      const dot = theme.fg("success", "●");
      const id = theme.fg("accent", record.id.padEnd(idWidth));
      const mode = theme.fg("muted", record.mode.padEnd(10));
      const elapsed = theme.fg(
        "dim",
        `${elapsedSeconds(record, now())}s`.padStart(5),
      );
      const command = theme.fg("text", normalizeCommandLine(record.command));
      return truncateToWidth(`${dot} ${id}  ${mode} ${elapsed}  ${command}`, width, "…");
    });
  });
}

export interface RunningProcessesWidgetController {
  refresh(): void;
  dispose(): void;
}

/** Install the TUI-only, above-editor widget and own all of its resources. */
export function installRunningProcessesWidget(
  source: RunningProcessSource,
  ctx: ExtensionContext,
): RunningProcessesWidgetController {
  if (ctx.mode !== "tui") {
    return { refresh() {}, dispose() {} };
  }

  let installed = false;
  let disposed = false;
  let interval: NodeJS.Timeout | undefined;
  let widget: Component | undefined;
  let requestRender: (() => void) | undefined;

  const stopInterval = (): void => {
    if (interval === undefined) return;
    clearInterval(interval);
    interval = undefined;
  };
  const startInterval = (): void => {
    if (interval !== undefined || disposed) return;
    interval = setInterval(() => {
      refresh();
    }, 1_000);
    interval.unref?.();
  };
  const clearWidget = (): void => {
    stopInterval();
    widget = undefined;
    requestRender = undefined;
    if (!installed) return;
    installed = false;
    ctx.ui.setWidget(RUNNING_PROCESSES_WIDGET_KEY, undefined, {
      placement: "aboveEditor",
    });
  };
  const refresh = (): void => {
    if (disposed) return;
    if (source.activeRecords.length === 0) {
      clearWidget();
      return;
    }
    if (!installed) {
      installed = true;
      ctx.ui.setWidget(
        RUNNING_PROCESSES_WIDGET_KEY,
        (tui, theme) => {
          requestRender = () => tui.requestRender();
          widget = createRunningProcessesWidget(source, theme);
          return widget;
        },
        { placement: "aboveEditor" },
      );
      startInterval();
      return;
    }
    widget?.invalidate();
    requestRender?.();
  };

  const unsubscribe = source.subscribeEvents((event) => {
    if (event.type === "completed") refresh();
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    clearWidget();
  };

  refresh();
  return { refresh, dispose };
}

function textContent(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } =>
      part.type === "text"
    )
    .map((part) => part.text)
    .join("\n");
}

function cleanDisplayText(text: string): string {
  return stripTerminalSequences(text).replaceAll("\r", "");
}

function styledWrappedLines(
  text: string,
  width: number,
  style: (text: string) => string,
): string[] {
  if (text.length === 0) return [];
  return wrapTextWithAnsi(style(cleanDisplayText(text)), width);
}

function outputLines(
  text: string,
  width: number,
  expanded: boolean,
  theme: Theme,
): string[] {
  const cleaned = cleanDisplayText(text).trim();
  if (cleaned.length === 0) return [];
  const styled = cleaned.split("\n").map((line) =>
    theme.fg("toolOutput", line)
  ).join("\n");
  if (expanded) return wrapTextWithAnsi(styled, width);

  const preview = truncateToVisualLines(styled, OUTPUT_PREVIEW_LINES, width);
  if (preview.skippedCount <= 0) return preview.visualLines;
  const hint = theme.fg(
    "muted",
    `… (${preview.skippedCount} earlier lines,`,
  ) + ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  return [truncateToWidth(hint, width, "…"), ...preview.visualLines];
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function bashDurationLine(
  options: ToolRenderResultOptions,
  state: BashRenderState,
  theme: Theme,
): string | undefined {
  if (state.startedAt === undefined) return undefined;
  const end = state.endedAt ?? Date.now();
  return theme.fg(
    "muted",
    `${options.isPartial ? "Elapsed" : "Took"} ${formatDuration(end - state.startedAt)}`,
  );
}

function range(rangeValue: { start: number; end: number }): string {
  return `[${rangeValue.start}, ${rangeValue.end})`;
}

function outputMetadata(output: OutputReadResult): string[] {
  const omitted = output.omittedRanges.length === 0
    ? "none"
    : output.omittedRanges.map(range).join(", ");
  return [
    `output ${output.returnedBytes} bytes/${output.returnedLines} lines; requested ${range(output.requestedRange)}; returned ${range(output.returnedRange)}; omitted ${omitted}`,
    ...(output.spillPath === undefined ? [] : [`spill ${output.spillPath}`]),
  ];
}

function stateLabel(status: ManagedProcessStatus): string {
  return formatProcessState(status);
}

function processResultSummary(
  status: ManagedProcessStatus,
  theme: Theme,
): string {
  const color = status.state === "running"
    ? "success"
    : status.timedOut || (status.exitCode !== undefined && status.exitCode !== 0)
    ? "warning"
    : "success";
  return `${theme.fg(color, status.state === "running" ? "●" : "✓")} ${theme.fg("accent", status.id)} ${theme.fg("muted", `${status.mode} · ${stateLabel(status)}`)}`;
}

function notificationEventSummary(
  details: ProcessNotificationBatchDetails | undefined,
  theme: Theme,
): string {
  if (details === undefined || details.processes.length === 0) {
    return `${theme.fg("accent", "processes")} ${theme.fg("muted", "update")}`;
  }
  return details.processes.map((item) => {
    const state = item.status.state === "running"
      ? "running"
      : item.status.timedOut
      ? "timed out"
      : item.status.exitSignal !== null && item.status.exitSignal !== undefined
      ? item.status.exitSignal
      : `exit ${item.status.exitCode ?? "?"}`;
    return `${theme.fg(item.status.state === "running" ? "success" : "accent", item.status.state === "running" ? "●" : "✓")} ${theme.fg("accent", item.id)} ${theme.fg("muted", `${item.events.join("+")} · ${state}`)}`;
  }).join(theme.fg("dim", "  │  "));
}

/** Structured notification card: no output content is touched in collapsed mode. */
export function renderProcessNotificationMessage(
  message: { content: string; details?: ProcessNotificationBatchDetails },
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
): Component {
  return new WidthSafeComponent((width) => {
    const pad = " ".repeat(Math.min(options.outputPad, Math.max(0, width - 1)));
    const contentWidth = Math.max(1, width - pad.length);
    let lines: string[];
    if (!options.expanded) {
      lines = wrapTextWithAnsi(
        notificationEventSummary(message.details, theme),
        contentWidth,
      );
    } else {
      const details = message.details;
      if (details === undefined) {
        lines = styledWrappedLines(message.content, contentWidth, (value) =>
          theme.fg("customMessageText", value)
        );
      } else {
        lines = [];
        for (const [index, item] of details.processes.entries()) {
          if (index > 0) lines.push("");
          lines.push(processResultSummary(item.status, theme));
          lines.push(theme.fg("dim", `events ${item.events.join("+")} · ${Math.floor(item.status.durationMs / 1_000)}s · PID ${item.status.pid}`));
          lines.push(...styledWrappedLines(
            `command ${normalizeCommandLine(item.status.command)}`,
            contentWidth,
            (value) => theme.fg("muted", value),
          ));
          if (item.completion !== undefined) {
            const exit = item.completion.exitSignal === null
              ? `exit ${item.completion.exitCode ?? "?"}`
              : `signal ${item.completion.exitSignal}`;
            lines.push(theme.fg(
              item.completion.timedOut || item.completion.exitCode !== 0
                ? "warning"
                : "success",
              `${exit}${item.completion.timedOut ? " · timed out" : ""}${item.completion.error === undefined ? "" : ` · ${item.completion.error}`}`,
            ));
          }
          lines.push(...outputMetadata(item.output).flatMap((line) =>
            styledWrappedLines(line, contentWidth, (value) => theme.fg("dim", value))
          ));
          if (item.output.content.length === 0) {
            lines.push(theme.fg("dim", "output (empty)"));
          } else {
            lines.push(theme.fg("muted", "output"));
            lines.push(...outputLines(
              item.output.content,
              contentWidth,
              true,
              theme,
            ));
          }
        }
      }
    }
    return lines.map((line) =>
      `${pad}${truncateToWidth(line, contentWidth, "…")}`
    );
  });
}

export function renderBashCall(
  args: BackgroundBashToolInput,
  theme: Theme,
  context: BashRenderContext,
): Component {
  const state = context.state;
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
  return componentFor(context, (width) => {
    const command = typeof args.command === "string" && args.command.length > 0
      ? normalizeCommandLine(args.command)
      : "…";
    const mode = args.mode ?? "wait";
    const suffix = [
      ...(mode === "wait" ? [] : [theme.fg("bashMode", ` [${mode}]`)]),
      ...(args.timeout === undefined
        ? []
        : [theme.fg("muted", ` (timeout ${args.timeout}s)`)]),
    ].join("");
    return [truncateToWidth(
      theme.fg("toolTitle", theme.bold(`$ ${command}`)) + suffix,
      width,
      "…",
    )];
  });
}

function bashDisplayOutput(
  result: AgentToolResult<BackgroundBashToolDetails | undefined>,
): string {
  const truncation = result.details?.truncation;
  const content = truncation?.truncated
    && typeof truncation.content === "string"
    ? truncation.content
    : textContent(result);
  return content.trim();
}

function bashWarning(
  details: BackgroundBashToolDetails | undefined,
  theme: Theme,
): string | undefined {
  const warnings: string[] = [];
  if (details?.fullOutputPath !== undefined) {
    warnings.push(`Full output: ${details.fullOutputPath}`);
  }
  const truncation = details?.truncation;
  if (truncation?.truncated) {
    if (truncation.truncatedBy === "lines") {
      warnings.push(
        `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
      );
    } else {
      warnings.push(
        `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit)`,
      );
    }
  }
  return warnings.length === 0
    ? undefined
    : theme.fg("warning", `[${warnings.join(". ")}]`);
}

export function renderBashResult(
  result: AgentToolResult<BackgroundBashToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: BashRenderContext,
): Component {
  const state = context.state;
  if (state.startedAt !== undefined && options.isPartial && state.interval === undefined) {
    state.interval = setInterval(() => context.invalidate(), 1_000);
    state.interval.unref?.();
  }
  if (!options.isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval !== undefined) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  return componentFor(context, (width) => {
    const details = result.details;
    const descriptor = details?.process;
    const descriptorOutput = details?.output;
    if (descriptor !== undefined) {
      const reason = descriptor.reason === "detached_by_steering"
        ? "detached by steering"
        : "started";
      const lines = [
        `${theme.fg("success", "●")} ${theme.fg("accent", descriptor.id)} ${theme.fg("muted", `${descriptor.mode} · ${reason} · PID ${descriptor.pid}`)}`,
      ];
      if (options.expanded) {
        lines.push(theme.fg("dim", `cwd ${descriptor.cwd}`));
        lines.push(...styledWrappedLines(
          `command ${normalizeCommandLine(descriptor.command)}`,
          width,
          (value) => theme.fg("muted", value),
        ));
        if (descriptorOutput !== undefined) {
          lines.push(...outputMetadata(descriptorOutput).flatMap((line) =>
            styledWrappedLines(line, width, (value) => theme.fg("dim", value))
          ));
          lines.push(...outputLines(descriptorOutput.content, width, true, theme));
        }
      }
      const duration = bashDurationLine(options, state, theme);
      if (duration !== undefined) lines.push(duration);
      return lines;
    }

    const lines: string[] = [];
    if (options.isPartial) lines.push(theme.fg("warning", "running…"));
    else if (context.isError) lines.push(theme.fg("error", "error"));
    lines.push(...outputLines(
      bashDisplayOutput(result),
      width,
      options.expanded,
      theme,
    ));
    const warning = bashWarning(details, theme);
    if (warning !== undefined) {
      lines.push(...wrapTextWithAnsi(warning, width));
    }
    const duration = bashDurationLine(options, state, theme);
    if (duration !== undefined) lines.push(duration);
    return lines;
  });
}

function renderAuxCall(
  name: string,
  id: string | undefined,
  suffix: string,
  theme: Theme,
  context: RenderContext,
): Component {
  return componentFor(context, (width) => [truncateToWidth(
    theme.fg("toolTitle", theme.bold(name))
      + (id === undefined ? "" : ` ${theme.fg("accent", id)}`)
      + (suffix === "" ? "" : ` ${theme.fg("muted", suffix)}`),
    width,
    "…",
  )]);
}

function fallbackAuxResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  return componentFor(context, (width) => {
    const prefix = options.isPartial
      ? [theme.fg("warning", "pending…")]
      : context.isError
      ? [theme.fg("error", "error")]
      : [];
    return [
      ...prefix,
      ...outputLines(textContent(result), width, options.expanded, theme),
    ];
  });
}

export function renderProcessReadCall(
  args: ProcessReadToolInput,
  theme: Theme,
  context: RenderContext,
): Component {
  const suffix = args.start === undefined
    ? "unread"
    : `from byte ${args.start}`;
  return renderAuxCall("process_read", args.id, suffix, theme, context);
}

export function renderProcessReadResult(
  result: AgentToolResult<ProcessReadToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  if (result.details === undefined) {
    return fallbackAuxResult(result, options, theme, context);
  }
  return componentFor(context, (width) => {
    const { process: status, output } = result.details;
    const lines = [
      processResultSummary(status, theme),
      theme.fg("dim", `${output.returnedBytes} bytes/${output.returnedLines} lines${output.truncation.truncated ? " · truncated" : ""}`),
      ...outputLines(output.content, width, options.expanded, theme),
    ];
    if (options.expanded) {
      lines.splice(2, 0, ...outputMetadata(output).flatMap((line) =>
        styledWrappedLines(line, width, (value) => theme.fg("dim", value))
      ));
    }
    return lines;
  });
}

export function renderProcessWriteCall(
  args: ProcessWriteToolInput,
  theme: Theme,
  context: RenderContext,
): Component {
  const bytes = args.data === undefined ? 0 : Buffer.byteLength(args.data);
  return renderAuxCall(
    "process_write",
    args.id,
    `${bytes} bytes${args.close === true ? " + EOF" : ""}`,
    theme,
    context,
  );
}

export function renderProcessWriteResult(
  result: AgentToolResult<ProcessWriteToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  if (result.details === undefined) {
    return fallbackAuxResult(result, options, theme, context);
  }
  return componentFor(context, () => {
    const details = result.details;
    return [
      `${theme.fg("success", "✓")} ${theme.fg("accent", details.process.id)} ${theme.fg("muted", `${details.bytesWritten} bytes · stdin ${details.stdinClosed ? "closed" : "open"} · ${stateLabel(details.process)}`)}`,
    ];
  });
}

export function renderProcessKillCall(
  args: ProcessKillToolInput,
  theme: Theme,
  context: RenderContext,
): Component {
  return renderAuxCall(
    "process_kill",
    args.id,
    args.signal ?? "SIGTERM",
    theme,
    context,
  );
}

export function renderProcessKillResult(
  result: AgentToolResult<ProcessKillToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  if (result.details === undefined) {
    return fallbackAuxResult(result, options, theme, context);
  }
  return componentFor(context, (width) => {
    const details = result.details;
    const lines = [
      `${theme.fg(details.exited ? "success" : "warning", details.exited ? "✓" : "●")} ${theme.fg("accent", details.process.id)} ${theme.fg("muted", `${details.signal} · ${details.exited ? stateLabel(details.process) : "still running"}`)}`,
      ...outputLines(details.output.content, width, options.expanded, theme),
    ];
    if (options.expanded) {
      lines.splice(1, 0, ...outputMetadata(details.output).flatMap((line) =>
        styledWrappedLines(line, width, (value) => theme.fg("dim", value))
      ));
    }
    return lines;
  });
}

export function renderProcessListCall(
  args: ProcessListToolInput,
  theme: Theme,
  context: RenderContext,
): Component {
  return renderAuxCall(
    "process_list",
    undefined,
    args.include_completed === true ? "including completed" : "active",
    theme,
    context,
  );
}

function listStatusLine(
  status: ManagedProcessStatus | HistoricalProcessStatus,
  theme: Theme,
): string {
  if (status.state === "historical") {
    return `${theme.fg("dim", "○")} ${theme.fg("accent", status.id)} ${theme.fg("muted", `historical${status.mode === undefined ? "" : ` · ${status.mode}`} · ${normalizeCommandLine(status.command ?? "command unknown")}`)}`;
  }
  return `${processResultSummary(status, theme)} ${theme.fg("dim", `· ${normalizeCommandLine(status.command)}`)}`;
}

export function renderProcessListResult(
  result: AgentToolResult<ProcessListToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  if (result.details === undefined) {
    return fallbackAuxResult(result, options, theme, context);
  }
  return componentFor(context, (width) => {
    const processes = result.details.processes;
    if (processes.length === 0) return [theme.fg("dim", "no processes")];
    const shown = options.expanded
      ? processes
      : processes.slice(0, LIST_PREVIEW_RECORDS);
    const lines = shown.flatMap((status) => {
      const summary = listStatusLine(status, theme);
      if (!options.expanded) return [summary];
      const outputSummary = status.state === "historical"
        ? `output ${status.output.totalBytes ?? "?"} bytes/${status.output.totalLines ?? "?"} lines`
        : `output ${status.output.totalBytes} bytes/${status.output.totalLines} lines · cursor ${status.output.deliveredCursor}`;
      return [
        summary,
        theme.fg("dim", outputSummary),
        ...(status.state === "historical"
          ? styledWrappedLines(status.reason, width, (value) =>
              theme.fg("dim", value)
            )
          : []),
        ...(status.output.spillPath === undefined
          ? []
          : styledWrappedLines(
              `spill ${status.output.spillPath}`,
              width,
              (value) => theme.fg("dim", value),
            )),
      ];
    });
    if (shown.length < processes.length) {
      lines.push(theme.fg("muted", `… ${processes.length - shown.length} more`));
    }
    return lines;
  });
}
