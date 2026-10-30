# 0003. Containment for demo and test deployments

Status: accepted, 2026-10-30.

## Context

A superuser REPL executes arbitrary Python. A Python-level sandbox would be escapable, so containment has to
be at the OS and network level.

## Decision

- Every container that runs the demo for tests (`scripts/verify.sh`) runs as uid 10001 with a read-only root,
  `--cap-drop ALL`, `no-new-privileges`, a 64 MiB `/tmp` tmpfs, its own throwaway data volume, 480 MiB,
  0.45 CPU and 104 tasks.
- It is attached only to an internal Docker network with no route to the host network or the internet, and
  publishes no port. The browser container joins the same internal network.
- No Docker socket, home, project or credential mounts. Test logins are generated per run, passed through
  `docker exec` stdin and kept in a mode 0600 file that is deleted with the run.
- The local quickstart (`scripts/demo.sh`) binds to 127.0.0.1 and keeps its generated login in a mode 0600 file
  in its data directory.

## Consequences

Code typed into a test REPL can damage only its container and a synthetic SQLite volume. A deployment that
exposes the REPL beyond loopback needs the same kind of containment, chosen by its operator; the README's
Security section lists what to decide. Restarting the server loses REPL state by design.
