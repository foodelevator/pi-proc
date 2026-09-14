import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";

import {
  getAgentDir,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";

import type { OutputStore } from "./output-store";
import type { PiSessionEnvironment, ProcessExecution, ProcessStdinMode } from "./types";

export const POST_EXIT_PIPE_IDLE_MS = 100;

export type SupportedPlatform = "darwin" | "linux";

export interface DetachedProcessGroupTracker {
  track: (pid: number) => void;
  untrack: (pid: number) => void;
}

const trackedDetachedProcessGroups = new Set<number>();
let exitCleanupInstalled = false;

/**
 * Pi's detached-child registry is not part of its root exports, and its package
 * exports block direct access to the internal shell module. Keep an equivalent
 * local registry so Pi's process.exit()-based crash paths still trigger cleanup.
 */
export function killTrackedDetachedProcessGroups(): void {
  for (const pid of trackedDetachedProcessGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group may already have exited, or the dying process may lack permission.
    }
  }
}

function handleProcessExit(): void {
  exitCleanupInstalled = false;
  killTrackedDetachedProcessGroups();
}

const defaultDetachedProcessGroupTracker: DetachedProcessGroupTracker = {
  track(pid) {
    trackedDetachedProcessGroups.add(pid);
    if (!exitCleanupInstalled) {
      exitCleanupInstalled = true;
      process.once("exit", handleProcessExit);
    }
  },
  untrack(pid) {
    trackedDetachedProcessGroups.delete(pid);
    if (trackedDetachedProcessGroups.size === 0 && exitCleanupInstalled) {
      process.removeListener("exit", handleProcessExit);
      exitCleanupInstalled = false;
    }
  },
};

export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

export interface ShellProcessCompletion {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  error?: Error;
}

export interface SpawnShellOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputStore: OutputStore;
  stdin?: ProcessStdinMode;
  shellPath?: string;
  /** Test seam; production callers should use Pi's getShellConfig resolution. */
  shellConfig?: ShellConfig;
  pipeIdleMs?: number;
  /** Test/custom-runtime seam. Defaults to pi-proc's process-exit cleanup registry. */
  detachedProcessGroupTracker?: DetachedProcessGroupTracker;
  onStdoutActivity?: (chunk: Buffer) => void;
  onOutput?: (source: "stdout" | "stderr", chunk: Buffer) => void;
  onCallbackError?: (error: Error) => void;
}

export interface SpawnedShellProcess {
  child: ProcessExecution["child"];
  /** Resolves only after Node confirms that the executable was spawned. */
  spawned: Promise<number>;
  /** Resolves after exit and pipe end/close, or post-exit pipe idleness. */
  completion: Promise<ShellProcessCompletion>;
}

