import json
import struct
from pathlib import Path

import pytest
from asgiref.sync import async_to_sync
from channels.testing import WebsocketCommunicator
from django.test import Client

from demo_project.asgi import application
from django_admin_repl.sessions import State, manager
from support import wait_output

pytestmark = pytest.mark.django_db(transaction=True)
STREAM = "/admin/repl/stream/"


@pytest.fixture
def users(django_user_model):
    def make(username, **flags):
        return django_user_model.objects.create_user(username, is_staff=True, **flags)

    accounts = {
        "owner": make("owner", is_superuser=True),
        "other": make("other", is_superuser=True),
        "staff": make("staff"),
        "inactive": make("inactive", is_superuser=True, is_active=False),
    }
    yield accounts
    for user in accounts.values():
        manager.end(user.pk)


def client_for(user=None, **kwargs):
    client = Client(**kwargs)
    if user is not None:
        client.force_login(user)
    return client


def post_json(client, url, payload=None):
    return client.post(url, json.dumps(payload or {}), content_type="application/json")


def test_only_active_superusers_reach_control_endpoints(users):
    expectations = {None: 401, "staff": 403, "inactive": 401}
    for name, status in expectations.items():
        client = client_for(users.get(name))
        assert client.get("/admin/repl/state/").status_code == status
        assert post_json(client, "/admin/repl/start/").status_code == status
        assert post_json(client, "/admin/repl/end/").status_code == status
    assert all(manager.get(user.pk) is None for user in users.values())


def test_start_needs_post_with_csrf_and_page_render_starts_nothing(users):
    client = client_for(users["owner"], enforce_csrf_checks=True)
    page = client.get("/admin/notes/note/")
    assert page.status_code == 200
    assert b'id="admin-repl-drawer"' in page.content
    assert client.get("/admin/repl/start/").status_code == 405
    assert post_json(client, "/admin/repl/start/").status_code == 403
    assert manager.get(users["owner"].pk) is None


@pytest.mark.parametrize("side", ["right", "left"])
def test_drawer_side_is_rendered_for_the_boot_script_and_the_drawer(users, settings, side):
    settings.ADMIN_REPL = {**settings.ADMIN_REPL, "SIDE": side}
    page = client_for(users["owner"]).get("/admin/").content.decode()
    assert f'admin_repl/boot.js" data-side="{side}"' in page
    assert f'hidden\n  data-side="{side}"' in page
    assert 'class="admin-repl-icon"' in page


def test_staff_pages_render_without_the_drawer(users):
    page = client_for(users["staff"]).get("/admin/")
    assert page.status_code == 200
    assert b"admin-repl" not in page.content


def test_browser_picks_a_backend_name_never_a_command(users):
    client = client_for(users["owner"])
    rejected = post_json(client, "/admin/repl/start/", {"backend": "bash"})
    assert rejected.status_code == 400
    started = post_json(
        client, "/admin/repl/start/", {"backend": "python", "argv": ["sh", "-c", "id"], "command": "sh"}
    )
    assert started.status_code == 201
    pid = started.json()["session"]["pid"]
    argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")[1:-1]
    assert argv == [b"-m", b"django_admin_repl.pty_child", b"shell", b"--interface", b"python"]


def test_another_superuser_can_neither_see_nor_end_the_owners_session(users):
    owner = client_for(users["owner"])
    session_id = post_json(owner, "/admin/repl/start/", {"backend": "python"}).json()["session"]["id"]
    other = client_for(users["other"])
    assert other.get("/admin/repl/state/").json()["session"] is None
    assert post_json(other, "/admin/repl/end/").status_code == 404
    assert owner.get("/admin/repl/state/").json()["session"]["id"] == session_id
    assert manager.get(users["owner"].pk).state is State.RUNNING


def ws_headers(user=None, origin=b"http://localhost"):
    headers = [(b"origin", origin)]
    if user is not None:
        headers.append((b"cookie", f"sessionid={client_for(user).cookies['sessionid'].value}".encode()))
    return headers


async def connect(headers):
    communicator = WebsocketCommunicator(application, STREAM, headers=headers)
    connected, code = await communicator.connect(timeout=5)
    return communicator, connected, code


async def rejected(headers):
    communicator, connected, code = await connect(headers)
    await communicator.wait()
    return connected, code


def test_websocket_refuses_anonymous_staff_and_foreign_origins(users):
    assert async_to_sync(rejected)(ws_headers()) == (False, 4403)
    assert async_to_sync(rejected)(ws_headers(users["staff"])) == (False, 4403)
    assert async_to_sync(rejected)(ws_headers(users["inactive"])) == (False, 4403)
    connected, _ = async_to_sync(rejected)(ws_headers(users["owner"], origin=b"http://evil.example"))
    assert connected is False


def test_owner_streams_input_and_output_while_another_superuser_gets_nothing(users):
    session_id = post_json(client_for(users["owner"]), "/admin/repl/start/", {"backend": "python"}).json()["session"][
        "id"
    ]
    session = manager.get(users["owner"].pk)
    wait_output(session, ">>> ")
    owner_headers, other_headers = ws_headers(users["owner"]), ws_headers(users["other"])

    async def scenario():
        other, connected, _ = await connect(other_headers)
        assert connected
        await other.send_to(text_data=json.dumps({"type": "attach", "session": session_id, "cursor": 0}))
        assert json.loads(await other.receive_from()) == {"type": "attached", "session": None}
        await other.send_to(bytes_data=b"print('intruder')\r")

        owner, connected, _ = await connect(owner_headers)
        assert connected
        await owner.send_to(text_data=json.dumps({"type": "attach", "session": session_id, "cursor": 0}))
        attached = json.loads(await owner.receive_from())
        assert (attached["type"], attached["session"]["id"], attached["reset"]) == ("attached", session_id, False)
        await owner.send_to(bytes_data=b"print(7 * 191)\r")
        received, cursor = b"", 0
        while b"1337" not in received:
            frame = await owner.receive_output(timeout=10)
            if frame.get("bytes"):
                offset = struct.unpack(">Q", frame["bytes"][:8])[0]
                assert offset == cursor
                cursor = offset + len(frame["bytes"]) - 8
                received += frame["bytes"][8:]
        await owner.disconnect()
        await other.disconnect()
        return received

    received = async_to_sync(scenario)()
    assert b"intruder" not in received
    assert b"1337" in received
