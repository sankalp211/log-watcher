# log-watcher

A production-grade real-time log streaming system built as a machine-coding exercise.

Stream any append-only log file to a browser in real time — like `tail -f`, but over HTTP using Server-Sent Events.

---

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open **http://localhost:3000/log** in a browser, then in another terminal:

```bash
# Append a single line
echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") INFO  New event" >> logs/sample.log

# Or simulate a live feed (1 line/second)
./logs/generate.sh

# Or fast-feed for demo purposes
./logs/generate.sh --fast
```

---

## Requirements

| | |
|---|---|
| Runtime | Node.js >= 18.2.0 |
| Package manager | npm >= 9 |

---

## Configuration

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `LOG_FILE_PATH` | `./logs/sample.log` | Absolute or relative path to the file to watch |
| `TAIL_LINES` | `10` | Lines to show on first browser connect |
| `READ_CHUNK_SIZE` | `4096` | Bytes per chunk for the reverse-scan tail algorithm |
| `POLL_INTERVAL_MS` | `1000` | Polling fallback interval; `0` disables it |

---

## Scripts

```bash
npm run dev            # Start with ts-node-dev (hot-reload on source change)
npm run build          # Compile TypeScript → dist/
npm start              # Run compiled output (requires build first)
npm test               # Run all 93 tests
npm run test:unit      # Unit tests only
npm run test:integration  # Integration tests only
npm run test:coverage  # Coverage report in ./coverage/
npm run lint           # ESLint check
npm run lint:fix       # Auto-fix lint issues
```

---

## Architecture

```
Browser (EventSource)
       │
       │  GET /log   → HTML page (one-time)
       │  GET /stream → SSE stream (persistent)
       │
       ▼
┌──────────────────────────────────────────┐
│               Express App                │
│                                          │
│  /log route          /stream route       │
│  (serve log.html)    (SSE handshake,     │
│                       snapshot, stream)  │
└──────────────┬───────────────────────────┘
               │ add / remove / broadcast
      ┌────────▼────────┐
      │  ClientManager  │  ← Map<uuid, Response>
      └────────┬────────┘
               │ 'line' events
      ┌────────▼────────┐
      │   LogWatcher    │  ← fs.watch + byte-offset + inode tracking
      └────────┬────────┘
               │ reads
      ┌────────▼────────┐
      │   FileReader    │  ← lastNLines() + readFrom()
      └─────────────────┘
               │
         Log file on disk
```

### Data flow — step by step

1. Server starts: `statFileSync` records the current **byte offset** and **inode** of the log file.
2. `LogWatcher.start()` attaches `fs.watch` to the file. The offset is set to end-of-file so the watcher only reads new content going forward.
3. Browser loads `GET /log` → receives `log.html`.
4. JavaScript opens `new EventSource('/stream')`.
5. Server handles `GET /stream`:
   - Sets SSE headers and flushes them immediately (client is NOT stuck in loading state).
   - Registers a `req.on('close')` handler to clean up on disconnect.
   - Calls `lastNLines(filePath, 10)` — reads the last 10 lines in O(k) bytes.
   - Sends a `snapshot` SSE event with the initial lines.
   - Registers the client with `ClientManager`.
6. `fs.watch` fires a `change` event when the file grows.
7. `LogWatcher` calls `readFrom(filePath, lastOffset)` — reads only the new bytes.
8. Each complete line is emitted as a `'line'` event → `ClientManager.broadcast()` → SSE `data:` frame → all browsers.

---

## Key design decisions

### SSE vs WebSocket

Log streaming is strictly **server → client**. SSE wins on every dimension for this use case:

| | SSE | WebSocket |
|---|---|---|
| Protocol | plain HTTP/1.1 | protocol upgrade |
| Browser reconnect | built-in `EventSource` | must implement manually |
| Proxy/LB support | works by default | requires WS-aware proxy |
| `Last-Event-ID` | native | not a concept |
| Bidirectional? | no (not needed here) | yes |

### Last-N-lines algorithm

Files may be several GB. Reading from byte 0 is not acceptable.

**Reverse-chunk scan:**

1. `stat()` the file → get `fileSize`.
2. Allocate one fixed-size buffer (`READ_CHUNK_SIZE`, default 4 KB).
3. Read backwards from the end in `chunkSize`-byte windows.
4. Count `\n` characters scanning from the end of each chunk toward the front.
5. Stop when we have seen `N + 1` newlines, or we reach byte 0.
6. `Buffer.concat(accumulated_chunks).split('\n').slice(-N)`.

**Cost:** reads at most `N × avg_line_length + chunkSize` bytes.
For 10 lines averaging 150 bytes, that is ≤ 6 KB regardless of whether the file is 1 MB or 100 GB.

