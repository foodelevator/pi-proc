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
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

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
      const detachedOutput = await processRead.execute("real-read", {
        id: "p1",
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
      expect((await processRead.execute("real-read-stdin", { id: "p2" }))
        .details.output.content).toBe("<no-newline>");

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
