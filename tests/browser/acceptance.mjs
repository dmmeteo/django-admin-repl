import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL;
const ARTIFACTS = process.env.ARTIFACTS ?? "/artifacts";
const STATE = process.env.STATE_DIR ?? "/state";
const PHASE = process.argv[2] ?? "main";
const accounts = JSON.parse(readFileSync(process.env.CREDENTIALS_FILE, "utf8"));
const DESKTOP = { width: 1440, height: 900 };
mkdirSync(ARTIFACTS, { recursive: true });

const passed = [];
const observed = { console: [], urls: [] };

async function check(name, body) {
  const started = Date.now();
  const detail = await body();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  passed.push({ name, detail: detail ?? "", seconds });
  console.log(`PASS ${name}${detail ? ` (${detail})` : ""} [${seconds}s]`);
}

async function newContext(browser, options = {}) {
  const context = await browser.newContext({ viewport: DESKTOP, colorScheme: "dark", ...options });
  context.on("console", (message) => observed.console.push(message.text()));
  context.on("request", (request) => observed.urls.push(request.url()));
  await context.addInitScript(() => {
    window.__screenText = () => {
      const term = document.getElementById("admin-repl-drawer")?.adminRepl?.terminal;
      if (!term) return "";
      const buffer = term.buffer.active;
      const lines = [];
      for (let y = 0; y < buffer.length; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
      return lines.join("\n");
    };
  });
  return context;
}

async function login(page, account) {
  await page.goto(`${BASE}/admin/login/?next=/admin/`);
  await page.fill("#id_username", account.username);
  await page.fill("#id_password", account.password);
  await Promise.all([page.waitForLoadState("load"), page.getByRole("button", { name: "Log in" }).click()]);
}

const drawer = (page) => page.locator("#admin-repl-drawer");
const stateText = (page) => page.locator("#admin-repl-drawer [data-role=state]").textContent();
const noticeText = (page) => page.locator("#admin-repl-drawer [data-role=notice]").textContent();
// Rows come back with trailing spaces trimmed, so a prompt such as ">>> " is matched as ">>>".
const screenText = (page) => page.evaluate(() => window.__screenText());

async function waitState(page, label, timeout = 30000) {
  await page.waitForFunction(
    (expected) => document.querySelector("#admin-repl-drawer [data-role=state]")?.textContent === expected,
    label,
    { timeout },
  );
}

async function waitScreen(page, needle, timeout = 60000) {
  try {
    await page.waitForFunction((text) => window.__screenText().includes(text), needle, { timeout, polling: 100 });
  } catch (error) {
    throw new Error(`Terminal never showed ${JSON.stringify(needle)}. Screen:\n${(await screenText(page)).slice(-1500)}`);
  }
}

async function openDrawer(page) {
  await page.click("[data-admin-repl-toggle]");
  await drawer(page).waitFor({ state: "visible" });
}

async function focusTerminal(page) {
  await page.locator("#admin-repl-drawer [data-role=screen] canvas").click();
}

async function run(page, code, expected) {
  await focusTerminal(page);
  await page.keyboard.type(code);
  await page.keyboard.press("Enter");
  if (expected) await waitScreen(page, expected);
}

async function startSession(page, backend, prompt) {
  if (backend) await page.selectOption("#admin-repl-drawer [data-role=backend]", backend);
  await page.click("#admin-repl-drawer [data-action=start]");
  await waitState(page, "Live");
  await waitScreen(page, prompt);
  return page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.session);
}

async function startTypingAhead(page, backend, prompt) {
  await page.selectOption("#admin-repl-drawer [data-role=backend]", backend);
  await page.click("#admin-repl-drawer [data-action=start]");
  await waitState(page, "Live");
  const deadline = Date.now() + 90000;
  while (!(await screenText(page)).includes(prompt)) {
    if (Date.now() >= deadline) {
      const server = (await api(page, "GET", "/admin/repl/state/")).body?.session;
      const client = await page.evaluate(() => {
        const repl = document.getElementById("admin-repl-drawer").adminRepl;
        return { cursor: repl.cursor, cols: repl.terminal?.cols, state: repl.session?.state };
      });
      assert.fail(
        `no ${prompt} prompt within 90 s; server output ${server?.output_start}..${server?.output_end} bytes, ` +
          `pid ${server?.pid}, state ${server?.state}; client ${JSON.stringify(client)}; ` +
          `screen ${JSON.stringify((await screenText(page)).trim().slice(-400))}`,
      );
    }
    await focusTerminal(page);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
  }
  return page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.session);
}

