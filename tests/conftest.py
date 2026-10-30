import dataclasses
import itertools

import pytest

from django_admin_repl.conf import Facts, get_config
from django_admin_repl.sessions import manager

_owner_ids = itertools.count(10_000)


@pytest.fixture
def repl():
    started = []

    def start(backend="python", **overrides):
        config = dataclasses.replace(get_config(), **overrides)
        owner_id = next(_owner_ids)
        session, created = manager.start(owner_id, config.offered(Facts.observe())[backend], config)
        assert created
        started.append(owner_id)
        return session

    yield start
    for owner_id in started:
        manager.end(owner_id)
