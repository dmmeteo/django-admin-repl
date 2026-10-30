# Agent guide

Start with [docs/spec.md](docs/spec.md) for scope, invariants and the outcome checklist, then
[DESIGN.md](DESIGN.md) for the drawer and [docs/adr/](docs/adr/README.md) for decisions.

## Boundaries

- Never accept argv, executable paths or shell strings from the browser. Backends are registry entries.
- Demo and test credentials are generated at run time and kept in files with mode 0600. Do not print them,
  commit them or put them in screenshots.
- Heavy work (image builds, browser runs) goes through `scripts/verify.sh`, which takes `.verify/heavy.lock`
  (or `$ADMIN_REPL_LOCK_FILE`) unless `ADMIN_REPL_GATE_LOCK_HELD=1` says the caller already holds a lock.

## Where things live

| Change | File |
| --- | --- |
| Interpreter choices, settings parsing | `src/django_admin_repl/conf.py` |
| Process, idle expiry, termination, output log | `src/django_admin_repl/sessions.py` |
| Who may use it | `src/django_admin_repl/access.py` |
| HTTP state/start/end | `src/django_admin_repl/views.py` |
| Stream protocol (server) | `src/django_admin_repl/consumers.py` |
| Drawer UI and stream protocol (client) | `src/django_admin_repl/static/admin_repl/drawer.js`, `drawer.css`, `boot.js` |
| Admin template hooks | `src/django_admin_repl/templatetags/admin_repl.py`, `templates/admin_repl/` |
| Test matrix cells and pins | `requirements/matrix-cells.txt`, `requirements/matrix.txt` |

## Verify

`bash scripts/verify.sh` runs Ruff, ty, the pytest matrix against real PTY processes, the distribution build and
clean installs, the README quickstart, and the Playwright journeys in `tests/browser/acceptance.mjs` against
throwaway containers. A change to the stream protocol must update both `consumers.py` and `drawer.js`, and the
browser journeys that cover reload, reconnect, resize and replay.