export class UnsupportedPlatformError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(
      `pi-proc supports only macOS and Linux; current platform is ${platform}`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

export function assertSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): asserts platform is SupportedPlatform {
  if (platform !== "darwin" && platform !== "linux") {
    throw new UnsupportedPlatformError(platform);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requireNonNegativeDelay(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be between 0 and 2147483647 milliseconds`);
  }
  return value;
}

/**
 * Mirror Pi's bash environment: inherit the process environment, put Pi's managed
 * binary directory on PATH, remove stale session values, then inject this session.
 */
export function createPiProcessEnvironment(
  session: PiSessionEnvironment = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnvironment };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path")
    ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const binDirectory = join(getAgentDir(), "bin");
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  if (!pathEntries.includes(binDirectory)) {
    env[pathKey] = [binDirectory, currentPath].filter(Boolean).join(delimiter);
  }

  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;

  if (session.sessionId !== undefined) env.PI_SESSION_ID = session.sessionId;
  if (session.sessionFile) env.PI_SESSION_FILE = session.sessionFile;
  if (session.provider) env.PI_PROVIDER = session.provider;
  if (session.model) env.PI_MODEL = session.model;
  if (session.reasoningLevel) {
    env.PI_REASONING_LEVEL = session.reasoningLevel;
  }

  return env;
}

/** Spawn one command in a new POSIX process group using Pi's shell resolution. */
export function spawnShellProcess(
  command: string,
  options: SpawnShellOptions,
): SpawnedShellProcess {
  assertSupportedPlatform();
  const pipeIdleMs = requireNonNegativeDelay(
    options.pipeIdleMs ?? POST_EXIT_PIPE_IDLE_MS,
    "pipeIdleMs",
  );
  const shellConfig = options.shellConfig ?? getShellConfig(options.shellPath);
  if (shellConfig.commandTransport === "stdin") {
    throw new Error(
      "stdin command transport is unsupported on POSIX because stdin is reserved for process input",
    );
  }

  const processGroupTracker = options.detachedProcessGroupTracker
    ?? defaultDetachedProcessGroupTracker;
  // Node's overloads lose the fixed stdout/stderr types when stdin is a union.
  const child = spawn(
    shellConfig.shell,
    [...shellConfig.args, command],
    {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      // Ending an empty pipe still makes rg search stdin instead of the cwd.
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  ) as SpawnedShellProcess["child"];
  child.stdin?.on("error", () => {
    // Individual writes observe errors themselves. This listener also prevents an
    // unhandled EPIPE when the process exits between caller writes.
  });

  let resolveSpawned!: (pid: number) => void;
  let rejectSpawned!: (error: Error) => void;
  const spawned = new Promise<number>((resolve, reject) => {
    resolveSpawned = resolve;
    rejectSpawned = reject;
  });

  let resolveCompletion!: (completion: ShellProcessCompletion) => void;
  const completion = new Promise<ShellProcessCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  let didSpawn = false;
  let settled = false;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let processError: Error | undefined;
  let stdoutEnded = false;
  let stderrEnded = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let trackedPid: number | undefined;

  const reportCallbackError = (error: unknown): void => {
    try {
      options.onCallbackError?.(asError(error));
    } catch {
      // Lifecycle callbacks must never destabilize process supervision.
    }
  };

  const cleanup = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    child.removeListener("spawn", handleSpawn);
    child.removeListener("error", handleError);
    child.removeListener("exit", handleExit);
    child.removeListener("close", handleClose);
    child.stdout.removeListener("data", handleStdout);
    child.stderr.removeListener("data", handleStderr);
    child.stdout.removeListener("end", handleStdoutEnd);
    child.stderr.removeListener("end", handleStderrEnd);
  };

  const finalize = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (trackedPid !== undefined) {
      try {
        processGroupTracker.untrack(trackedPid);
      } catch (error) {
        reportCallbackError(error);
      }
      trackedPid = undefined;
    }
    child.stdout.destroy();
    child.stderr.destroy();
    options.outputStore.close();
    resolveCompletion({
      exitCode,
      exitSignal,
      ...(processError === undefined ? {} : { error: processError }),
    });
  };

  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(finalize, pipeIdleMs);
  };

  const maybeFinalizeAfterExit = (): void => {
    if (exited && stdoutEnded && stderrEnded) finalize();
  };

  const append = (source: "stdout" | "stderr", value: Buffer): void => {
    if (settled) return;
    const chunk = Buffer.from(value);
    try {
      options.outputStore.append(chunk);
    } catch (error) {
      processError = asError(error);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Completion still reports the storage failure if the child already left.
        }
      }
      finalize();
      return;
    }

    try {
      options.onOutput?.(source, chunk);
    } catch (error) {
      reportCallbackError(error);
    }
    if (source === "stdout") {
      try {
        options.onStdoutActivity?.(chunk);
      } catch (error) {
        reportCallbackError(error);
      }
    }
    if (exited) armIdleTimer();
  };

  function handleStdout(value: Buffer): void {
    append("stdout", value);
  }

  function handleStderr(value: Buffer): void {
    append("stderr", value);
  }

  function handleStdoutEnd(): void {
    stdoutEnded = true;
    maybeFinalizeAfterExit();
  }

  function handleStderrEnd(): void {
    stderrEnded = true;
    maybeFinalizeAfterExit();
  }

  function handleSpawn(): void {
    didSpawn = true;
    if (child.pid === undefined) {
      const error = new Error("Spawned shell did not provide a process ID");
      rejectSpawned(error);
      processError = error;
      finalize();
      return;
    }
    try {
      processGroupTracker.track(child.pid);
      trackedPid = child.pid;
    } catch (error) {
      const trackingError = asError(error);
      rejectSpawned(trackingError);
      processError = trackingError;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process may already have exited.
      }
      finalize();
      return;
    }
    resolveSpawned(child.pid);
  }

  function handleError(error: Error): void {
    processError = error;
    if (!didSpawn) rejectSpawned(error);
    finalize();
  }

  function handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    maybeFinalizeAfterExit();
    if (!settled) armIdleTimer();
  }

  function handleClose(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (!exited) {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    }
    finalize();
  }

  child.once("spawn", handleSpawn);
  child.once("error", handleError);
  child.once("exit", handleExit);
  child.once("close", handleClose);
  child.stdout.on("data", handleStdout);
  child.stderr.on("data", handleStderr);
  child.stdout.once("end", handleStdoutEnd);
  child.stderr.once("end", handleStderrEnd);

  return { child, spawned, completion };
}