async function endSession(page) {
  page.once("dialog", (dialog) => dialog.accept());
  await page.click("#admin-repl-drawer [data-action=end]");
  await waitState(page, "Ended");
}

async function canvasInk(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("#admin-repl-drawer [data-role=screen] canvas");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 420) ink += 1;
    }
    return { width: canvas.width, height: canvas.height, ink };
  });
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ([method, path, body]) => {
      const token = document.cookie.split("; ").find((item) => item.startsWith("csrftoken="))?.slice(10) ?? "";
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRFToken": token },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    [method, path, body],
  );
}

async function probeStream(page, sessionId) {
  return page.evaluate(async (sessionId) => {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/admin/repl/stream/`);
      const messages = [];
      let opened = false;
      const finish = (code) => {
        clearTimeout(timer);
        resolve({ opened, code, messages });
      };
      const timer = setTimeout(() => {
        ws.close();
        finish("timeout");
      }, 6000);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ type: "attach", session: sessionId, cursor: 0 }));
      };
      ws.onmessage = (event) => {
        messages.push(typeof event.data === "string" ? JSON.parse(event.data) : { binary: event.data.byteLength });
        if (typeof event.data === "string") {
          ws.send(new TextEncoder().encode("print('intruder-' * 2)\r"));
          setTimeout(() => {
            ws.onclose = null;
            ws.close();
            finish("closed-by-probe");
          }, 1000);
        }
      };
      ws.onclose = (event) => finish(event.code);
    });
  }, sessionId);
}

async function shot(page, name, locator) {
  const path = `${ARTIFACTS}/${name}.png`;
  await (locator ?? page).screenshot({ path });
  return path;
}

const separator = (page) => page.locator("#admin-repl-drawer [data-role=resize]");

async function dragSeparator(page, dx) {
  const box = await separator(page).boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 3);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.round(dx / 2), y, { steps: 6 });
  const during = await page.evaluate(() => ({
    resizing: document.documentElement.classList.contains("admin-repl-resizing"),
    userSelect: getComputedStyle(document.documentElement).userSelect,
  }));
  await page.mouse.move(x + dx, y, { steps: 6 });
  await page.mouse.up();
  return during;
}

async function drawerLayout(page) {
  return page.evaluate(() => {
    const drawer = document.getElementById("admin-repl-drawer");
    const box = drawer.getBoundingClientRect();
    const handle = drawer.querySelector("[data-role=resize]");
    const term = drawer.adminRepl.terminal;
    const page = document.getElementById("container").getBoundingClientRect();
    return {
      width: Math.round(box.width),
      left: Math.round(box.left),
      right: Math.round(box.right),
      pageLeft: Math.round(page.left),
      pageRight: Math.round(page.right),
      overflow: document.documentElement.scrollWidth - innerWidth,
      selected: getSelection().toString(),
      termSelected: Boolean(term?.hasSelection()),
      cols: term?.cols ?? null,
      canvas: drawer.querySelector("[data-role=screen] canvas")?.width ?? null,
      aria: ["now", "min", "max"].map((name) => Number(handle.getAttribute(`aria-value${name}`))),
      stored: localStorage.getItem("admin-repl:width"),
      resizing: document.documentElement.classList.contains("admin-repl-resizing"),
      focus: document.activeElement?.tagName ?? null,
    };
  });
}

function assertBesidePage(layout, width) {
  assert.equal(layout.width, width, "drawer width");
  assert.equal(layout.aria[0], width, "separator aria-valuenow");
  assert.ok(layout.pageRight <= layout.left, `admin page ends at ${layout.pageRight}px, drawer starts at ${layout.left}px`);
  assert.ok(layout.overflow <= 0, `page scrolls ${layout.overflow}px sideways under the drawer`);
  assert.equal(layout.selected, "", "dragging selected admin text");
  assert.equal(layout.termSelected, false, "dragging selected terminal text");
  assert.equal(layout.resizing, false);
}

async function waitColumns(page, previous) {
  await page.waitForFunction(
    (cols) => document.getElementById("admin-repl-drawer").adminRepl.terminal.cols !== cols,
    previous,
  );
  await page.waitForTimeout(200);
}

// Rows of the terminal buffer up to the cursor, as text. Anything outside printable ASCII in a plain
// Python session is a rendering defect, not REPL output.
async function bufferRows(page) {
  return page.evaluate(() => {
    const term = document.getElementById("admin-repl-drawer").adminRepl.terminal;
    const buffer = term.buffer.active;
    const rows = [];
    for (let y = 0; y <= buffer.baseY + buffer.cursorY; y += 1) rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return rows;
  });
}

async function ptyColumns(page, tag) {
  const cols = await page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.terminal.cols);
  await run(page, `import os; print("${tag}", os.get_terminal_size(0).columns, marker)`, `${tag} ${cols} 42`);
  return cols;
}

async function phaseMain(browser) {
  const anonymous = await newContext(browser);
  const anonPage = await anonymous.newPage();
  await check("anonymous admin request redirects to login", async () => {
    await anonPage.goto(`${BASE}/admin/notes/note/`);
    assert.match(anonPage.url(), /\/admin\/login\/\?next=/);
  });
  await check("anonymous cannot read, start or stream", async () => {
    assert.equal((await api(anonPage, "GET", "/admin/repl/state/")).status, 401);
    assert.equal((await api(anonPage, "POST", "/admin/repl/start/")).status, 401);
    const probe = await probeStream(anonPage, null);
    assert.equal(probe.opened, false);
    assert.deepEqual(probe.messages, []);
    return `websocket close ${probe.code}`;
  });
  await anonymous.close();

  const inactive = await newContext(browser);
  const inactivePage = await inactive.newPage();
  await check("inactive superuser cannot log in", async () => {
    await login(inactivePage, accounts.inactive);
    assert.match(inactivePage.url(), /\/admin\/login\//);
    assert.match(await inactivePage.locator(".errornote").textContent(), /correct username and password/);
  });
  await inactive.close();

  const staff = await newContext(browser);
  const staffPage = await staff.newPage();
  await check("staff user sees stock admin without the REPL and is refused", async () => {
    await login(staffPage, accounts.staff);
    assert.equal(await staffPage.locator("[data-admin-repl-toggle]").count(), 0);
    assert.equal(await staffPage.locator("#admin-repl-drawer").count(), 0);
    assert.equal((await api(staffPage, "GET", "/admin/repl/state/")).status, 403);
    assert.equal((await api(staffPage, "POST", "/admin/repl/start/")).status, 403);
    const probe = await probeStream(staffPage, null);
    assert.equal(probe.opened, false);
    return `websocket close ${probe.code}`;
  });
  await staff.close();

  const ownerContext = await newContext(browser);
  const page = await ownerContext.newPage();
  await login(page, accounts.owner);

  await check("drawer is closed on first load and rendering starts no process", async () => {
    assert.equal(await drawer(page).isHidden(), true);
    assert.equal(await page.locator("[data-admin-repl-toggle]").getAttribute("aria-expanded"), "false");
    assert.equal((await api(page, "GET", "/admin/repl/state/")).body.session, null);
  });

  await check("toggle opens the drawer with the server-validated interpreter list", async () => {
    await openDrawer(page);
    await waitState(page, "Not started");
    const options = await page.locator("#admin-repl-drawer [data-role=backend] option").evaluateAll((items) =>
      items.map((item) => `${item.value}${item.selected ? "*" : ""}`),
    );
    assert.deepEqual(options, ["python", "ipython*", "shell_plus"]);
    assert.equal(await page.locator("[data-admin-repl-toggle]").getAttribute("aria-expanded"), "true");
    assert.equal((await api(page, "GET", "/admin/repl/state/")).body.session, null);
    return options.join(",");
  });

  let live;
  await check("explicit start launches a real IPython Django shell rendered by Ghostty", async () => {
    const blank = await canvasInk(page).catch(() => ({ ink: 0 }));
    live = await startSession(page, null, "In [1]:");
    await run(page, "marker = 6 * 7", null);
    await run(page, 'print(f"value={marker * 1000}")', "value=42000");
    const inked = await canvasInk(page);
    assert.ok(inked.ink > blank.ink + 500, `canvas ink ${blank.ink} -> ${inked.ink}`);
    await shot(page, "owner-desktop-live-dark");
    return `${live.backend_label}, pid ${live.pid}, canvas ${inked.width}x${inked.height}, bright pixels ${inked.ink}`;
  });

  await check("the shell updates a Note through the ORM", async () => {
    await run(page, 'Note.objects.filter(pk=1).update(title="Renamed from the REPL")', "Out[");
    await run(page, "print(Note.objects.get(pk=1).title.upper())", "RENAMED FROM THE REPL");
  });

  await check("navigating to another admin page reattaches to the same process and variables", async () => {
    await Promise.all([page.waitForURL(/\/admin\/notes\/note\/$/), page.locator("a[href='/admin/notes/note/']").first().click()]);
    await waitState(page, "Live");
    assert.equal((await page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.session)).id, live.id);
    await waitScreen(page, "value=42000");
    assert.ok(await page.locator("#result_list").getByText("Renamed from the REPL").isVisible());
    await run(page, 'print(f"after-nav={marker + 1}")', "after-nav=43");
    return `session ${live.id.slice(0, 8)}`;
  });

  await check("reload replays history once and keeps the live variables", async () => {
    await page.reload();
    await waitState(page, "Live");
    await waitScreen(page, "after-nav=43");
    const text = await screenText(page);
    assert.equal(text.split("value=42000").length - 1, 1, "replayed output must appear exactly once");
    await run(page, 'print(f"after-reload={marker * 2}")', "after-reload=84");
    const session = await page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.session);
    assert.equal(session.id, live.id);
    assert.equal(session.pid, live.pid);
  });

  await check("paste goes through Ghostty into the REPL", async () => {
    await focusTerminal(page);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", 'pasted = "clip" * 2');
      document
        .querySelector("#admin-repl-drawer [data-role=screen] textarea")
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.keyboard.press("Enter");
    await run(page, "print(pasted.upper())", "CLIPCLIP");
  });

  await check("Ctrl-C interrupts running code and the REPL survives", async () => {
    await run(page, "import time; time.sleep(30)", null);
    await page.waitForTimeout(700);
    await page.keyboard.press("Control+c");
    await waitScreen(page, "KeyboardInterrupt", 10000);
    await run(page, 'print("survived", marker)', "survived 42");
  });

  await check("full width resizes the PTY to the rendered terminal grid", async () => {
    const before = await page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.terminal.cols);
    await page.click("#admin-repl-drawer [data-action=widen]");
    await page.waitForFunction(
      (cols) => document.getElementById("admin-repl-drawer").adminRepl.terminal.cols > cols,
      before,
    );
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.terminal.cols);
    await run(page, 'import os; print("cols=%d" % os.get_terminal_size(0).columns)', `cols=${after}`);
    await shot(page, "owner-desktop-full-width");
    await page.click("#admin-repl-drawer [data-action=widen]");
    return `${before} -> ${after} columns`;
  });

  await check("resize-drag-wide: dragging the left edge on a 1440 px screen widens the drawer up to the page minimum", async () => {
    await focusTerminal(page);
    const before = await drawerLayout(page);
    assertBesidePage(before, 720);
    assert.deepEqual(await dragSeparator(page, -300), { resizing: true, userSelect: "none" });
    await waitColumns(page, before.cols);
    const wider = await drawerLayout(page);
    assertBesidePage(wider, 1020);
    assert.equal(wider.focus, before.focus, "dragging moved focus out of the terminal");
    assert.ok(wider.cols > before.cols && wider.canvas > before.canvas, `columns ${before.cols} -> ${wider.cols}`);
    await dragSeparator(page, -400);
    const capped = await drawerLayout(page);
    assertBesidePage(capped, 1040);
    assert.deepEqual(capped.aria, [1040, 360, 1040]);
    await shot(page, "resize-wide-1440");
    return `${before.width} -> ${wider.width} px, ${before.cols} -> ${wider.cols} columns, stops at ${capped.width} px beside a 400 px page`;
  });

  await check("resize-drag-narrow: on a 960 px screen the drawer narrows to its minimum and widens to the page minimum", async () => {
    await page.setViewportSize({ width: 960, height: 800 });
    await page.waitForTimeout(300);
    const fitted = await drawerLayout(page);
    assertBesidePage(fitted, 560);
    await dragSeparator(page, 150);
    await waitColumns(page, fitted.cols);
    const narrower = await drawerLayout(page);
    assertBesidePage(narrower, 410);
    assert.ok(narrower.cols < fitted.cols, `columns ${fitted.cols} -> ${narrower.cols}`);
    await dragSeparator(page, 400);
    const floor = await drawerLayout(page);
    assertBesidePage(floor, 360);
    assert.deepEqual(floor.aria, [360, 360, 560]);
    await dragSeparator(page, -120);
    assertBesidePage(await drawerLayout(page), 480);
    await shot(page, "resize-narrow-960");
    await page.setViewportSize({ width: 700, height: 800 });
    await page.waitForTimeout(300);
    assert.equal(Math.round((await drawer(page).boundingBox()).width), 700);
    assert.equal(await separator(page).isHidden(), true, "no separator when there is no room to dock");
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(300);
    assertBesidePage(await drawerLayout(page), 480);
    return `560 -> 410 px (${fitted.cols} -> ${narrower.cols} columns), stops at 360 px; full width below 760 px`;
  });

  await check("resize-keyboard: Tab reaches the separator and arrow, Home and End keys resize the drawer", async () => {
    await page.focus("#admin-repl-drawer [data-action=widen]");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await separator(page).evaluate((node) => node === document.activeElement && node.matches(":focus-visible")), true);
    const widths = [];
    for (const key of ["ArrowLeft", "Shift+ArrowLeft", "ArrowRight", "Home", "End", "Shift+ArrowRight", "Shift+ArrowRight"]) {
      await page.keyboard.press(key);
      widths.push((await drawerLayout(page)).width);
    }
    assert.deepEqual(widths, [496, 576, 560, 360, 1040, 960, 880]);
    const layout = await drawerLayout(page);
    assertBesidePage(layout, 880);
    assert.deepEqual(layout.aria, [880, 360, 1040]);
    assert.equal(layout.stored, "880");
    await shot(page, "resize-keyboard-focus");
    return `480 -> ${widths.join(" -> ")} px`;
  });

  await check("resize-persistence: the chosen width survives navigation, reload, full width and close", async () => {
    await Promise.all([page.waitForURL(/\/admin\/$/), page.locator(".breadcrumbs a[href='/admin/']").click()]);
    await waitState(page, "Live");
    assertBesidePage(await drawerLayout(page), 880);
    await page.reload();
    await waitState(page, "Live");
    assertBesidePage(await drawerLayout(page), 880);
    await page.click("#admin-repl-drawer [data-action=widen]");
    assert.equal((await drawerLayout(page)).width, 1440);
    assert.equal(await separator(page).isHidden(), true, "no separator in full width");
    await page.click("#admin-repl-drawer [data-action=widen]");
    assertBesidePage(await drawerLayout(page), 880);
    await page.click("#admin-repl-drawer [data-action=close]");
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).paddingRight), "0px");
    await page.keyboard.press("Control+Backquote");
    await drawer(page).waitFor({ state: "visible" });
    await waitState(page, "Live");
    assertBesidePage(await drawerLayout(page), 880);
    return "880 px after navigating to the dashboard, reload, full width and back, close and reopen";
  });

  await check("resize-live-terminal: Ghostty and the PTY follow every width while the same REPL keeps its variables", async () => {
    const grids = [await ptyColumns(page, "grid-880")];
    await dragSeparator(page, 360);
    await waitColumns(page, grids[0]);
    assertBesidePage(await drawerLayout(page), 520);
    grids.push(await ptyColumns(page, "grid-520"));
    await page.setViewportSize({ width: 960, height: 800 });
    await page.waitForTimeout(300);
    await dragSeparator(page, 120);
    await waitColumns(page, grids[1]);
    assertBesidePage(await drawerLayout(page), 400);
    grids.push(await ptyColumns(page, "grid-narrow-400"));
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(300);
    await dragSeparator(page, -320);
    await waitColumns(page, grids[2]);
    assertBesidePage(await drawerLayout(page), 720);
    grids.push(await ptyColumns(page, "grid-720"));
    assert.ok(grids[0] > grids[1] && grids[1] > grids[2] && grids[3] > grids[2], `columns ${grids.join(" -> ")}`);
    const session = await page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.session);
    assert.equal(session.id, live.id);
    assert.equal(session.pid, live.pid);
    return `columns ${grids.join(" -> ")} in session ${live.id.slice(0, 8)}, pid ${live.pid}, marker still 42`;
  });

  await check("closing the drawer hides it, returns focus and keeps the session", async () => {
    await page.click("#admin-repl-drawer [data-action=close]");
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.matches("[data-admin-repl-toggle]")), true);
    const state = await api(page, "GET", "/admin/repl/state/");
    assert.equal(state.body.session.state, "running");
    assert.equal(state.body.session.id, live.id);
  });

  await check("Ctrl+` reopens the drawer with the same process", async () => {
    await page.keyboard.press("Control+Backquote");
    await drawer(page).waitFor({ state: "visible" });
    await waitState(page, "Live");
    await run(page, 'print("reopened", marker)', "reopened 42");
  });

  const other = await newContext(browser);
  const otherPage = await other.newPage();
  await check("another superuser cannot see, attach to, type into or end the owner's session", async () => {
    await login(otherPage, accounts.other);
    assert.equal((await api(otherPage, "GET", "/admin/repl/state/")).body.session, null);
    const probe = await probeStream(otherPage, live.id);
    assert.equal(probe.opened, true);
    assert.deepEqual(probe.messages, [{ type: "attached", session: null }]);
    assert.equal((await api(otherPage, "POST", "/admin/repl/end/")).status, 404);
    await openDrawer(otherPage);
    await waitState(otherPage, "Not started");
    await run(page, 'print("still", "mine")', "still mine");
    assert.equal((await screenText(page)).includes("intruder-intruder"), false);
  });
  await other.close();

  await check("ordinary admin add and change pages still work beside the drawer", async () => {
    await page.goto(`${BASE}/admin/notes/note/add/`);
    await waitState(page, "Live");
    await page.fill("#id_title", "Created with the admin form");
    await page.selectOption("#id_status", "review");
    await page.getByRole("button", { name: "Save and continue editing" }).click();
    await page.waitForURL(/\/admin\/notes\/note\/\d+\/change\/$/);
    await page.selectOption("#id_status", "done");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForURL(/\/admin\/notes\/note\/$/);
    assert.match(await page.locator(".messagelist").textContent(), /was changed successfully/);
    await run(page, 'print(Note.objects.filter(status="done").count() * 100)', null);
    await waitScreen(page, "200");
  });

  await check("narrow viewport uses a full-width drawer", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const box = await drawer(page).boundingBox();
    assert.equal(Math.round(box.width), 390);
    await run(page, 'print("narrow", marker)', "narrow 42");
    await shot(page, "owner-narrow-dark");
    await page.setViewportSize(DESKTOP);
    return `${Math.round(box.width)}px wide`;
  });

  await check("light admin theme and reduced motion are honoured", async () => {
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await waitState(page, "Live");
    await waitScreen(page, "narrow 42");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    assert.equal(await drawer(page).evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
    await shot(page, "owner-desktop-light");
    await page.evaluate(() => localStorage.setItem("theme", "auto"));
  });

  await check("replay beyond the retained window reports the gap instead of inventing output", async () => {
    await run(page, 'print(("y" * 59 + "\\n") * 12000, end="")', null);
    await page.waitForFunction(() => window.__screenText().includes("y".repeat(59)), null, { polling: 250 });
    await page.waitForTimeout(1500);
    await page.reload();
    await waitState(page, "Live");
    await page.waitForFunction(
      () => document.querySelector("#admin-repl-drawer [data-role=notice]").textContent.includes("Earlier output was not retained"),
    );
    const notice = await noticeText(page);
    await run(page, 'print("after-gap", marker)', "after-gap 42");
    return notice;
  });

  await check("End session terminates the process and a fresh one starts clean", async () => {
    await endSession(page);
    assert.match(await noticeText(page), /Ended by the user\./);
    const ended = (await api(page, "GET", "/admin/repl/state/")).body.session;
    assert.equal(ended.state, "ended");
    const fresh = await startSession(page, "ipython", "In [1]:");
    assert.notEqual(fresh.id, live.id);
    assert.notEqual(fresh.pid, live.pid);
    await run(page, "marker", "NameError");
    await endSession(page);
    return `pid ${live.pid} -> ${fresh.pid}`;
  });

  await check("builtin Python and shell_plus backends are selectable", async () => {
    await startSession(page, "python", ">>>");
    await run(page, "print(Note.objects.count() * 11)", "55");
    const python = await page.locator("#admin-repl-drawer [data-role=meta]").textContent();
    await endSession(page);
    await startSession(page, "shell_plus", "In [1]:");
    await run(page, "print(type(Note.objects).__name__)", "Manager");
    const plus = await page.locator("#admin-repl-drawer [data-role=meta]").textContent();
    await endSession(page);
    return `${python.split(" · ")[0]}; ${plus.split(" · ")[0]}`;
  });

  await check("a live session is left for the restart phase", async () => {
    const session = await startSession(page, "ipython", "In [1]:");
    await run(page, "restart_marker = 1", null);
    await ownerContext.storageState({ path: `${STATE}/owner-state.json` });
    writeFileSync(`${STATE}/restart-session.json`, JSON.stringify({ id: session.id }));
    return `session ${session.id.slice(0, 8)}`;
  });
  await ownerContext.close();
}

