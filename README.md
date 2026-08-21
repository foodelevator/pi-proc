# pibg

A distributable multi-file [Pi](https://pi.dev) extension package for managing background processes.

The current implementation provides the POSIX process-management core, combined output store, and a Pi-compatible managed-process `bash` override. Wait mode remains the default: it streams combined stdout/stderr through throttled updates, preserves Pi's tail truncation and spill metadata, and reports timeout, cancellation, and failures as errored tool calls.

`mode: "background"` and `mode: "monitor"` start a retained managed process and immediately return a stable `pN` process descriptor. Both modes retain output and completion state and continue enforcing optional timeouts after the tool returns. Use `process_read` for cursor-based combined stdout/stderr reads, `process_write` for exact stdin data and EOF, `process_kill` for process-group signals, and `process_list` for active or retained completed records. Detached modes are available only in TUI and RPC sessions, while print and JSON sessions remain wait-only.

A global fixed 200 ms scheduler automatically sends visible process-event messages. Every detached process notifies on completion, while monitor processes additionally notify on stdout activity. Events from all processes coalesce globally; monitor notifications include all combined unread stdout/stderr, and busy-agent batches steer exactly once after `turn_end`. Notification output is fairly bounded to 50 KB/2000 lines in aggregate with byte ranges and spill paths retained in structured details.

Interactive and RPC steering input promotes every active wait-mode command to a managed background process without cancelling it. The detached tool result identifies the steering reason, includes combined output produced so far with byte-range metadata, and advances that process's delivery cursor. Follow-up and extension-injected input do not detach waits.

Session shutdown suppresses notifications, persists a non-LLM runtime-ending entry, sends TERM to every active group, waits 500 ms, then KILLs survivors while retaining spill files. Reloaded and resumed sessions reconstruct historical tombstones and monotonic IDs from durable process entries; `process_list` includes them only with `include_completed`, while direct operations return a prior-runtime error. Tree navigation leaves the live runtime untouched. The running-process widget remains later-stage work.

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
