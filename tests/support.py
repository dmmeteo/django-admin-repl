import time
from pathlib import Path


def wait_for(predicate, timeout=15.0, message="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"Timed out after {timeout}s waiting for {message}")


def screen(session):
    return session.read(0)[1].decode("utf-8", "replace")


def wait_output(session, needle, timeout=20.0):
    def found():
        text = screen(session)
        return text if needle in text else None

    return wait_for(found, timeout, f"{needle!r} in REPL output:\n{screen(session)[-800:]}")


def alive(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return False
    return fields[0] != "Z"