// Runs first on a freshly started server: the inherited cold-start and first-widening defects.
async function phaseCold(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await login(page, accounts.owner);
  await openDrawer(page);
  await check("cold-python: builtin Python as the first session of a fresh server shows its prompt and runs code", async () => {
    const session = await startTypingAhead(page, "python", ">>>");
    await run(page, "marker = 6 * 7", null);
    await run(page, 'print("cold", marker)', "cold 42");
    return `${session.backend_label}, pid ${session.pid}`;
  });
  await check("widen-rows: widening the terminal after output keeps every existing row intact", async () => {
    const before = await bufferRows(page);
    const cols = await page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.terminal.cols);
    await page.click("#admin-repl-drawer [data-action=widen]");
    await waitColumns(page, cols);
    await page.waitForTimeout(500);
    const after = await bufferRows(page);
    await shot(page, "cold-python-full-width");
    const garbled = after.filter((row) => /[^\x20-\x7e]/.test(row));
    assert.deepEqual(garbled, [], "rows with non-ASCII cells after widening");
    assert.deepEqual(after.slice(0, before.length - 1), before.slice(0, -1), "rows changed by widening");
    const wide = await ptyColumns(page, "wide");
    await page.click("#admin-repl-drawer [data-action=widen]");
    return `${before.length} rows unchanged, ${cols} -> ${wide} columns`;
  });
  await endSession(page);
  await context.close();
}

