import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  PROCESS_NOTIFICATION_MESSAGE_TYPE,
  registerProcessNotificationRenderer,
  type ProcessNotificationBatchDetails,
  type ProcessNotificationMessage,
} from "../background-processes/notification-scheduler";
import { createBashTool } from "../background-processes/tools/bash";
import { createProcessKillTool } from "../background-processes/tools/process-kill";
import { createProcessListTool } from "../background-processes/tools/process-list";
import { createProcessReadTool } from "../background-processes/tools/process-read";
import { createProcessWriteTool } from "../background-processes/tools/process-write";
import type { OutputReadResult } from "../background-processes/types";

function testTheme(marker = ""): Theme {
  return {
    fg: (_color: string, text: string) => `${marker}\u001b[36m${text}\u001b[39m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  } as Theme;
}

function output(content: string): OutputReadResult {
  const bytes = Buffer.byteLength(content);
  return {
    content,
    requestedRange: { start: 0, end: bytes + 12 },
    returnedRange: { start: 12, end: bytes + 12 },
    omittedRanges: [{ start: 0, end: 12 }],
    truncation: { truncated: true, by: ["bytes"], omittedBytes: 12 },
    cursor: { before: 0, after: bytes + 12, advanced: true },
    totalBytes: bytes + 12,
    totalLines: content.split("\n").length,
    returnedBytes: bytes,
    returnedLines: content.split("\n").length,
    spillPath: "/tmp/pibg-spill.log",
  };
}

function details(content: string): ProcessNotificationBatchDetails {
  const snapshot = output(content);
  return {
    kind: "process-notification",
    version: 1,
    windowStartedAt: 1_000,
    flushedAt: 3_000,
    limits: { maxBytes: 50 * 1024, maxLines: 2_000 },
    returned: { bytes: snapshot.returnedBytes, lines: snapshot.returnedLines },
    processes: [{
      id: "p1",
      events: ["stdout", "completed"],
      status: {
        id: "p1",
        state: "completed",
        command: "printf secret-output",
        cwd: "/tmp",
        mode: "monitor",
        pid: 101,
        startedAt: 1_000,
        completedAt: 3_000,
        durationMs: 2_000,
        exitCode: 7,
        exitSignal: null,
        timedOut: false,
        stdinClosed: true,
        output: {
          totalBytes: snapshot.totalBytes,
          totalLines: snapshot.totalLines,
          deliveredCursor: snapshot.totalBytes,
          spilled: true,
          spillPath: snapshot.spillPath,
        },
      },
      completion: {
        completedAt: 3_000,
        exitCode: 7,
        exitSignal: null,
        timedOut: false,
      },
      output: snapshot,
    }],
  };
}

function plain(lines: string[]): string {
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

interface TestRenderContext {
  args: unknown;
  toolCallId: string;
  invalidate(): void;
  lastComponent: Component | undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

function context<T>(args: T): Omit<TestRenderContext, "args"> & { args: T } {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
  };
}

function assertWidths(lines: string[], width: number): void {
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
}

describe("process notification renderer", () => {
  it("keeps collapsed batches compact and reveals structured details only when expanded", () => {
    let renderer: ((...args: never[]) => unknown) | undefined;
    const pi = {
      registerMessageRenderer(type: string, value: (...args: never[]) => unknown) {
        expect(type).toBe(PROCESS_NOTIFICATION_MESSAGE_TYPE);
        renderer = value;
      },
    } as unknown as ExtensionAPI;
    registerProcessNotificationRenderer(pi);
    if (renderer === undefined) throw new Error("Renderer was not registered");
    const batch = details("secret-output\n" + "x".repeat(2_000));
    const message: ProcessNotificationMessage = {
      customType: PROCESS_NOTIFICATION_MESSAGE_TYPE,
      content: "raw model-facing secret-output " + "z".repeat(20_000),
      display: true,
      details: batch,
    };

    const collapsed = renderer(
      message as never,
      { expanded: false, outputPad: 1 } as never,
      testTheme() as never,
    ) as { render(width: number): string[]; invalidate(): void };
    const collapsedLines = collapsed.render(38);
    expect(plain(collapsedLines)).toContain("p1");
    expect(plain(collapsedLines)).toContain("stdout+completed");
    expect(plain(collapsedLines)).toContain("exit 7");
    expect(plain(collapsedLines)).not.toContain("secret-output");
    expect(collapsedLines.length).toBeLessThanOrEqual(2);
    assertWidths(collapsedLines, 38);

    const expanded = renderer(
      message as never,
      { expanded: true, outputPad: 1 } as never,
      testTheme() as never,
    ) as { render(width: number): string[]; invalidate(): void };
    const expandedLines = expanded.render(42);
    const expandedText = plain(expandedLines);
    expect(expandedText).toContain("printf secret-output");
    expect(expandedText).toContain("requested [0,");
    expect(expandedText).toMatch(/omitted \[0,\s*12\)/);
    expect(expandedText).toContain("exit 7");
    expect(expandedText).toContain("/tmp/pibg-spill.log");
    expect(expandedText).toContain("secret-output");
    assertWidths(expandedLines, 42);
  });

  it("recomputes theme styling after component invalidation", () => {
    let marker = "old:";
    const theme = {
      fg: (_color: string, text: string) => `${marker}${text}`,
      bold: (text: string) => text,
    } as Theme;
    const component = createBashTool({ getManager: () => undefined })
      .renderCall?.(
        { command: "true" },
        theme,
        context({ command: "true" }),
      );
    if (component === undefined) throw new Error("Missing bash call renderer");

    expect(component.render(80).join("\n")).toContain("old:");
    marker = "new:";
    expect(component.render(80).join("\n")).not.toContain("new:");
    component.invalidate();
    expect(component.render(80).join("\n")).toContain("new:");
  });
});

describe("managed process tool renderers", () => {
  const unavailable = { getManager: () => undefined };
  const bash = createBashTool(unavailable);
  const processRead = createProcessReadTool(unavailable);
  const processWrite = createProcessWriteTool(unavailable);
  const processKill = createProcessKillTool(unavailable);
  const processList = createProcessListTool(unavailable);

  it("registers compact call and result renderers for bash and every auxiliary tool", () => {
    for (const tool of [bash, processRead, processWrite, processKill, processList]) {
      expect(tool.renderCall, `${tool.name} renderCall`).toBeTypeOf("function");
      expect(tool.renderResult, `${tool.name} renderResult`).toBeTypeOf("function");
    }
  });

  it("uses familiar bash call styling and never dumps detached output while collapsed", () => {
    if (bash.renderCall === undefined || bash.renderResult === undefined) {
      throw new Error("Missing bash renderers");
    }
    const callContext = context({
      command: "npm test",
      mode: "monitor" as const,
    });
    const call = bash.renderCall(
      { command: "npm test", mode: "monitor" },
      testTheme(),
      callContext,
    );
    expect(plain(call.render(80))).toContain("$ npm test");
    expect(plain(call.render(80))).toContain("monitor");

    const huge = "DO-NOT-DUMP-" + "x".repeat(10_000);
    const result: AgentToolResult<unknown> = {
      content: [{ type: "text", text: huge }],
      details: {
        process: {
          kind: "started",
          id: "p9",
          mode: "monitor",
          command: "npm test",
          cwd: "/tmp",
          pid: 9,
          startedAt: 1,
        },
        output: output(huge),
      },
    };
    const collapsed = bash.renderResult(
      result as never,
      { expanded: false, isPartial: false },
      testTheme(),
      context({ command: "npm test", mode: "monitor" as const }),
    );
    const collapsedText = plain(collapsed.render(50));
    expect(collapsedText).toContain("p9");
    expect(collapsedText).toContain("monitor");
    expect(collapsedText).not.toContain("DO-NOT-DUMP");
    assertWidths(collapsed.render(50), 50);

    const expanded = bash.renderResult(
      result as never,
      { expanded: true, isPartial: false },
      testTheme(),
      context({ command: "npm test", mode: "monitor" as const }),
    );
    expect(plain(expanded.render(50))).toContain("DO-NOT-DUMP");
    expect(plain(expanded.render(50))).toContain("/tmp/pibg-spill.log");
    assertWidths(expanded.render(50), 50);
  });

  it("preserves partial/error/expanded/truncation cues at narrow widths", () => {
    if (bash.renderResult === undefined) throw new Error("Missing bash renderer");
    const result = {
      content: [{ type: "text" as const, text: Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n") }],
      details: {
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          outputLines: 12,
          outputBytes: 80,
          totalLines: 100,
          totalBytes: 900,
          maxLines: 12,
          maxBytes: 80,
        },
        fullOutputPath: "/tmp/full.log",
      },
    };
    const partialContext = {
      ...context({ command: "printf lines" }),
      isPartial: true,
    };
    const partial = bash.renderResult(
      result as never,
      { expanded: false, isPartial: true },
      testTheme(),
      partialContext,
    );
    const partialText = plain(partial.render(24));
    expect(partialText).toContain("running");
    expect(partialText).toContain("earlier");
    expect(partialText).toContain("truncated");
    assertWidths(partial.render(24), 24);

    const errorContext = {
      ...context({ command: "bad" }),
      isError: true,
    };
    const failed = bash.renderResult(
      { content: [{ type: "text", text: "bad command" }], details: undefined },
      { expanded: false, isPartial: false },
      testTheme(),
      errorContext,
    );
    expect(plain(failed.render(24))).toContain("error");
    assertWidths(failed.render(24), 24);
  });
});
