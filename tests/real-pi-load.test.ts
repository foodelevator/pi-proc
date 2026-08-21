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
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
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
        tools: ["bash"],
      });
      session = created.session;
      await session.bindExtensions({ mode: "rpc" });

      const bash = session.state.tools.find((tool) => tool.name === "bash");
      if (bash === undefined) throw new Error("bash was not active");
      expect(bash.parameters).toMatchObject({
        properties: {
          mode: {
            type: "string",
            enum: ["wait", "background", "monitor"],
          },
        },
      });
      expect(session.systemPrompt).toContain(
        "Execute bash commands (ls, grep, find, etc.)",
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
        `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.01; done; printf detached-smoke > ${JSON.stringify(markerPath)}`;
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
      await waitUntil(() => existsSync(markerPath));

      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      session?.dispose();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
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
        tools: ["bash"],
      });
      session = created.session;
      await session.bindExtensions({ mode: "print" });

      const bash = session.state.tools.find((tool) => tool.name === "bash");
      if (bash === undefined) throw new Error("bash was not active");
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

      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      session?.dispose();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
