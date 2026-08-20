# pibg

A distributable multi-file [Pi](https://pi.dev) extension package for managing background processes.

The current implementation provides the combined output store used by the planned process manager. It keeps small transcripts in memory, spills large transcripts to a temporary file, and supports cursor-based tail reads and explicit byte-range reads with truncation metadata.

## Development

```sh
npm install
npm run check
```

Load the package directly while developing:

```sh
pi -e .
```
