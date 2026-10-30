import importlib.util
import re
import time

import pytest
from django.apps import apps

from django_admin_repl.conf import Facts, get_config
from django_admin_repl.sessions import OutputLog, ReplUnavailable, SessionManager, State, manager
from support import alive, screen, wait_for, wait_output


def test_output_log_trims_at_a_line_boundary_and_exposes_the_gap():
    log = OutputLog(limit=10)
    log.append(b"aaaa\nbbbb\ncccc\n")
    assert (log.start, log.end) == (10, 15)
    assert log.read(0) == (10, b"cccc\n")
    assert log.read(12) == (12, b"cc\n")
    assert log.read(15) == (15, b"")


def test_python_backend_runs_real_code_with_the_requested_terminal_size(repl):
    session = repl("python")
    wait_output(session, ">>> ")
    session.resize(91, 27)
    session.write(b"import os; print(sum(range(10)) * 7, os.get_terminal_size(0))\r")
    wait_output(session, "315 os.terminal_size(columns=91, lines=27)")


def test_ctrl_c_interrupts_running_code_without_killing_the_repl(repl):
    session = repl("python")
    wait_output(session, ">>> ")
    session.write(b"import time; time.sleep(60)\r")
    time.sleep(0.5)
    session.write(b"\x03")
    wait_output(session, "KeyboardInterrupt", timeout=5)
    session.write(b"print(6 * 7 * 11)\r")
    wait_output(session, "462")
    assert session.state is State.RUNNING


def test_offered_backends_follow_what_is_installed():
    offered = get_config().offered(Facts.observe())
    assert ("ipython" in offered) is (importlib.util.find_spec("IPython") is not None)
    assert ("shell_plus" in offered) is apps.is_installed("django_extensions")
    assert offered["python"].argv == ("shell", "--interface", "python")


@pytest.mark.parametrize("backend, prompt", [("ipython", "In ["), ("shell_plus", "In [")])
def test_optional_backends_start_real_interpreters_with_models_loaded(repl, backend, prompt):
    if backend not in get_config().offered(Facts.observe()):
        pytest.skip(f"{backend} is not installed in this environment")
    session = repl(backend)
    wait_output(session, prompt)
    session.write(b"print(Note.__name__ * 3)\r")
    wait_output(session, "NoteNoteNote")


def test_end_kills_the_process_tree_and_permits_a_fresh_session(repl):
    session = repl("python")
    wait_output(session, ">>> ")
    session.write(
        b"import subprocess; a = subprocess.Popen(['sleep', '300']); "
        b"b = subprocess.Popen(['sleep', '301'], start_new_session=True); print('pids', a.pid, b.pid, sep=':')\r"
    )
    child, escaped = map(int, re.search(r"pids:(\d+):(\d+)", wait_output(session, "pids:")).groups())
    assert alive(session.pid) and alive(child) and alive(escaped)

    manager.end(session.owner_id)

    assert session.state is State.ENDED
    assert session.reason == "Ended by the user."
    assert not session.write(b"print('late')\r")
    assert wait_for(lambda: not any(alive(pid) for pid in (session.pid, child, escaped)), timeout=5)
    fresh, created = manager.start(session.owner_id, session.backend, get_config())
    assert created and fresh.id != session.id and fresh.pid != session.pid


def test_process_exit_is_reported_with_its_code(repl):
    session = repl("python")
    wait_output(session, ">>> ")
    session.write(b"raise SystemExit(3)\r")
    wait_for(lambda: session.state is State.EXITED, timeout=10)
    assert session.exit_code == 3
    assert session.reason == "The REPL process exited with code 3."


def test_idle_expiry_counts_input_but_not_attached_viewers(repl):
    session = repl("python", idle_timeout=3)
    deadline = time.monotonic() + 30
    while ">>> " not in screen(session):
        assert time.monotonic() < deadline
        session.write(b"\r")
        time.sleep(0.5)
        assert session.state is State.RUNNING
    for _ in range(5):
        time.sleep(1)
        assert session.state is State.RUNNING
        session.write(b"\r")

    session.subscribe(lambda: None)
    deadline = time.monotonic() + 8
    while session.state is State.RUNNING and time.monotonic() < deadline:
        session.read(0)
        time.sleep(0.1)

    assert session.state is State.EXPIRED
    assert session.reason == "No input for 3 s; the idle limit ended the process."
    assert wait_for(lambda: not alive(session.pid), timeout=5)


def test_a_second_server_process_cannot_host_sessions(repl):
    repl("python")
    config = get_config()
    with pytest.raises(ReplUnavailable, match="single ASGI server process"):
        SessionManager().start(1, config.offered(Facts.observe())["python"], config)
