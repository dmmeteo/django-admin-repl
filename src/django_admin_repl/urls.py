from django.urls import path

from . import views

app_name = "admin_repl"

urlpatterns = [
    path("state/", views.state, name="state"),
    path("start/", views.start, name="start"),
    path("end/", views.end, name="end"),
]
