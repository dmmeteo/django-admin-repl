# django-admin-repl nano-spec

This is the durable project memory: purpose, accepted scope, invariants and the outcome checklist. "User" rows
come from the original product request and its review feedback; "Packet" rows are engineering requirements
added while building it.

## Purpose

Give an active Django superuser a real interactive Python shell inside the stock Django admin.
The shell lives in a drawer that slides in from the side (right by default) on any admin page. It keeps running on the
server while the user moves between admin pages or reloads, and it ends only when the user ends it or
stops typing for a configurable time.

## Feature inventory

| ID | Source | Status | Item |
| --- | --- | --- | --- |
| F1 | User | Accepted, built | Global admin-wide drawer added by extending the admin base template, "natively" sliding in from the side. |
| F2 | User | Accepted, built | It is a REPL shown as a terminal for now. |
| F3 | User | Accepted, built | Moving between admin pages keeps the same session ("does not lose the session"). |
| F4 | User | Accepted, built | Terminal rendering through Ghostty (the user named libghostty). Built with `ghostty-web` 0.4.0, Ghostty's VT parser compiled to WASM. |
| F5 | User | Accepted, built | Configurable REPL: Django `shell`, `shell_plus` when django-extensions is connected, IPython when present, plain Python otherwise. |
| F6 | User | Accepted, built | A minimal demo Django app with tiny synthetic data, runnable locally (`scripts/demo.sh`) and in throwaway test containers. |
| F7 | User | Accepted, built | The session survives a page reload, dies when explicitly closed or after N idle hours, and N is a setting. |
| F8 | User | Accepted constraint | Fit the Django admin look; do not invent many new styles. |
| F9 | User | Deferred | A chat that has access to the REPL, possibly TUI-like. Explicitly a later phase; no AI integration exists here. |
| F10 | User | Deferred proposal | Switching interpreter "inside" a running drawer. Built as a choice at session start (server-validated list); switching a live process is not built. |
| U1 | User review | Accepted, built | Side panels need directly adjustable width: the drawer's inner edge drags and responds to arrow keys, the width is remembered, and Ghostty and the PTY follow live. |
| P1 | Packet | Accepted, built | One session per active superuser, re-checked on every control request and stream entry. |
| P2 | Packet | Accepted, built | Bounded output replay with explicit byte offsets: no duplicates, gaps shown instead of hidden. |
| U2 | User review | Accepted, built | A sidebar icon on the toggle and a configurable side: right by default, left with `ADMIN_REPL["SIDE"] = "left"`. |
| P3 | Packet | Accepted, built | Test containers are non-root, capped, on an internal network with no route out; the local demo binds to loopback. |
| P4 | Packet | Accepted, built | Public preview: README, MIT license, security policy, Ruff and ty gates, a Python 3.12 to 3.14 by Django 5.2 to 6.1 test matrix, built-distribution installs. |
| R1 | Prior research | Rejected for now | Jupyter kernels. A PTY running the management shell is simpler and matches "a terminal". See [ADR 0001](adr/0001-terminal-first-pty-repl.md). |

## Invariants

- The browser sends a backend name from the server's allowlist. Argv comes from a server-side registry.
  No executable path, argv or shell string from the request is used, and nothing runs with `shell=True`.
- Rendering an admin page or opening the drawer never starts a process. Start is an explicit POST with CSRF.
- Only an authenticated, active superuser may read state, start, end or stream, and only for their own session.
  A live stream re-reads the Django session every 10 s and closes if the user logged out or lost rights.
- Idle time counts only owner input. Viewing, reconnecting or WebSocket keepalives never extend it.
- Output frames carry absolute byte offsets. A client never renders the same byte twice, and a replay that
  starts after the oldest retained byte says so in the drawer.
- Sessions live in one server process. A second process that tries to host sessions is refused through an
  exclusive file lock instead of silently splitting state.
- A server or container restart loses the Python state. The drawer reports that the previous session is gone.

## Configuration

```python
ADMIN_REPL = {
    "BACKEND": "auto",  # "auto", "python", "ipython" or "shell_plus"
    "ALLOWED_BACKENDS": None,  # None offers every available backend, or a list of names
    "IDLE_TIMEOUT": 4 * 60 * 60,  # seconds without owner input before the process is ended
    "REPLAY_BYTES": 512 * 1024,  # retained output per session for reload and reconnect
    "STREAM_PATH": "/admin/repl/stream/",
    "LOCK_PATH": None,  # defaults to <tempdir>/django-admin-repl.lock
    "SIDE": "right",  # or "left"
}
```

`auto` prefers IPython, then plain Python. `shell_plus` is offered only when `django_extensions` is in
`INSTALLED_APPS`. An explicitly configured backend that is unavailable fails the system check
(`admin_repl.E002`) instead of being replaced.

## Changing typical behavior

- A new interpreter is one entry in `available_backends()` in `src/django_admin_repl/conf.py`, plus a
  `KNOWN_BACKENDS` name. Add a real-process test next to `test_optional_backends_start_real_interpreters...`.
- Lifecycle rules (idle, end, exit) live in `ReplSession` in `sessions.py`. The stream protocol lives in
  `consumers.py` and `static/admin_repl/drawer.js` together; change both and the browser acceptance.
- Verify with `bash scripts/verify.sh`. It runs Ruff and ty, the pytest matrix, the distribution and quickstart
  smoke tests, and the Playwright journeys against throwaway containers.

## Outcome checklist

"Gate" is `scripts/verify.sh`; each run's artifacts directory holds the logs and screenshots.

| Outcome | Implemented | Tested |
| --- | --- | --- |
| Drawer on stock admin pages, keyboard and focus handling, narrow and full width | yes | browser |
| Drawer on the right (default) or left, toggle icon (U2) | yes | pytest + browser |
| Drawer width by drag and keyboard, bounds, remembered width, live Ghostty and PTY resize (U1) | yes | browser |
| Earlier rows intact after the terminal widens | yes (redraw from the output log) | browser `widen-rows` |
| Real Django shell through a PTY: input, output, paste, Ctrl-C, resize | yes | pytest + browser |
| Plain Python as the first session of a fresh server | yes | browser `cold-python`, idle phase |
| Same process across navigation and reload, exactly-once replay | yes | browser |
| Hide drawer keeps process; End terminates the tree; fresh start | yes | pytest + browser |
| Idle expiry from input only, configurable | yes | pytest + browser |
| Python, IPython, shell_plus selection and unavailable-backend validation | yes | pytest (every matrix cell) + browser |
| Anonymous, staff, inactive and other superusers refused | yes | pytest + browser |
| Honest disconnected, expired, ended and restarted states | yes | browser |
| Wheel and sdist ship the assets and licenses and install with pip, with and without extras | yes | gate `dist` stage |
| README quickstart works from a clean copy and keeps data and login across a restart | yes | gate `demo` stage |
| Chat with REPL access (F9) | no | no |