// Runs against a server configured with ADMIN_REPL["SIDE"] = "left".
async function phaseLeft(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await login(page, accounts.owner);
  await page.goto(`${BASE}/admin/notes/note/`);
  await openDrawer(page);
  await page.evaluate(() => localStorage.removeItem("admin-repl:width"));
  let live;
  await check("left-side: SIDE='left' docks the drawer on the left with the admin page beside it", async () => {
    live = await startSession(page, null, "In [");
    await run(page, "marker = 6 * 7", null);
    const layout = await drawerLayout(page);
    assert.equal(await drawer(page).getAttribute("data-side"), "left");
    assert.equal(layout.left, 0, "drawer starts at the left edge");
    assert.ok(layout.pageLeft >= layout.right, `admin page starts at ${layout.pageLeft}px, drawer ends at ${layout.right}px`);
    assert.ok(layout.overflow <= 0, `page scrolls ${layout.overflow}px sideways`);
    await shot(page, "left-side-1440");
    return `drawer 0..${layout.right} px, page from ${layout.pageLeft} px`;
  });
  await check("left-drag: dragging the right edge outward widens the left drawer and inward narrows it", async () => {
    const start = (await drawerLayout(page)).width;
    const cols = (await drawerLayout(page)).cols;
    const during = await dragSeparator(page, 200);
    assert.equal(during.resizing, true);
    await waitColumns(page, cols);
    const wider = await drawerLayout(page);
    assert.equal(wider.width, start + 200);
    assert.ok(wider.pageLeft >= wider.right);
    await dragSeparator(page, -300);
    const narrower = await drawerLayout(page);
    assert.equal(narrower.width, start - 100);
    assert.equal(narrower.selected, "");
    assert.equal(narrower.termSelected, false);
    await dragSeparator(page, 2000);
    assert.equal((await drawerLayout(page)).width, DESKTOP.width - 400);
    return `${start} -> ${wider.width} -> ${narrower.width} px, stops at ${DESKTOP.width - 400} px`;
  });
  await check("left-keyboard: ArrowRight widens, ArrowLeft narrows, Home and End jump to the bounds", async () => {
    await separator(page).focus();
    await page.keyboard.press("Home");
    const widths = [(await drawerLayout(page)).width];
    for (const key of ["ArrowRight", "Shift+ArrowRight", "ArrowLeft", "End", "Shift+ArrowLeft"]) {
      await page.keyboard.press(key);
      widths.push((await drawerLayout(page)).width);
    }
    assert.deepEqual(widths, [360, 376, 456, 440, 1040, 960]);
    return widths.join(" -> ") + " px";
  });
  await check("left-live-terminal: Ghostty and the PTY follow wide and narrow widths in the same left-hand session", async () => {
    await page.waitForTimeout(500); // the last key's refit lands on the next animation frame
    const columns = [await ptyColumns(page, "left-wide")];
    await page.setViewportSize({ width: 960, height: 800 });
    await waitColumns(page, columns[0]);
    const narrow = await drawerLayout(page);
    assert.equal(narrow.width, 560);
    assert.ok(narrow.pageLeft >= narrow.right);
    columns.push(await ptyColumns(page, "left-narrow"));
    await shot(page, "left-side-960");
    await page.setViewportSize({ width: 700, height: 800 });
    await page.waitForTimeout(300);
    assert.equal((await drawerLayout(page)).width, 700);
    assert.equal(await separator(page).isVisible(), false);
    await page.setViewportSize(DESKTOP);
    const session = await page.evaluate(() => document.getElementById("admin-repl-drawer").adminRepl.session);
    assert.equal(session.id, live.id);
    await endSession(page);
    return `columns ${columns.join(" -> ")} in session ${live.id.slice(0, 8)}`;
  });
  await context.close();
}

