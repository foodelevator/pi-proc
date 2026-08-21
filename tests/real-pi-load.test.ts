import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentToolResult,
  type ExtensionUIContext,
  SessionManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_NOTIFICATION_MESSAGE_TYPE } from "../background-processes/notification-scheduler";
import { PROCESS_RUNTIME_END_ENTRY_TYPE } from "../background-processes/persistence";
import { RUNNING_PROCESSES_WIDGET_KEY } from "../background-processes/ui";
import type {
  ProcessKillToolDetails,
  ProcessKillToolInput,
} from "../background-processes/tools/process-kill";
import type {
  ProcessListToolDetails,
  ProcessListToolInput,
} from "../background-processes/tools/process-list";
import type {
  ProcessReadToolDetails,
  ProcessReadToolInput,
} from "../background-processes/tools/process-read";
import type {
  ProcessWriteToolDetails,
  ProcessWriteToolInput,
} from "../background-processes/tools/process-write";

interface RuntimeTool<Input, Details> {
  execute: (toolCallId: string, params: Input) => Promise<AgentToolResult<Details>>;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("real Pi runtime loading", () => {
  it("registers and disposes the namespaced widget through real Pi TUI bindings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pibg-real-widget-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pibg-real-widget-agent-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [process.cwd()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;
    let started = false;

    try {
      await loader.reload();
      const created = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["bash", "process_kill"],
      });
      session = created.session;
      const baseUI = session.extensionRunner.getUIContext();
      const widgetCalls: Array<{
        key: string;
        content: unknown;
        options: unknown;
      }> = [];
      const probeTheme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme;
      const uiContext = {
        ...baseUI,
        theme: probeTheme,
        setWidget(key: string, content: unknown, options?: unknown) {
          widgetCalls.push({ key, content, options });
        },
      } as ExtensionUIContext;
      await session.bindExtensions({ mode: "tui", uiContext });
      started = true;
      expect(widgetCalls).toEqual([]);

      const bash = session.state.tools.find((tool) => tool.name === "bash");
      if (bash === undefined) throw new Error("Managed bash tool was not active");
      await bash.execute("real-widget-process", {
        command: "sleep 30",
        mode: "background",
      });

      expect(widgetCalls).toHaveLength(1);
      expect(widgetCalls[0]).toMatchObject({
        key: RUNNING_PROCESSES_WIDGET_KEY,
        options: { placement: "aboveEditor" },
      });
      const factory = widgetCalls[0]?.content;
      if (typeof factory !== "function") throw new Error("Expected widget factory");
      const component = (factory as (
        tui: { requestRender(): void },
        theme: ExtensionUIContext["theme"],
      ) => Component)({ requestRender() {} }, uiContext.theme);
      const lines = component.render(50);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("p1");
      expect(lines[0]).toContain("background");

      const processKill = session.state.tools.find(
        (tool) => tool.name === "process_kill",
      );
      if (processKill === undefined) throw new Error("Process kill tool was not active");
      await processKill.execute("real-widget-kill", {
        id: "p1",
        signal: "SIGKILL",
      });
      expect(widgetCalls.at(-1)).toMatchObject({
        key: RUNNING_PROCESSES_WIDGET_KEY,
        content: undefined,
      });

      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "reload",
      });
      started = false;
      expect(widgetCalls.at(-1)).toMatchObject({
        key: RUNNING_PROCESSES_WIDGET_KEY,
        content: undefined,
      });
    } finally {
      try {
        if (started) {
          await session?.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
        }
      } finally {
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }
  });

  it("loads and executes detached RPC mode through AgentSession tool precedence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pibg-real-load-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pibg-real-load-agent-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [process.cwd()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;

    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const created = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [
          "bash",
          "process_read",
          "process_write",
          "process_kill",
          "process_list",
        ],
      });
      session = created.session;
      const notificationCalls: Array<{ message: unknown; options: unknown }> = [];
      vi.spyOn(session, "sendCustomMessage").mockImplementation(
        (message, sendOptions) => {
          notificationCalls.push({ message, options: sendOptions });
          return Promise.resolve();
        },
      );
      await session.bindExtensions({ mode: "rpc" });

      const bash = session.state.tools.find((tool) => tool.name === "bash");
      const processRead = session.state.tools.find(
        (tool) => tool.name === "process_read",
      ) as RuntimeTool<ProcessReadToolInput, ProcessReadToolDetails> | undefined;
      const processWrite = session.state.tools.find(
        (tool) => tool.name === "process_write",
      ) as RuntimeTool<ProcessWriteToolInput, ProcessWriteToolDetails> | undefined;
      const processKill = session.state.tools.find(
        (tool) => tool.name === "process_kill",
      ) as RuntimeTool<ProcessKillToolInput, ProcessKillToolDetails> | undefined;
      const processList = session.state.tools.find(
        (tool) => tool.name === "process_list",
      ) as RuntimeTool<ProcessListToolInput, ProcessListToolDetails> | undefined;
      if (
        bash === undefined
        || processRead === undefined
        || processWrite === undefined
        || processKill === undefined
        || processList === undefined
      ) {
        throw new Error("Managed process tools were not active");
      }
      expect(bash.parameters).toMatchObject({
        properties: {
          mode: {
            type: "string",
            enum: ["wait", "background", "monitor"],
          },
        },
      });
      expect(session.systemPrompt).toContain(
        "Execute bash commands, optionally as managed background or monitor processes",
      );
      expect(session.systemPrompt).toContain(
        "Read combined stdout/stderr from an active or completed managed process",
      );
      expect(session.systemPrompt).toContain(
        "process_write does not add a newline",
      );

      const result = await bash.execute("real-load-smoke", {
        command: "printf real-load-ok",
      });
      expect(result).toEqual({
        content: [{ type: "text", text: "real-load-ok" }],
        details: undefined,
      });
      const releasePath = join(cwd, "release-background");
      const markerPath = join(cwd, "background-finished");
      const detachedCommand =
        `for _ in {1..100}; do if [ -f ${JSON.stringify(releasePath)} ]; then printf detached-smoke; printf done > ${JSON.stringify(markerPath)}; exit 0; fi; sleep 0.01; done; exit 124`;
      const background = await bash.execute("real-load-rpc-background", {
        command: detachedCommand,
        mode: "background",
      });
      const backgroundContent = background.content[0];
      if (backgroundContent?.type !== "text") {
        throw new Error("Expected detached text result");
      }
      expect(backgroundContent.text).toMatch(
        /^Started background process `p1` \(PID \d+\)\.$/,
      );
      expect(background.details).toMatchObject({
        process: {
          kind: "started",
          id: "p1",
          mode: "background",
          command: detachedCommand,
        },
      });
      expect(existsSync(markerPath)).toBe(false);

      writeFileSync(releasePath, "release", "utf8");
      await waitUntil(() => existsSync(markerPath), 1_000);
      await waitUntil(async () => {
        const listed = await processList.execute("real-list", {
          include_completed: true,
        });
        return listed.details.processes.some((process) =>
          process.id === "p1" && process.state === "completed"
        );
      });
      await waitUntil(() => notificationCalls.some(({ message }) =>
        (message as { details?: { processes?: Array<{ id?: string }> } })
          .details?.processes?.some((process) => process.id === "p1") === true
      ));
      const firstNotification = notificationCalls.find(({ message }) =>
        (message as { details?: { processes?: Array<{ id?: string }> } })
          .details?.processes?.some((process) => process.id === "p1") === true
      );
      expect(firstNotification).toMatchObject({
        message: {
          customType: PROCESS_NOTIFICATION_MESSAGE_TYPE,
          display: true,
          details: {
            processes: [{
              id: "p1",
              events: ["completed"],
              status: { state: "completed" },
              output: { content: "detached-smoke" },
            }],
          },
        },
        options: { triggerTurn: true, deliverAs: "steer" },
      });
      const detachedOutput = await processRead.execute("real-read", {
        id: "p1",
        start: 0,
      });
      expect(detachedOutput.details).toMatchObject({
        process: { id: "p1", state: "completed" },
        output: { content: "detached-smoke" },
      });

      const stdinProcess = await bash.execute("real-stdin-background", {
        command: "data=$(cat); printf '<%s>' \"$data\"",
        mode: "background",
      });
      expect(stdinProcess.details).toMatchObject({
        process: { id: "p2", mode: "background" },
      });
      await processWrite.execute("real-write", {
        id: "p2",
        data: "no-newline",
        close: true,
      });
      await waitUntil(async () => {
        const listed = await processList.execute("real-list-stdin", {
          include_completed: true,
        });
        return listed.details.processes.some((process) =>
          process.id === "p2" && process.state === "completed"
        );
      });
      expect((await processRead.execute("real-read-stdin", {
        id: "p2",
        start: 0,
      })).details.output.content).toBe("<no-newline>");

      await bash.execute("real-kill-background", {
        command: "printf kill-ready; sleep 30",
        mode: "background",
      });
      await waitUntil(async () => {
        const snapshot = await processRead.execute("real-kill-ready", {
          id: "p3",
          start: 0,
        });
        return snapshot.details.output.content === "kill-ready";
      });
      const killed = await processKill.execute("real-kill", {
        id: "p3",
        signal: "SIGKILL",
      });
      expect(killed.details).toMatchObject({
        signal: "SIGKILL",
        exited: true,
        process: { id: "p3", state: "completed", exitSignal: "SIGKILL" },
        output: { content: "kill-ready" },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(notificationCalls.some(({ message }) =>
        (message as { details?: { processes?: Array<{ id?: string }> } })
          .details?.processes?.some((process) => process.id === "p3") === true
      )).toBe(false);

      await bash.execute("real-monitor-notification", {
        command: "printf stderr-first >&2; sleep 0.02; printf stdout-second",
        mode: "monitor",
      });
      await waitUntil(() => notificationCalls.some(({ message }) =>
        (message as { details?: { processes?: Array<{ id?: string }> } })
          .details?.processes?.some((process) => process.id === "p4") === true
      ));
      const monitorNotification = notificationCalls.find(({ message }) =>
        (message as { details?: { processes?: Array<{ id?: string }> } })
          .details?.processes?.some((process) => process.id === "p4") === true
      );
      expect(monitorNotification).toMatchObject({
        message: {
          details: {
            processes: [{
              id: "p4",
              events: ["stdout", "completed"],
              output: { content: "stderr-firststdout-second" },
            }],
          },
        },
      });
    } finally {
      try {
        await session?.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }
  });

  it("releases a notification that expires in the real last-turn-to-settled gap", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pibg-real-settled-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pibg-real-settled-agent-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [process.cwd()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;

    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const created = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["bash", "process_list"],
      });
      session = created.session;
      const notifications: Array<{ message: unknown; options: unknown }> = [];
      vi.spyOn(session, "sendCustomMessage").mockImplementation(
        (message, options) => {
          notifications.push({ message, options });
          return Promise.resolve();
        },
      );
      await session.bindExtensions({ mode: "rpc" });
      const bash = session.state.tools.find((tool) => tool.name === "bash");
      const processList = session.state.tools.find(
        (tool) => tool.name === "process_list",
      ) as RuntimeTool<ProcessListToolInput, ProcessListToolDetails> | undefined;
      if (bash === undefined || processList === undefined) {
        throw new Error("Managed process tools were not active");
      }

      const lifecycle = session as unknown as {
        _isAgentRunActive: boolean;
        _emitAgentSettled: () => Promise<void>;
      };
      lifecycle._isAgentRunActive = true;
      await session.extensionRunner.emit({
        type: "turn_end",
        turnIndex: 0,
        message: {
          role: "custom",
          customType: "last-turn-fixture",
          content: "last turn ended",
          display: false,
          timestamp: Date.now(),
        },
        toolResults: [],
      });
      expect(session.isIdle).toBe(false);

      await bash.execute("last-turn-background", {
        command: "printf last-turn-gap",
        mode: "background",
      });
      await waitUntil(async () => {
        const listed = await processList.execute("last-turn-list", {
          include_completed: true,
        });
        return listed.details.processes.some((process) =>
          process.id === "p1" && process.state === "completed"
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(notifications).toEqual([]);

      await lifecycle._emitAgentSettled();

      expect(session.isIdle).toBe(true);
      await waitUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        message: {
          customType: PROCESS_NOTIFICATION_MESSAGE_TYPE,
          details: {
            processes: [{
              id: "p1",
              events: ["completed"],
              output: { content: "last-turn-gap" },
            }],
          },
        },
        options: { triggerTurn: true, deliverAs: "steer" },
      });
    } finally {
      try {
        await session?.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }
  });

  it("persists and reconstructs across real reload/new lifecycle events", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pibg-real-lifecycle-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pibg-real-lifecycle-agent-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [process.cwd()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    const sessionManager = SessionManager.inMemory(cwd);
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;
    let runtimeStarted = false;

    try {
      await loader.reload();
      const created = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager,
        tools: ["bash", "process_read", "process_list"],
      });
      session = created.session;
      await session.bindExtensions({ mode: "rpc" });
      runtimeStarted = true;
      const bash = session.state.tools.find((tool) => tool.name === "bash");
      const processRead = session.state.tools.find(
        (tool) => tool.name === "process_read",
      ) as RuntimeTool<ProcessReadToolInput, ProcessReadToolDetails> | undefined;
      const processList = session.state.tools.find(
        (tool) => tool.name === "process_list",
      ) as RuntimeTool<ProcessListToolInput, ProcessListToolDetails> | undefined;
      if (bash === undefined || processRead === undefined || processList === undefined) {
        throw new Error("Lifecycle tools were not active");
      }

      expect((await bash.execute("before-reload", {
        command: "printf before-reload",
        mode: "background",
      })).details).toMatchObject({ process: { id: "p1" } });
      await waitUntil(async () =>
        (await processList.execute("wait-p1", { include_completed: true }))
          .details.processes.some((process) =>
            process.id === "p1" && process.state === "completed"
          )
      );

      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "reload",
      });
      runtimeStarted = false;
      const endingEntry = sessionManager.getEntries().find((entry) =>
        entry.type === "custom"
        && entry.customType === PROCESS_RUNTIME_END_ENTRY_TYPE
      );
      expect(endingEntry).toMatchObject({
        type: "custom",
        customType: PROCESS_RUNTIME_END_ENTRY_TYPE,
        data: {
          reason: "reload",
          processes: [{ id: "p1" }],
        },
      });

      await session.extensionRunner.emit({
        type: "session_start",
        reason: "reload",
      });
      runtimeStarted = true;
      await expect(processRead.execute("historical-p1", { id: "p1" }))
        .rejects.toThrow("had already completed before reload");
      expect((await processList.execute("list-reloaded", {
        include_completed: true,
      })).details.processes).toEqual([
        expect.objectContaining({
          id: "p1",
          state: "historical",
          shutdownReason: "reload",
        }),
      ]);
      expect((await bash.execute("after-reload", {
        command: "true",
        mode: "background",
      })).details).toMatchObject({ process: { id: "p2" } });

      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "new",
      });
      runtimeStarted = false;
      sessionManager.newSession();
      await session.extensionRunner.emit({
        type: "session_start",
        reason: "new",
      });
      runtimeStarted = true;
      expect((await processList.execute("new-is-empty", {
        include_completed: true,
      })).details.processes).toEqual([]);
      expect((await bash.execute("new-p1", {
        command: "true",
        mode: "background",
      })).details).toMatchObject({ process: { id: "p1" } });
    } finally {
      try {
        if (runtimeStarted) {
          await session?.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
        }
      } finally {
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }
  });

  it("restores resume-like persisted history in a real extension runtime", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pibg-real-resume-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pibg-real-resume-agent-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [process.cwd()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry(PROCESS_RUNTIME_END_ENTRY_TYPE, {
      kind: "process-runtime-ending",
      version: 1,
      runtimeId: "prior-resumed-runtime",
      endedAt: 100,
      reason: "quit",
      processes: [{
        id: "p8",
        command: "old watcher",
        cwd,
        mode: "monitor",
        pid: 808,
        startedAt: 10,
        state: "running",
        timedOut: false,
        stdinClosed: false,
        output: {
          totalBytes: 9,
          totalLines: 1,
          deliveredCursor: 0,
          spilled: true,
          spillPath: "/tmp/old-watcher.log",
        },
      }],
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;

    try {
      await loader.reload();
      const created = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager,
        tools: ["bash", "process_list"],
      });
      session = created.session;
      await session.bindExtensions({ mode: "rpc" });
      const bash = session.state.tools.find((tool) => tool.name === "bash");
      const processList = session.state.tools.find(
        (tool) => tool.name === "process_list",
      ) as RuntimeTool<ProcessListToolInput, ProcessListToolDetails> | undefined;
      if (bash === undefined || processList === undefined) {
        throw new Error("Resume-like tools were not active");
      }

      expect((await processList.execute("resumed-history", {
        include_completed: true,
      })).details.processes).toMatchObject([{
        id: "p8",
        state: "historical",
        priorState: "running",
        shutdownReason: "quit",
        output: { spillPath: "/tmp/old-watcher.log" },
      }]);
      expect((await bash.execute("resumed-next", {
        command: "true",
        mode: "background",
      })).details).toMatchObject({ process: { id: "p9" } });
    } finally {
      try {
        await session?.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }
  });

  it("keeps a real print-mode session wait-only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pibg-real-print-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pibg-real-print-agent-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [process.cwd()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;

    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const created = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [
          "bash",
          "process_read",
          "process_write",
          "process_kill",
          "process_list",
        ],
      });
      session = created.session;
      await session.bindExtensions({ mode: "print" });

      const bash = session.state.tools.find((tool) => tool.name === "bash");
      const processList = session.state.tools.find(
        (tool) => tool.name === "process_list",
      ) as RuntimeTool<ProcessListToolInput, ProcessListToolDetails> | undefined;
      if (bash === undefined || processList === undefined) {
        throw new Error("Managed process tools were not active");
      }
      const waited = await bash.execute("real-print-wait", {
        command: "printf print-wait-ok",
      });
      expect(waited).toEqual({
        content: [{ type: "text", text: "print-wait-ok" }],
        details: undefined,
      });
      await expect(bash.execute("real-print-background", {
        command: "true",
        mode: "background",
      })).rejects.toThrow(
        "available only in TUI and RPC modes; current mode is `print`",
      );
      expect((await processList.execute("real-print-list", {})).details)
        .toMatchObject({ includeCompleted: false, processes: [] });
    } finally {
      try {
        await session?.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }
  });
});
