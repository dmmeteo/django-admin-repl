# 0002. Server-owned session with offset replay

Status: accepted, 2026-10-30.

## Context

Django admin navigation is full-page. The JavaScript terminal is recreated on every page, so continuity has to
come from the server.

## Decision

`SessionManager` keeps one `ReplSession` per superuser in the ASGI server process. Each session has an I/O
thread that owns the PTY and appends output to a bounded `OutputLog` addressed by absolute byte offsets. The
WebSocket attach message carries the client's session id and cursor. Binary frames start with the 8-byte
offset of their first byte. The client drops bytes below its cursor and the server reports bytes that were
trimmed with a `gap` message, which the drawer shows. History is written to the terminal with replies to
terminal queries suppressed, so replaying old escape sequences cannot type into the live REPL.

Idle time is measured from the last owner input only. A reaper thread ends sessions past the limit.
Ending a session signals the process group and every process whose environment carries the session marker,
so descendants that called `setsid` are also ended.

## Alternatives

- Keep the terminal alive across navigation with an SPA shell or a persistent iframe: rejected by scope.
  Stock admin navigation stays untouched.
- A broker daemon shared by several web workers: more moving parts than a single-process demo needs. The
  file lock makes the single-process requirement explicit instead.
- Persisting sessions across restarts: Python objects cannot be persisted honestly. The UI reports the loss.

## Consequences

Reload and navigation reproduce the recent screen from retained bytes. Output older than `REPLAY_BYTES` is
gone and the drawer says so. Several ASGI workers are refused, not silently inconsistent.