async function phaseAfterRestart(browser) {
  const context = await newContext(browser, { storageState: `${STATE}/owner-state.json` });
  const page = await context.newPage();
  const { id } = JSON.parse(readFileSync(`${STATE}/restart-session.json`, "utf8"));
  await check("after a server restart the drawer says the old session is gone", async () => {
    await page.goto(`${BASE}/admin/`);
    await openDrawer(page);
    await waitState(page, "Not started");
    const notice = await noticeText(page);
    assert.match(notice, new RegExp(`Session ${id.slice(0, 8)} no longer exists on the server`));
    await shot(page, "owner-after-restart");
    return notice;
  });
  await context.close();
}

async function phaseIdle(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await login(page, accounts.owner);
  await openDrawer(page);
  await check("short idle limit expires an attached but silent session", async () => {
    const session = await startTypingAhead(page, "python", ">>>");
    await run(page, "kept = 5", null);
    await waitState(page, "Expired", 60000);
    assert.match(await noticeText(page), /No input for \d+ s; the idle limit ended the process\./);
    await shot(page, "owner-expired");
    const fresh = await startTypingAhead(page, "python", ">>>");
    assert.notEqual(fresh.pid, session.pid);
    await run(page, "kept", "NameError");
    await endSession(page);
    return `idle limit ${session.idle_timeout} s`;
  });
  await context.close();
}

