import type {
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessManagerEventListener } from "../background-processes/process-manager";
import type { ManagedProcessRecord } from "../background-processes/types";
import {
  createRunningProcessesWidget,
  installRunningProcessesWidget,
  normalizeCommandLine,
  RUNNING_PROCESSES_WIDGET_KEY,
} from "../background-processes/ui";
import { OutputStore } from "../background-processes/output-store";

function testTheme(): Theme {
  return {
    fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[39m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  } as Theme;
}

function record(
  id: string,
  overrides: Partial<ManagedProcessRecord> = {},
): ManagedProcessRecord {
  const outputStore = new OutputStore();
  return {
    id,
    command: "npm test -- --watch",
    cwd: "/tmp",
    mode: "monitor",
    child: {} as ManagedProcessRecord["child"],
    pid: 100,
    startedAt: 1_000,
    timedOut: false,
    stdinClosed: false,
    outputStore,
    get deliveredCursor() {
      return outputStore.deliveredCursor;
    },
    completion: new Promise(() => {}),
    ...overrides,
  };
}

class FakeProcessSource {
  records: ManagedProcessRecord[] = [];
  readonly listeners = new Set<ProcessManagerEventListener>();

  get activeRecords(): readonly ManagedProcessRecord[] {
    return this.records.filter((item) => item.completedAt === undefined);
  }

  subscribeEvents(listener: ProcessManagerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitCompleted(process: ManagedProcessRecord): void {
    process.completedAt = 2_000;
    process.exitCode = 0;
    process.exitSignal = null;
    for (const listener of this.listeners) {
      listener({
        type: "completed",
        process,
        completion: {
          completedAt: 2_000,
          exitCode: 0,
          exitSignal: null,
          timedOut: false,
        },
      });
    }
  }
}

function uiHarness(mode: ExtensionContext["mode"] = "tui") {
  const calls: Array<{
    key: string;
    content: unknown;
    options: unknown;
  }> = [];
  const ui = {
    setWidget(key: string, content: unknown, options: unknown) {
      calls.push({ key, content, options });
    },
  } as unknown as ExtensionUIContext;
  const ctx = { mode, ui } as ExtensionContext;
  return { calls, ctx };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("running process widget", () => {
  it("normalizes terminal controls and embedded command whitespace", () => {
    expect(normalizeCommandLine("printf a\n\u001b[31mred\u001b[0m\t  tail"))
      .toBe("printf a red tail");
  });

  it("renders one ANSI-safe width-bounded line per detached running process", () => {
    const source = new FakeProcessSource();
    source.records = [
      record("p2", { command: "npm\n test   -- --watch", startedAt: 1_000 }),
      record("p1", { mode: "background", command: "bun run dev", startedAt: 8_000 }),
      record("p3", { completedAt: 9_000, command: "completed" }),
    ];
    const widget = createRunningProcessesWidget(source, testTheme(), {
      now: () => 13_500,
    });

    const lines = widget.render(34);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "")))
      .toEqual([
        expect.stringMatching(/^● p1  background\s+5s  bun run/),
        expect.stringMatching(/^● p2  monitor\s+12s  npm test/),
      ]);
    expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
  });

  it("keeps mode columns aligned when process IDs reach two digits", () => {
    const source = new FakeProcessSource();
    source.records = [
      record("p1", { command: "first" }),
      record("p10", { command: "tenth" }),
    ];
    const widget = createRunningProcessesWidget(source, testTheme(), {
      now: () => 2_000,
    });
    const lines = widget.render(80).map((line) =>
      line.replace(/\u001b\[[0-9;]*m/g, "")
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]?.indexOf("monitor")).toBe(lines[1]?.indexOf("monitor"));
    expect(lines[0]).toMatch(/^● p1\s{3}monitor/);
    expect(lines[1]).toMatch(/^● p10\s{2}monitor/);
  });

  it("uses compact two-tone durations and aligns commands across different durations", () => {
    const theme = testTheme();
    const fg = vi.spyOn(theme, "fg");
    const source = new FakeProcessSource();
    source.records = [
      record("p1", { startedAt: 0, command: "first" }),
      record("p2", { startedAt: 255_232_000, command: "second" }),
    ];
    const widget = createRunningProcessesWidget(source, theme, {
      now: () => 255_233_000,
    });
    const lines = widget.render(80).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(lines[0]).toContain("2d22h53m53s");
    expect(lines[1]).toContain("1s");
    expect(lines[0]?.indexOf("first")).toBe(lines[1]?.indexOf("second"));
    for (const value of ["2", "22", "53", "1"]) {
      expect(fg).toHaveBeenCalledWith("muted", value);
    }
    for (const unit of ["d", "h", "m", "s"]) {
      expect(fg).toHaveBeenCalledWith("dim", unit);
    }
    for (const width of [1, 12, 24, 40]) {
      expect(widget.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("rolls elapsed time into larger units after invalidation", () => {
    const source = new FakeProcessSource();
    source.records = [record("p1", { startedAt: 0 })];
    let now = 59_000;
    const widget = createRunningProcessesWidget(source, testTheme(), { now: () => now });
    expect(widget.render(80).join("")).toContain("59");
    now = 60_000;
    widget.invalidate();
    expect(widget.render(80).join("").replace(/\u001b\[[0-9;]*m/g, "")).toContain("1m");
  });

  it("installs only while active, ticks once per second, and disposes every resource", () => {
    vi.useFakeTimers();
    const source = new FakeProcessSource();
    const { calls, ctx } = uiHarness();
    const controller = installRunningProcessesWidget(source, ctx);

    expect(calls).toEqual([]);
    expect(source.listeners.size).toBe(1);
    source.records.push(record("p1"));
    controller.refresh();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      key: RUNNING_PROCESSES_WIDGET_KEY,
      options: { placement: "aboveEditor" },
    });
    const factory = calls[0]?.content;
    if (typeof factory !== "function") throw new Error("Expected widget factory");
    const widgetFactory = factory as (
      tui: { requestRender(): void },
      theme: Theme,
    ) => Component;
    const requestRender = vi.fn();
    const component = widgetFactory({ requestRender }, testTheme());
    expect(component.render(80)).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestRender).toHaveBeenCalledTimes(1);

    const running = source.records[0];
    if (running === undefined) throw new Error("Missing process fixture");
    source.emitCompleted(running);
    expect(calls.at(-1)).toMatchObject({
      key: RUNNING_PROCESSES_WIDGET_KEY,
      content: undefined,
    });
    requestRender.mockClear();
    vi.advanceTimersByTime(5_000);
    expect(requestRender).not.toHaveBeenCalled();

    controller.dispose();
    controller.dispose();
    expect(source.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rpc", "print", "json"] as const)(
    "never registers in %s mode",
    (mode) => {
      const source = new FakeProcessSource();
      source.records = [record("p1")];
      const { calls, ctx } = uiHarness(mode);
      const controller = installRunningProcessesWidget(source, ctx);

      controller.refresh();
      controller.dispose();

      expect(calls).toEqual([]);
      expect(source.listeners.size).toBe(0);
    },
  );
});
