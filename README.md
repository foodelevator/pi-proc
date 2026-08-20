# pibg

A distributable multi-file [Pi](https://pi.dev) extension package for managing background processes.

The current implementation provides the POSIX process-management core and combined output store. It can run private foreground commands or tracked background/monitor commands in detached process groups, stream combined output, steer stdin and signals, enforce timeouts, and shut down children gracefully before forcing survivors. Small transcripts stay in memory; large transcripts spill to temporary files while remaining byte-range readable.

Only macOS and Linux are supported. Shell-level detachment (`&`, `nohup`, and daemonization) is unsupported because inherited pipe and lifecycle ownership become ambiguous; use the process mode exposed by the extension instead.

Pi tool/event registration, notifications, persistence, and TUI integration are intentionally implemented in later stages.

## Development

```sh
npm install
npm run check
```

Load the package directly while developing:

```sh
pi -e .
```
