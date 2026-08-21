import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("real Pi runtime loading", () => {
  it("loads and executes the override through AgentSession tool precedence", async () => {
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
      await session.bindExtensions({});

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
      await expect(
        bash.execute("real-load-headless-background", {
          command: "true",
          mode: "background",
        }),
      ).rejects.toThrow(
        "available only in TUI and RPC modes; current mode is `print`",
      );

      await session.bindExtensions({ mode: "rpc" });
      const background = await bash.execute("real-load-rpc-background", {
        command: "printf detached-smoke",
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
          command: "printf detached-smoke",
        },
      });

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