const browser = await chromium.launch();
const browserVersion = browser.version();
let failure = null;
try {
  const phases = { cold: phaseCold, main: phaseMain, "after-restart": phaseAfterRestart, idle: phaseIdle, left: phaseLeft };
  await phases[PHASE](browser);
  const secrets = Object.values(accounts).map((account) => account.password);
  await check("no credential appears in browser console output or request URLs", async () => {
    const haystack = [...observed.console, ...observed.urls].join("\n");
    for (const secret of secrets) assert.equal(haystack.includes(secret), false);
    assert.equal(/sessionid=|password=|csrfmiddlewaretoken=/.test(haystack), false);
    return `${observed.console.length} console lines, ${observed.urls.length} requests`;
  });
} catch (error) {
  failure = error;
  console.error(`FAIL ${PHASE}: ${error.stack || error}`);
} finally {
  await browser.close();
  writeFileSync(
    `${ARTIFACTS}/${PHASE}-results.json`,
    JSON.stringify({ phase: PHASE, browser: browserVersion, passed, failed: failure ? String(failure) : null }, null, 2),
  );
}
console.log(`${PHASE}: ${passed.length} checks passed${failure ? ", 1 failed" : ""} (Chromium ${browserVersion})`);
process.exit(failure ? 1 : 0);