**Critical implementation detail:** the read buffer is reused across iterations, so each chunk must be copied with `Buffer.from(buf.subarray(0, bytesRead))` rather than stored as a view — views share underlying memory and would be corrupted by the next read.

### Incremental reading

- On startup, `initialOffset = file.size`. The watcher never re-reads existing content.
- On `change` event: `stat()` → `newSize > lastOffset`? → `read(fd, buf, 0, newSize-lastOffset, lastOffset)`.
- Content after the last `\n` is buffered as `remainder` and prepended to the next read.
- All complete lines are broadcast immediately.

### File rotation / truncation

| Condition | Detection | Action |
|---|---|---|
| Truncation | `newSize < lastOffset` | Reset `offset = 0`, clear `remainder` |
| Rotation | `inode !== initialInode` | Close watcher, reset `offset = 0`, re-attach |
| Deletion | `ENOENT` on stat | Emit error event to clients, poll for reappearance |
| Permission error | `EACCES` on read/stat | Emit error event, stop watcher |

### Multi-client support

`ClientManager` holds a `Map<uuid, Response>`. Broadcast iterates the map and writes the SSE frame to each `Response`. If a write throws (broken pipe), the client is removed. The map is never exposed — all mutations go through `add()`, `remove()`, `broadcast()`.

### Disconnect race condition (fixed)

The `req.on('close')` handler must be registered **before** the `await lastNLines(...)` call. Otherwise a client that disconnects during the file read would fire the close event before the handler is set up, leaking the client in `ClientManager` forever. The fix: register the handler immediately after setting SSE headers, with a `closed` flag checked before `clientManager.add()`.

---

## Project structure

```
log-watcher/
├── src/
│   ├── config/index.ts          # Env-var config with fail-fast validation
│   ├── utils/logger.ts          # Structured JSON logger
│   ├── services/
│   │   ├── fileReader.ts        # lastNLines() + readFrom() — pure I/O, no HTTP
│   │   ├── logWatcher.ts        # fs.watch lifecycle, rotation, truncation
│   │   └── clientManager.ts    # SSE client registry + broadcast
│   ├── server/
│   │   ├── app.ts               # Express app factory (no listen — testable)
│   │   └── routes/
│   │       ├── log.route.ts     # GET /log — serve HTML
│   │       └── stream.route.ts  # GET /stream — SSE handshake + snapshot
│   └── index.ts                 # Entry point, graceful shutdown
├── public/
│   └── log.html                 # Vanilla JS SSE client
├── tests/
│   ├── unit/
│   │   ├── fileReader.test.ts   # 29 tests: algorithm correctness, edge cases
│   │   ├── logWatcher.test.ts   # 18 tests: events, debounce, rotation, errors
│   │   └── clientManager.test.ts # 20 tests: registry, broadcast, wire format
│   └── integration/
│       ├── log.test.ts          # 14 tests: HTML structure, routing, 404s
│       └── stream.test.ts       # 22 tests: SSE headers, snapshot, live, disconnect
├── logs/
│   ├── sample.log               # Realistic seed data
│   └── generate.sh              # Script to simulate live log appends
├── .env.example
├── package.json
├── tsconfig.json
├── jest.config.ts
└── INTERVIEW.md                 # Interview talking points and Q&A
```

---

## Running tests

```bash
# All 93 tests
npm test

# With coverage
npm run test:coverage

# Unit only (fast, no I/O)
npm run test:unit

# Integration only
npm run test:integration
```

### Test coverage map

