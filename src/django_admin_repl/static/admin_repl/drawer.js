const OPEN_KEY = "admin-repl:open";
const WIDE_KEY = "admin-repl:wide";
const LAST_KEY = "admin-repl:last-session";
const WIDTH_KEY = "admin-repl:width";
const INPUT_CHUNK = 32 * 1024;
const CLOSE_REVOKED = 4401;
const CLOSE_FORBIDDEN = 4403;

const THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#79aec8",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

// Window-splitter keys. The separator moves with the arrow: ArrowLeft widens a right-hand drawer and
// narrows a left-hand one. `outward` is +1 when moving the separator left widens the drawer.
const RESIZE_KEYS = {
  ArrowLeft: (width, step, bounds, outward) => width + outward * step,
  ArrowRight: (width, step, bounds, outward) => width - outward * step,
  Home: (width, step, bounds) => bounds.min,
  End: (width, step, bounds) => bounds.max,
};

const STATE_LABELS = {
  running: ["Live", "live"],
  exited: ["Exited", "warning"],
  ended: ["Ended", "none"],
  expired: ["Expired", "warning"],
};

const drawer = document.getElementById("admin-repl-drawer");
if (drawer) setup(drawer);

function setup(drawer) {
  const root = document.documentElement;
  const toggle = document.querySelector("[data-admin-repl-toggle]");
  const part = (role) => drawer.querySelector(`[data-role="${role}"]`);
  const action = (name) => drawer.querySelector(`[data-action="${name}"]`);
  const ui = {
    state: part("state"),
    notice: part("notice"),
    launch: part("launch"),
    backend: part("backend"),
    screen: part("screen"),
    meta: part("meta"),
    resize: part("resize"),
    start: action("start"),
    end: action("end"),
    widen: action("widen"),
    close: action("close"),
  };
  const urls = drawer.dataset;
  const csrfToken = drawer.querySelector("input[name=csrfmiddlewaretoken]").value;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const encoder = new TextEncoder();
  const outward = drawer.dataset.side === "left" ? -1 : 1;
  const storage = (area) => ({
    get(key) {
      try {
        return window[area].getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window[area].setItem(key, value);
      } catch {}
    },
  });
  const tabStore = storage("sessionStorage");
  const browserStore = storage("localStorage");

  let terminal = null;
  let terminalReady = null;
  let socket = null;
  let session = null;
  let cursor = 0;
  let liveFrom = 0;
  let replaying = false;
  let reconnectDelay = 500;
  let reconnectTimer = null;
  let fitFrame = 0;
  let redrawTimer = null;
  // From sending "attach" until the server's "attached": frames from the previous stream are dropped.
  let attaching = false;
  let idleLimit = null;

  drawer.adminRepl = {
    get terminal() {
      return terminal?.term ?? null;
    },
    get session() {
      return session;
    },
    get cursor() {
      return cursor;
    },
  };

  function setState(label, kind) {
    ui.state.textContent = label;
    ui.state.dataset.state = kind;
  }

  function setNotice(text) {
    ui.notice.textContent = text || "";
  }

  function adopt(snapshot) {
    session = snapshot;
    browserStore.set(LAST_KEY, snapshot ? snapshot.id : "");
  }

  function formatDuration(seconds) {
    if (seconds % 3600 === 0) return `${seconds / 3600} h`;
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds} s`;
  }

  function renderLive() {
    const [label, kind] = STATE_LABELS.running;
    setState(label, kind);
    ui.launch.hidden = true;
    ui.end.hidden = false;
    ui.meta.textContent = `${session.backend_label} · pid ${session.pid} · ends after ${formatDuration(session.idle_timeout)} without input`;
  }

  function renderStopped(snapshot) {
    const [label, kind] = snapshot ? STATE_LABELS[snapshot.state] : ["Not started", "none"];
    setState(label, kind);
    ui.launch.hidden = false;
    ui.end.hidden = true;
    ui.start.textContent = snapshot ? "Start new session" : "Start session";
    ui.meta.textContent = snapshot
      ? `${snapshot.backend_label} · session ${snapshot.id.slice(0, 8)}`
      : idleLimit && `Sessions end after ${formatDuration(idleLimit)} without input.`;
    if (snapshot?.reason) setNotice(snapshot.reason);
  }

  function renderBackends(data) {
    idleLimit = data.idle_timeout;
    const chosen = ui.backend.value || data.default_backend;
    ui.backend.replaceChildren(
      ...data.backends.map(({ key, label }) => new Option(label, key, false, key === chosen)),
    );
  }

  async function api(method, url, body) {
    const headers = { Accept: "application/json" };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["X-CSRFToken"] = csrfToken;
    }
    const response = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      body: method === "POST" ? JSON.stringify(body || {}) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(data.error || `Request failed with HTTP ${response.status}.`), {
        status: response.status,
      });
    }
    return data;
  }

  async function ensureTerminal() {
    terminalReady ??= createTerminal();
    return terminalReady;
  }

  async function createTerminal() {
    const { Ghostty, Terminal, FitAddon } = await import(urls.ghosttyUrl);
    const ghostty = await Ghostty.load(urls.wasmUrl);
    const monospace = getComputedStyle(root).getPropertyValue("--font-family-monospace").trim();
    const term = new Terminal({
      ghostty,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: monospace || "monospace",
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ui.screen);
    term.onData(sendInput);
    term.onResize(({ cols, rows }) => {
      sendControl({ type: "resize", cols, rows });
      if (cursor > 0) scheduleRedraw();
    });
    new ResizeObserver(scheduleFit).observe(ui.screen);
    terminal = { term, fit };
    fit.fit();
    return terminal;
  }

  function scheduleFit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      if (terminal && !drawer.hidden && ui.screen.clientWidth > 0) terminal.fit.fit();
    });
  }

  // ghostty-web 0.4.0 can leave stale WASM memory in cells when it reflows existing rows to a new grid
  // (DESIGN.md, "Known defects"). Once the grid settles, the screen is rebuilt from the server's output log
  // at the new size, the same replay a reload does.
  function scheduleRedraw() {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      if (session?.state !== "running" || socket?.readyState !== WebSocket.OPEN) return;
      terminal.term.reset();
      cursor = 0;
      attaching = true;
      socket.send(JSON.stringify({ type: "attach", session: session.id, cursor }));
    }, 250);
  }

  function sendControl(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function sendInput(data) {
    if (replaying || session?.state !== "running" || socket?.readyState !== WebSocket.OPEN) return;
    const bytes = encoder.encode(data);
    for (let index = 0; index < bytes.length; index += INPUT_CHUNK) {
      socket.send(bytes.subarray(index, index + INPUT_CHUNK));
    }
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    if (socket) {
      socket.onclose = null;
      socket.close(1000);
      socket = null;
    }
  }

  function connect() {
    disconnect();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}${urls.streamPath}`);
    ws.binaryType = "arraybuffer";
    socket = ws;
    setState("Connecting", "warning");
    ws.onopen = () => {
      reconnectDelay = 500;
      attaching = true;
      ws.send(JSON.stringify({ type: "attach", session: session?.id ?? null, cursor }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") onControl(JSON.parse(event.data));
      else onOutput(event.data);
    };
    ws.onclose = (event) => onSocketClosed(ws, event);
  }

  function onControl(message) {
    if (message.type === "attached") {
      attaching = false;
      if (!message.session) {
        disconnect();
        adopt(null);
        renderStopped(null);
        return;
      }
      if (message.reset) {
        terminal.term.reset();
        cursor = 0;
      }
      adopt(message.session);
      liveFrom = message.live_from;
      if (message.session.state === "running") renderLive();
      scheduleFit();
      sendControl({ type: "resize", cols: terminal.term.cols, rows: terminal.term.rows });
    } else if (message.type === "gap" && !attaching) {
      setNotice(
        `Earlier output was not retained: replay starts at byte ${message.to}, ${message.to - message.from} bytes are not shown.`,
      );
      cursor = message.to;
    } else if (message.type === "state") {
      adopt(message.session);
      if (message.session.state !== "running") {
        disconnect();
        renderStopped(message.session);
      }
    }
  }

  function onOutput(buffer) {
    if (attaching) return;
    const offset = Number(new DataView(buffer).getBigUint64(0));
    let bytes = new Uint8Array(buffer, 8);
    if (offset > cursor) {
      setNotice(`${offset - cursor} bytes of output were lost in transit and are not shown.`);
    } else if (offset < cursor) {
      bytes = bytes.subarray(cursor - offset);
    }
    const start = Math.max(offset, cursor);
    cursor = start + bytes.length;
    if (!bytes.length) return;
    // Replayed history can contain terminal queries; their synchronous replies must not reach the live REPL.
    replaying = start < liveFrom;
    try {
      terminal.term.write(bytes);
    } finally {
      replaying = false;
    }
  }

  function onSocketClosed(ws, event) {
    if (socket !== ws) return;
    socket = null;
    if (event.code === CLOSE_REVOKED || event.code === CLOSE_FORBIDDEN) {
      setState("Not authorized", "error");
      setNotice("This browser session is no longer authorized for the REPL. Log in again as an active superuser.");
      return;
    }
    if (session?.state === "running") {
      setState("Disconnected", "warning");
      setNotice(`Connection lost. Reconnecting in ${Math.round(reconnectDelay / 100) / 10} s.`);
      reconnectTimer = setTimeout(refresh, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    }
  }

  async function refresh() {
    let data;
    try {
      data = await api("GET", urls.stateUrl);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        setState("Not authorized", "error");
        setNotice(error.message);
        return;
      }
      setState("Disconnected", "error");
      setNotice(`${error.message} Retrying in ${Math.round(reconnectDelay / 1000)} s.`);
      reconnectTimer = setTimeout(refresh, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      return;
    }
    renderBackends(data);
    const previous = browserStore.get(LAST_KEY);
    const current = data.session;
    if (previous && current?.id !== previous) {
      setNotice(
        `Session ${previous.slice(0, 8)} no longer exists on the server. It was replaced, or the server restarted and its Python state is gone.`,
      );
    } else if (!current || current.state === "running") {
      setNotice("");
    }
    if (current?.state === "running") {
      await ensureTerminal();
      if (current.id !== session?.id) {
        terminal.term.reset();
        cursor = 0;
      }
      adopt(current);
      connect();
    } else {
      adopt(current);
      renderStopped(current);
    }
  }

  async function start() {
    ui.start.disabled = true;
    try {
      const data = await api("POST", urls.startUrl, { backend: ui.backend.value });
      await ensureTerminal();
      terminal.term.reset();
      cursor = 0;
      adopt(data.session);
      setNotice("");
      connect();
      terminal.term.focus();
    } catch (error) {
      setState("Error", "error");
      setNotice(error.message);
    } finally {
      ui.start.disabled = false;
    }
  }

  async function end() {
    if (!confirm("End this REPL session? The Python process and everything defined in it will be terminated.")) {
      return;
    }
    try {
      const data = await api("POST", urls.endUrl);
      disconnect();
      adopt(data.session);
      renderStopped(data.session);
    } catch (error) {
      setNotice(error.message);
    }
  }

  function focusInside() {
    if (session?.state === "running" && terminal) terminal.term.focus();
    else if (!ui.launch.hidden) ui.backend.focus();
    else ui.close.focus();
  }

  async function open({ focus = true } = {}) {
    drawer.hidden = false;
    root.classList.add("admin-repl-docked");
    toggle?.setAttribute("aria-expanded", "true");
    tabStore.set(OPEN_KEY, "1");
    syncWidth();
    requestAnimationFrame(() => drawer.classList.add("is-open"));
    if (!socket) await refresh();
    scheduleFit();
    if (focus) focusInside();
  }

  function close() {
    drawer.classList.remove("is-open");
    root.classList.remove("admin-repl-docked");
    toggle?.setAttribute("aria-expanded", "false");
    tabStore.set(OPEN_KEY, "0");
    const hide = () => {
      if (!drawer.classList.contains("is-open")) drawer.hidden = true;
    };
    if (reducedMotion.matches) hide();
    else setTimeout(hide, 180);
    toggle?.focus();
  }

  function setWide(wide) {
    root.classList.toggle("admin-repl-wide", wide);
    ui.widen.setAttribute("aria-pressed", String(wide));
    ui.widen.textContent = wide ? "Docked width" : "Full width";
    tabStore.set(WIDE_KEY, wide ? "1" : "0");
    syncWidth();
    scheduleFit();
  }

  function drawerWidth() {
    return drawer.getBoundingClientRect().width;
  }

  // The same bounds as the CSS clamp() on --admin-repl-width.
  function widthBounds() {
    const style = getComputedStyle(root);
    const min = parseFloat(style.getPropertyValue("--admin-repl-min-width"));
    return { min, max: Math.max(min, innerWidth - parseFloat(style.getPropertyValue("--admin-repl-min-page"))) };
  }

  function syncWidth() {
    const { min, max } = widthBounds();
    const width = Math.round(drawerWidth());
    ui.resize.setAttribute("aria-valuemin", min);
    ui.resize.setAttribute("aria-valuemax", max);
    ui.resize.setAttribute("aria-valuenow", width);
    ui.resize.setAttribute("aria-valuetext", `${width} pixels wide`);
  }

  // The terminal follows through the ResizeObserver on the screen, which refits Ghostty and resizes the PTY.
  function setWidth(width) {
    const { min, max } = widthBounds();
    const clamped = Math.round(Math.min(Math.max(width, min), max));
    root.style.setProperty("--admin-repl-preferred", `${clamped}px`);
    browserStore.set(WIDTH_KEY, String(clamped));
    syncWidth();
  }

  function startResize(event) {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = drawerWidth();
    const follow = (moved) => setWidth(startWidth + outward * (startX - moved.clientX));
    ui.resize.setPointerCapture(event.pointerId);
    root.classList.add("admin-repl-resizing");
    ui.resize.addEventListener("pointermove", follow);
    ui.resize.addEventListener(
      "lostpointercapture",
      () => {
        ui.resize.removeEventListener("pointermove", follow);
        root.classList.remove("admin-repl-resizing");
      },
      { once: true },
    );
  }

  toggle?.addEventListener("click", () => (drawer.hidden ? open() : close()));
  ui.close.addEventListener("click", close);
  ui.widen.addEventListener("click", () => setWide(!root.classList.contains("admin-repl-wide")));
  ui.resize.addEventListener("pointerdown", startResize);
  // Keeps focus in the terminal and stops the drag from starting a text selection.
  ui.resize.addEventListener("mousedown", (event) => event.preventDefault());
  ui.resize.addEventListener("keydown", (event) => {
    const next = RESIZE_KEYS[event.key];
    if (!next || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    setWidth(next(drawerWidth(), event.shiftKey ? 80 : 16, widthBounds(), outward));
  });
  addEventListener("resize", () => {
    if (!drawer.hidden) syncWidth();
  });
  ui.start.addEventListener("click", start);
  ui.end.addEventListener("click", end);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === "`") {
        event.preventDefault();
        event.stopPropagation();
        if (drawer.hidden) open();
        else close();
      } else if (
        event.key === "Escape" &&
        !drawer.hidden &&
        drawer.contains(document.activeElement) &&
        !ui.screen.contains(document.activeElement)
      ) {
        close();
      }
    },
    true,
  );

  setWide(tabStore.get(WIDE_KEY) === "1");
  if (tabStore.get(OPEN_KEY) === "1") open({ focus: false });
}
