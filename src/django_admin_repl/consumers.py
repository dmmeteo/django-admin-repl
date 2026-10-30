import asyncio
import json
import struct
from typing import Any

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from .access import OwnerId, current_repl_user_id, repl_owner
from .sessions import ReplSession, State, manager

MAX_INPUT_FRAME = 64 * 1024
REVALIDATE_SECONDS = 10
CLOSE_FORBIDDEN = 4403
CLOSE_REVOKED = 4401


class ReplConsumer(AsyncWebsocketConsumer):
    session: ReplSession | None = None
    stream: asyncio.Task[None] | None = None
    revalidate: asyncio.Task[None] | None = None

    async def connect(self) -> None:
        owner = repl_owner(self.scope.get("user"))
        if owner is None:
            await self.close(code=CLOSE_FORBIDDEN)
            return
        self.user_id: OwnerId = owner
        self.session_key: str | None = self.scope["session"].session_key
        self.cursor = 0
        self.wakeup = asyncio.Event()
        self.loop = asyncio.get_running_loop()
        await self.accept()
        self.revalidate = asyncio.create_task(self._revalidate())

    async def disconnect(self, code: int) -> None:
        self._detach()
        if self.revalidate is not None:
            self.revalidate.cancel()

    async def receive(self, text_data: str | None = None, bytes_data: bytes | None = None) -> None:
        if bytes_data is not None:
            if len(bytes_data) > MAX_INPUT_FRAME:
                await self.close(code=1009)
            elif self.session is not None and not self.session.write(bytes_data):
                await self._send_json({"type": "state", "session": self.session.snapshot()})
            return
        if text_data is None:
            return
        try:
            message = json.loads(text_data)
            kind = message["type"]
        except (TypeError, ValueError, KeyError):
            await self.close(code=1003)
            return
        if kind == "attach":
            await self._attach(message.get("session"), message.get("cursor"))
        elif kind == "resize":
            cols, rows = _dimension(message.get("cols"), 1000), _dimension(message.get("rows"), 500)
            if self.session is not None and cols and rows:
                self.session.resize(cols, rows)

    async def _attach(self, session_id: object, cursor: object) -> None:
        self._detach()
        session = manager.get(self.user_id)
        if session is None:
            await self._send_json({"type": "attached", "session": None})
            return
        start = _offset(cursor) if session_id == session.id else None
        reset = start is None or start > session.output_end
        self.session = session
        self.cursor = 0 if start is None or reset else start
        session.subscribe(self._notify)
        await self._send_json(
            {"type": "attached", "session": session.snapshot(), "reset": reset, "live_from": session.output_end}
        )
        self.stream = asyncio.create_task(self._stream(session))

    def _detach(self) -> None:
        # A client may attach again on the same socket (to redraw); only one stream loop may feed it.
        if self.stream is not None and self.stream is not asyncio.current_task():
            self.stream.cancel()
        self.stream = None
        if self.session is not None:
            self.session.unsubscribe(self._notify)
            self.session = None

    def _notify(self) -> None:
        try:
            self.loop.call_soon_threadsafe(self.wakeup.set)
        except RuntimeError:
            pass

    async def _stream(self, session: ReplSession) -> None:
        while self.session is session:
            offset, data = session.read(self.cursor)
            if offset > self.cursor:
                await self._send_json({"type": "gap", "from": self.cursor, "to": offset})
                self.cursor = offset
            if data:
                await self.send(bytes_data=struct.pack(">Q", offset) + data)
                self.cursor = offset + len(data)
                continue
            if session.state is not State.RUNNING:
                await self._send_json({"type": "state", "session": session.snapshot()})
                self._detach()
                return
            await self.wakeup.wait()
            self.wakeup.clear()

    async def _revalidate(self) -> None:
        while True:
            await asyncio.sleep(REVALIDATE_SECONDS)
            if await database_sync_to_async(current_repl_user_id)(self.session_key) != self.user_id:
                await self.close(code=CLOSE_REVOKED)
                return

    async def _send_json(self, payload: dict[str, Any]) -> None:
        await self.send(text_data=json.dumps(payload))


def _offset(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _dimension(value: object, upper: int) -> int | None:
    number = _offset(value)
    return number if number is not None and 1 <= number <= upper else None
