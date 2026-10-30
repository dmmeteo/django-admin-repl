from django.urls import path

from .conf import get_config
from .consumers import ReplConsumer

websocket_urlpatterns = [path(get_config().stream_path.lstrip("/"), ReplConsumer.as_asgi())]
