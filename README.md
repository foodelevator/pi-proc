# pibg

A distributable multi-file [Pi](https://pi.dev) extension package for managing background processes.

The current implementation provides the POSIX process-management core, combined output store, and a Pi-compatible managed-process `bash` override. Wait mode remains the default: it streams combined stdout/stderr through throttled updates, preserves Pi's tail truncation and spill metadata, and reports timeout, cancellation, and failures as errored tool calls.

`mode: "background"` and `mode: "monitor"` start a retained managed process and immediately return a stable `pN` process descriptor. Both modes retain output and completion state and continue enforcing optional timeouts after the tool returns. Use `process_read` for cursor-based combined stdout/stderr reads, `process_write` for exact stdin data and EOF, `process_kill` for process-group signals, and `process_list` for active or retained completed records. Monitor mode emits internal stdout-activity events while background mode remains quiet until completion; automatic user-facing notifications are not implemented yet. Detached modes are available only in TUI and RPC sessions, while print and JSON sessions remain wait-only.

Interactive and RPC steering input promotes every active wait-mode command to a managed background process without cancelling it. The detached tool result identifies the steering reason, includes combined output produced so far with byte-range metadata, and advances that process's delivery cursor. Follow-up and extension-injected input do not detach waits. User-facing notification batching, persistence restoration/tombstones, and TUI widgets are implemented in later stages.

Only macOS and Linux are supported. Shell-level detachment (`&`, `nohup`, and daemonization) is unsupported because inherited pipe and lifecycle ownership become ambiguous; use the process mode exposed by the extension instead.

## Development

```sh
npm install
npm run check
```

Load the package directly while developing:

```sh
pi -e .
```
