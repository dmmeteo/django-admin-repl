# 0001. Terminal-first PTY REPL

Status: accepted, 2026-10-30.

## Context

The user asked for a REPL that looks like a terminal for now, rendered with Ghostty, with a choice between
`shell`, `shell_plus`, IPython and plain Python. Earlier research had suggested Jupyter kernels.

## Decision

Spawn `python -m django_admin_repl.pty_child <argv>` on a pseudo-terminal per session. The child makes the PTY
its controlling terminal and hands off to `django-admin shell --interface ...` or `shell_plus`. Argv comes
from `available_backends()`; the browser can only name one of those entries.

## Alternatives

- Jupyter kernel with a custom frontend: structured output and richer clients later, but it replaces the
  terminal the user asked for, adds a kernel manager and a protocol, and loses IPython's own line editing.
- `pty.fork()` inside the ASGI server: forks a multi-threaded process and runs Python before `exec`.
  `subprocess.Popen(start_new_session=True)` plus `TIOCSCTTY` in a fresh interpreter avoids that.
- A host shell or arbitrary command: rejected. The REPL is already arbitrary Python; offering argv would
  widen nothing useful and make the attack surface harder to describe.

## Consequences

Line editing, completion, colors and Ctrl-C behave exactly like a local terminal because they are the real
programs. A future chat integration can drive the same PTY. Structured results (tables, objects) would need
a separate channel; that is the main reason to revisit Jupyter later.