| Scenario | File |
|---|---|
| Last 10 lines from 20-line file | `unit/fileReader.test.ts` |
| Fewer than N lines | `unit/fileReader.test.ts` |
| Empty file | `unit/fileReader.test.ts` |
| Single line file | `unit/fileReader.test.ts` |
| n=1 | `unit/fileReader.test.ts` |
| n=0 | `unit/fileReader.test.ts` |
| No trailing newline | `unit/fileReader.test.ts` |
| Consecutive blank lines | `unit/fileReader.test.ts` |
| File with only a newline | `unit/fileReader.test.ts` |
| 100k-line file (large) | `unit/fileReader.test.ts` |
| Line wider than chunk size | `unit/fileReader.test.ts` |
| Unicode / multi-byte characters | `unit/fileReader.test.ts` |
| Custom chunk size (16 bytes) | `unit/fileReader.test.ts` |
| ENOENT on missing file | `unit/fileReader.test.ts` |
| Incremental read from offset | `unit/fileReader.test.ts` |
| Partial line buffered as remainder | `unit/fileReader.test.ts` |
| Remainder prepended to next read | `unit/fileReader.test.ts` |
| Blank line appended (lone newline) | `unit/fileReader.test.ts` |
| Sequential 3-append simulation | `unit/fileReader.test.ts` |
| Partial line completed in 2 writes | `unit/fileReader.test.ts` |
| New lines emitted on change | `unit/logWatcher.test.ts` |
| Burst of 5 lines emitted in order | `unit/logWatcher.test.ts` |
| Empty lines array → no emission | `unit/logWatcher.test.ts` |
| No read when size == offset | `unit/logWatcher.test.ts` |
| Debounce: 5 rapid events → 1 read | `unit/logWatcher.test.ts` |
| Partial line across 2 reads | `unit/logWatcher.test.ts` |
| Truncation resets offset to 0 | `unit/logWatcher.test.ts` |
| Truncation clears remainder | `unit/logWatcher.test.ts` |
| Rotation resets offset + re-watches | `unit/logWatcher.test.ts` |
| Rename event emits error | `unit/logWatcher.test.ts` |
| EACCES emits error + stops | `unit/logWatcher.test.ts` |
| ENOENT emits error + stays alive | `unit/logWatcher.test.ts` |
| stop() closes watcher + timer | `unit/logWatcher.test.ts` |
| stop() is idempotent | `unit/logWatcher.test.ts` |
| No emission after stop() | `unit/logWatcher.test.ts` |
| Initial size=0 | `unit/clientManager.test.ts` |
| add() returns UUID v4 | `unit/clientManager.test.ts` |
| remove() by ID | `unit/clientManager.test.ts` |
| remove() unknown ID is no-op | `unit/clientManager.test.ts` |
| 50-client broadcast | `unit/clientManager.test.ts` |
| Broken pipe auto-cleanup | `unit/clientManager.test.ts` |
| SSE wire format: data: / \\n\\n | `unit/clientManager.test.ts` |
| JSON-encodes newlines in lines | `unit/clientManager.test.ts` |
| broadcastError wire format | `unit/clientManager.test.ts` |
| broadcastError JSON payload | `unit/clientManager.test.ts` |
| GET /log → 200 text/html | `integration/log.test.ts` |
| HTML DOCTYPE declaration | `integration/log.test.ts` |
| HTML #log-container element | `integration/log.test.ts` |
| HTML #status element | `integration/log.test.ts` |
| HTML EventSource setup | `integration/log.test.ts` |
| HTML snapshot/message listeners | `integration/log.test.ts` |
| GET /health → { status: ok } | `integration/log.test.ts` |
| 404 for unknown routes | `integration/log.test.ts` |
| SSE Content-Type header | `integration/stream.test.ts` |
| SSE Cache-Control header | `integration/stream.test.ts` |
| SSE X-Accel-Buffering header | `integration/stream.test.ts` |
| SSE Connection header | `integration/stream.test.ts` |
| Snapshot last 3 lines correct | `integration/stream.test.ts` |
| Snapshot preserves order | `integration/stream.test.ts` |
| Snapshot < tailLines lines | `integration/stream.test.ts` |
| Snapshot empty file | `integration/stream.test.ts` |
| Snapshot data is valid JSON | `integration/stream.test.ts` |
| ENOENT → event: error | `integration/stream.test.ts` |
| Error data is valid JSON | `integration/stream.test.ts` |
| Live broadcast delivers new line | `integration/stream.test.ts` |
| broadcastError reaches client | `integration/stream.test.ts` |
| Multiple broadcasts in order | `integration/stream.test.ts` |
| 3 concurrent clients all snapshot | `integration/stream.test.ts` |
| 2 concurrent clients same broadcast | `integration/stream.test.ts` |
| Client disconnect cleans up | `integration/stream.test.ts` |
| Second client after first disconnects | `integration/stream.test.ts` |

---

## Limitations

| Limitation | Notes |
|---|---|
| Single process | `ClientManager` is in-memory; no horizontal scaling without a pub/sub layer |
| `fs.watch` reliability | Unreliable on NFS, Docker volumes, some Linux configs — use `POLL_INTERVAL_MS=500` as fallback |
| No authentication | Add JWT/session middleware to `/stream` before external exposure |
| DOM capped at 5000 lines | Oldest lines are dropped to avoid browser memory bloat |
| No TLS | Add a TLS-terminating reverse proxy (nginx/Caddy) in front for production |

---

## Future improvements

1. **Horizontal scaling** — extract `ClientManager` into a Redis Pub/Sub fanout; each process subscribes and forwards to local SSE clients.
2. **Multi-file watching** — accept a list of `LOG_FILE_PATH` entries; prefix SSE event types with the file name.
3. **In-memory ring buffer** — keep last N lines in memory for instant delivery to late-connecting clients without a disk read.
4. **Authentication** — JWT middleware on `/stream`; origin check on `EventSource`.
5. **Metrics endpoint** — expose lines/sec, connected client count, watcher health.
6. **Docker image** — minimal Node image, environment-based config, health-check `HEALTHCHECK` instruction.
7. **Backpressure** — detect slow clients (high-watermark on the response stream) and drop or throttle delivery.
