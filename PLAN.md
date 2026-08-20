# Implementation plan

## 1. Extension structure

Use a multi-file extension:

```text
background-processes/
├── index.ts
├── types.ts
├── process-manager.ts
├── output-store.ts
├── notification-scheduler.ts
├── persistence.ts
├── ui.ts
└── tools/
    ├── bash.ts
    ├── process-read.ts
    ├── process-write.ts
    ├── process-kill.ts
    └── process-list.ts
```

Keep spawning, buffering, notifications, and Pi integration isolated so each can be tested independently.

## 2. Core process manager

Create a session-scoped `ProcessManager` responsible for:

- Spawning detached POSIX process groups with piped stdin/stdout/stderr.
- Tracking public processes by IDs such as `p1`.
- Tracking foreground `wait` executions privately until detached.
- Sending signals to entire process groups.
- Handling timeout, exit, spawn errors, and stdin state.
- Retaining completed managed processes until session shutdown.
- Producing specific errors for active, completed, historical, and unknown IDs.

A managed record should contain:

```ts
{
  id,
  command,
  cwd,
  mode,
  child,
  pid,
  startedAt,
  completedAt?,
  exitCode?,
  exitSignal?,
  timedOut,
  stdinClosed,
  lastSignal?,
  outputStore,
  deliveredCursor
}
```

Ordinary `wait` executions remain private and disappear after completion. Promote them into managed records only when steering detaches them.

## 3. Shell spawning

Use Pi’s exported `getShellConfig()` and mirror built-in bash behavior:

- Run the command through Bash.
- Set `detached: true` to create a process group.
- Use `stdio: ["pipe", "pipe", "pipe"]`.
- Preserve Pi’s environment behavior, including `PI_SESSION_*`, model, provider, and reasoning variables.
- Listen to stdout and stderr separately, but append both to one combined transcript in callback order.
- Only stdout activity informs the monitor scheduler.
- Implement Pi-like post-exit pipe-idle handling so inherited descriptors do not hang completion forever.

Document that shell-level `&`, `nohup`, and daemonization are unsupported; callers should use the tool’s mode instead.

## 4. Combined output store

Implement a Pi-like accumulator:

1. Keep complete raw output in memory initially.
2. Maintain line and byte counts.
3. Once output exceeds 50 KB or 2000 lines:
   - create a temp file,
   - flush prior chunks,
   - append subsequent chunks there,
   - retain only a bounded tail in memory.
4. Never explicitly delete spill files.

The store must support snapshot-safe concurrent reads while output is still arriving.

### Read semantics

`process_read` accepts:

```ts
{
  id: string,
  start?: number,
  length?: number
}
```

- Without `start`, read from the implicit cursor through a fixed snapshot end.
- Return the tail, capped by `min(length ?? 50KB, 50KB)` and 2000 lines.
- Advance the cursor to the snapshot end, even when earlier bytes were omitted.
- Report requested, returned, and omitted byte ranges.
- With `start`, perform an explicit forward range read.
- Explicit reads do not modify the implicit cursor.
- Return process status and total output size with every read.

Foreground-detachment results, notifications, completion results, and `process_kill` results use the same unread-output operation and advance the cursor.

## 5. Override `bash`

Register a tool named `bash` with:

```ts
{
  command: string,
  mode?: "wait" | "background" | "monitor",
  timeout?: number
}
```

Default `mode` to `wait`.

### `wait`

- Stream partial combined output through `onUpdate`.
- Race process completion against:
  - tool abort,
  - timeout,
  - a detach promise controlled by the steering handler.
- Preserve Pi’s error behavior for nonzero exits, timeouts, and aborts.
- If detached, allocate a public ID, switch to `background`, return the process descriptor and unread output, and remove the original tool-abort listener.

### `background` and `monitor`

- Allocate an ID immediately after successful spawn.
- Always return a started descriptor.
- Even a process that exits immediately produces a separate completion notification.
- `background` wakes only on completion.
- `monitor` wakes on stdout-triggered batches and completion.
- Optional timeout remains active after the tool returns and force-kills the process group on expiry.

In print and JSON modes, reject these two modes and allow only `wait`.

## 6. Steering-triggered detachment

Listen to Pi’s `input` event.

When:

- `streamingBehavior === "steer"`, and
- `source` is interactive or RPC,

resolve the detach promises of **all currently waiting foreground commands**.

Do not detach for:

- extension-injected messages,
- follow-up input,
- process notifications,
- Escape/tool abort.

The input event then continues normally, allowing Pi to queue the user’s steering message.

## 7. Global notification scheduler

Build one scheduler shared by every process.

