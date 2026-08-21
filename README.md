# pi-proc

A distributable [Pi](https://pi.dev) extension for managed background processes on macOS and Linux.

`pi-proc` overrides `bash` without changing its default behavior. Normal calls still use `mode: "wait"`, stream combined stdout/stderr, and preserve Pi-style tail truncation and spill files. Detached modes return stable IDs (`p1`, `p2`, …) for later reads, writes, signals, and listing.

## Install and load

This package requires macOS or Linux, Node.js 22.19 or newer, and Pi. From a checkout, install the locked dependencies and try it for one run:

```sh
npm ci
pi -e .
```

To register the checkout as a normal user-level Pi package (the path remains the package source):

```sh
pi install .
pi list
```

Use `pi install -l .` instead for project-local Pi settings. Run `pi remove .` (or `pi remove -l .`) to remove that local-path registration. The extension entry point is declared in `package.json`. If `pi-proc` is published to npm, its equivalent commands are `pi -e npm:pi-proc`, `pi install npm:pi-proc`, and `pi remove npm:pi-proc`.

## Usage

### Wait (default)

```json
{"command":"npm test"}
```

A steering message entered while one or more wait commands are running promotes every active wait to managed background mode, letting the agent process the message instantly.

### Background

```json
{"command":"npm run dev","mode":"background"}
```

Returns immediately with a process descriptor such as `p1`. Background processes wake Pi when they complete.

### Monitor

```json
{"command":"npm test -- --watch","mode":"monitor","timeout":3600}
```

Monitor mode also batches stdout activity into process notifications. Any unread stderr is included when stdout or completion triggers a batch.

Detached modes are available in TUI and RPC sessions. In Print and JSON sessions, only wait mode is allowed.

### Manage a detached process

```jsonc
// Consume unread combined stdout/stderr and advance the shared cursor
{"id":"p1"}                         // process_read

// Recover a reported omitted range or already-delivered bytes without consuming
{"id":"p1","start":0,"length":4096} // process_read

// Write exact stdin data; no newline is added
{"id":"p1","data":"yes\n"}          // process_write

// Write and then send EOF
{"id":"p1","data":"payload","close":true} // process_write

// Graceful process-group termination (SIGTERM by default)
{"id":"p1"}                         // process_kill

// Explicit force termination; there is no automatic escalation
{"id":"p1","signal":"SIGKILL"}      // process_kill

// Active processes only
{}                                    // process_list

// Include completed records and prior-runtime tombstones
{"include_completed":true}            // process_list
```

`process_read` uses one delivered cursor per process—not separate tool, notification, detachment, or kill cursors. A cursorless read (no `start`) consumes unread combined output and advances the same cursor also consumed by monitor/completion notifications, foreground-detachment results, and `process_kill` output. Supplying `start` switches to a non-consuming replay/range read. Use reported omitted byte ranges with `start` to recover skipped or already-delivered output. An explicit read does not mark fetched bytes as delivered, so bytes at or beyond the shared cursor remain unread and may appear again in a later automatic notification or cursorless `process_read`.

Shell-level detachment (`&`, `nohup`, and daemonization) is unsupported because inherited pipes and lifecycle ownership become ambiguous. Use `mode: "background"` or `mode: "monitor"` instead.

## TUI

While detached processes are running, a compact namespaced widget appears above the editor:

```text
● p2  monitor      12s  npm test -- --watch
● p3  background    4s  bun run dev
────────────────────────────────────────────
> Type your message…
```

The widget:

- is installed only in TUI mode;
- stays hidden when no detached process is active;
- excludes ordinary waits, completed records, and historical tombstones;
- normalizes multi-line commands and ANSI-safely truncates every row to terminal width;
- refreshes elapsed seconds once per second only while visible;
- is removed, along with its timer and listeners, on shutdown, replacement, or reload;
- uses the `pi-proc:running-processes` key so other extensions' widgets are preserved.

Process notifications and tool rows are compact when collapsed. Use Pi's normal tool/message expansion action to show output, byte ranges, exit status, omitted ranges, spill paths, and full process-list details.

Collapsed notification:

```text
✓ p2 stdout+completed · exit 0  │  ● p3 stdout · running
```

Expanded notification:

```text
✓ p2 monitor · completed; exit code 0
events stdout+completed · 12s · PID 43120
command npm test -- --watch
exit 0
output 1842 bytes/38 lines; requested [0, 1842); returned [0, 1842); omitted none
output
… combined stdout/stderr …
```

## Behavior and limits

- Only macOS and Linux are supported. Process I/O uses pipes, not a PTY, so terminal-dependent or full-screen interactive programs are unsupported.
- One global fixed 200 ms window batches events from all processes.
- Every detached process reports completion; monitor processes additionally report stdout activity.
- Busy-agent batches are retained and delivered once after the turn settles.
- Notification output is fairly bounded to 50 KB/2000 lines in aggregate.
- Combined output spills after 50 KB or 2000 lines; spill files are retained.
- Optional timeouts continue after detached tool calls return and terminate the process group with `SIGKILL`.
- Session shutdown suppresses notifications, persists runtime metadata, sends `SIGTERM` to active groups, waits 500 ms, then sends `SIGKILL` to survivors.
- Reloaded and resumed sessions reconstruct monotonic IDs and historical tombstones. `/tree` navigation leaves the live runtime untouched.

## Development

```sh
npm test                 # automated tests
npm run check            # lint, typecheck, and all tests
npm pack --dry-run       # inspect the publishable package
npm audit                # dependency vulnerability audit
```

Automated coverage includes end-to-end process contracts, component width/invalidation checks, widget timer and disposal lifecycle, renderer collapse/expansion behavior, extension discovery, and real Pi TUI/RPC/print registration probes. Manual tmux testing is intentionally reserved for the dedicated manual-testing step.
