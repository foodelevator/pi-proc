# pibg

A distributable multi-file [Pi](https://pi.dev) extension package for managing background processes.

The current implementation provides the POSIX process-management core, combined output store, and a Pi-compatible `bash` override for ordinary foreground waits. Wait mode is the default, streams combined stdout/stderr through throttled updates, preserves Pi's tail truncation and spill metadata, handles timeout/cancellation/failure as errored tool calls, and does not expose process IDs or history.

The registered schema already includes `mode: "wait" | "background" | "monitor"`, but background and monitor calls currently fail with a clear not-implemented error. Their public lifecycle, along with steering, auxiliary tools, notifications, persistence, and TUI integration, is implemented in later stages.

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