### Batching

- The first eligible event starts a non-resetting 200 ms timer.
- Additional stdout or completion events join that window.
- If Pi is idle when it expires, flush immediately.
- If Pi is busy, retain everything until `turn_end`, then flush once.
- Completion events and monitor output share this batcher.
- Multiple processes appear in one message.

Only monitor stdout starts an output event. At flush time, read all combined output since each process’s cursor, meaning accumulated stderr is included as well.

### Message delivery

Use a visible custom message:

```ts
pi.sendMessage(message, {
  triggerTurn: true,
  deliverAs: "steer"
});
```

The message should contain compact textual status and output because that is what enters model context. Structured details support custom rendering and persistence.

For combined notifications:

- always preserve status metadata for every process;
- divide the 50 KB/2000-line output budget fairly among processes;
- use each process’s tail;
- report omitted ranges.

## 8. Auxiliary tools

### `process_write`

```ts
{
  id: string,
  data?: string,
  close?: boolean
}
```

- Write `data` exactly; no newline helper.
- Tool description explicitly says callers must include `\n`.
- Respect stream backpressure.
- `close: true` ends stdin after writing.
- Return clear errors for closed stdin, exited processes, or historical IDs.

### `process_kill`

```ts
{
  id: string,
  signal?: string // default SIGTERM
}
```

- Validate against the current platform’s `os.constants.signals`.
- Signal the entire process group.
- For normally terminating signals, wait up to two seconds.
- Never escalate automatically.
- Return whether the process exited, final status, and unread output.
- Suppress a redundant completion notification if it exits during this call.
- If it survives, preserve its original notification behavior and suggest `SIGKILL`.

### `process_list`

```ts
{
  include_completed?: boolean
}
```

Default to active processes. Optionally include completed records and historical tombstones with command, mode, timing, exit status, output size, and spill path.

## 9. TUI integration

On `session_start`, install a widget above the editor.

Show only detached running processes:

```text
● p2  monitor     12s  npm test -- --watch
● p3  background   4s  bun run dev
```

- Hide when empty.
- Replace embedded newlines in commands.
- Truncate lines to terminal width.
- Refresh on lifecycle changes and once per second.
- Clear the refresh timer during shutdown.

Register a custom message renderer for process notifications:

- collapsed: process IDs and event summaries;
- expanded: output, ranges, exit details, and spill paths.

Give the overridden `bash` and auxiliary tools compact custom renderers while retaining familiar Pi styling and truncation information.

## 10. Session lifecycle and tombstones

On `session_shutdown`:

1. Stop notification and UI timers.
2. Suppress new process notifications.
3. Persist a runtime-ending custom entry with IDs and shutdown reason.
4. Send `SIGTERM` to all active process groups in parallel.
5. Wait 500 ms.
6. Send `SIGKILL` to survivors.
7. Close output resources without deleting spill files.

On `session_start`:

- scan historical tool results and custom entries;
- determine the next `pN` ID;
- reconstruct tombstones for previous runtimes;
- provide errors such as:

> Process `p3` belonged to a previous runtime and was terminated during reload.

Tree navigation does not stop or reconstruct active processes.

## 11. Tests

### Unit tests

- In-memory accumulation and spill transition.
- Combined stdout/stderr ordering.
- Tail and line truncation.
- Implicit and explicit byte-range reads.
- Cursor advancement and omitted ranges.
- Fair multi-process notification allocation.
- Fixed 200 ms batching with fake timers.
- Signal classification and ID reconstruction.

### Integration tests

- Normal successful and failing `wait`.
- Steering converts multiple waits to background.
- Monitor ignores stderr-only activity until stdout or completion.
- Combined stderr appears when stdout triggers.
- Parallel monitors produce one notification.
- Fast background command still gets separate completion.
- Writable stdin and explicit EOF.
- Graceful signal survival followed by explicit `SIGKILL`.
- Timeout after tool return.
- Reload produces tombstones and kills processes.
- Completed output remains readable until shutdown.
- Print/JSON reject detached modes; RPC accepts them.

### Manual TUI tests

- Widget appearance and elapsed-time updates.
- Custom notification rendering.
- Output expansion.
- Steering while a foreground command is running.
- `/tree`, `/reload`, `/new`, and Pi exit behavior.

## 12. Recommended implementation order

1. Output store and process manager.
2. `wait`-compatible `bash` override.
3. Background execution and process IDs.
4. Steering detachment.
5. Read/write/kill/list tools.
6. Notification scheduler.
7. Session persistence and shutdown.
8. TUI widget and custom renderers.
9. Integration tests and documentation.
