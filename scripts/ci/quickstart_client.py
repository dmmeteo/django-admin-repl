"""HTTP client for the quickstart smoke. Reads the generated login file and never prints the password.

Usage: python quickstart_client.py <login.json> first|restarted
"""

import http.cookiejar
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8000"
MARKER = "Renamed before the restart"
login = json.loads(Path(sys.argv[1]).read_text())
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def form_token(path):
    page = opener.open(BASE + path).read().decode()
    return re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', page).group(1)


def post_form(path, fields):
    data = urllib.parse.urlencode({**fields, "csrfmiddlewaretoken": form_token(path)}).encode()
    return opener.open(urllib.request.Request(BASE + path, data, headers={"Referer": BASE + path}))


def api(method, path, body=None):
    token = next(cookie.value for cookie in jar if cookie.name == "csrftoken")
    request = urllib.request.Request(
        BASE + path,
        json.dumps(body or {}).encode() if method == "POST" else None,
        {"Content-Type": "application/json", "X-CSRFToken": token, "Referer": BASE + "/admin/"},
        method=method,
    )
    with opener.open(request) as response:
        return response.status, json.loads(response.read())


response = post_form("/admin/login/?next=/admin/", {"username": login["username"], "password": login["password"]})
assert response.url == BASE + "/admin/", f"login did not reach the admin index: {response.url}"
index = response.read().decode()
assert 'id="admin-repl-drawer"' in index and "data-admin-repl-toggle" in index, "REPL drawer missing"

if sys.argv[2] == "first":
    status, started = api("POST", "/admin/repl/start/", {"backend": "python"})
    assert status == 201 and started["session"]["state"] == "running", started
    status, state = api("GET", "/admin/repl/state/")
    assert state["session"]["id"] == started["session"]["id"] and state["session"]["state"] == "running", state
    status, ended = api("POST", "/admin/repl/end/")
    assert ended["session"]["state"] == "ended", ended
    post_form("/admin/notes/note/1/change/", {"title": MARKER, "status": "draft", "_save": "Save"})
    print(f"first run: logged in as {login['username']!r}, started and ended a Python REPL, renamed note 1")
else:
    notes = opener.open(BASE + "/admin/notes/note/").read().decode()
    assert MARKER in notes, "the note renamed before the restart is gone"
    status, state = api("GET", "/admin/repl/state/")
    assert state["session"] is None, "a REPL session survived a server restart"
    print("restarted: the same generated login works and the renamed note is still there")
