# runtime: the demo project with the app on PYTHONPATH, used for the browser journeys.
FROM python:3.14-slim-trixie@sha256:cd89c30eda26ee911a4611b18680086e0ea42e6f5f8cbe653d07fa7958c9cec8 AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/src:/app/demo \
    DJANGO_SETTINGS_MODULE=demo_project.settings \
    DEMO_DATA_DIR=/data \
    HOME=/tmp/home \
    LANG=C.UTF-8
COPY requirements/demo.txt /tmp/requirements.txt
RUN python -m pip install --require-hashes --no-deps -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /tmp/home --shell /usr/sbin/nologin repl \
 && mkdir /data \
 && chown 10001:10001 /data
COPY src /app/src
COPY demo /app/demo
WORKDIR /app/demo
USER 10001:10001
EXPOSE 8000
CMD ["/app/demo/entrypoint.sh"]

# ci: one virtual environment per Python x Django matrix cell plus the development tools. The source is
# mounted at run time, so editing it never rebuilds the environments.
FROM python:3.14-slim-trixie@sha256:cd89c30eda26ee911a4611b18680086e0ea42e6f5f8cbe653d07fa7958c9cec8 AS ci
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_NO_CACHE=1 \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    HOME=/tmp/home \
    LANG=C.UTF-8
COPY requirements/matrix.txt requirements/dev.txt requirements/matrix-cells.txt /tmp/requirements/
RUN python -m pip install uv==0.13.6 \
 && uv python install 3.12.13 3.13.13 \
 && while read -r cell python django extras; do \
      case "$cell" in ''|'#'*) continue;; esac; \
      [ "$extras" = - ] && extras=; \
      uv venv -q --python "$python" "/opt/cells/$cell" \
      && uv pip install -q --python "/opt/cells/$cell/bin/python" -c /tmp/requirements/matrix.txt \
           "Django==$django" channels daphne pytest pytest-django $(echo "$extras" | tr ',' ' ') \
      || exit 1; \
    done < /tmp/requirements/matrix-cells.txt \
 && uv venv -q --python 3.14 /opt/dev \
 && uv pip install -q --python /opt/dev/bin/python -c /tmp/requirements/matrix.txt -r /tmp/requirements/dev.txt \
      "Django==6.1.2" channels \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /tmp/home --shell /usr/sbin/nologin ci
# uv installs without bytecode and the tests run with PYTHONDONTWRITEBYTECODE, so compile once here: every REPL
# the tests start imports Django (and IPython) from scratch otherwise. The stdlib ships deliberately invalid test
# files, so compile_dir's result is not checked; an interpreter that cannot run fails the step.
RUN for env in /opt/cells/* /opt/dev; do \
      "$env/bin/python" -c 'import compileall, site, sysconfig; [compileall.compile_dir(d, quiet=2, workers=0) for d in {sysconfig.get_paths()["stdlib"], *site.getsitepackages()}]' \
      || exit 1; \
    done
USER 10001:10001
WORKDIR /tmp
