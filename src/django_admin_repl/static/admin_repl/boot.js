try {
  const root = document.documentElement;
  if (document.currentScript?.dataset.side === "left") root.classList.add("admin-repl-left");
  if (sessionStorage.getItem("admin-repl:open") === "1") root.classList.add("admin-repl-docked");
  if (sessionStorage.getItem("admin-repl:wide") === "1") root.classList.add("admin-repl-wide");
  const width = Number(localStorage.getItem("admin-repl:width"));
  if (Number.isFinite(width) && width > 0) root.style.setProperty("--admin-repl-preferred", `${width}px`);
} catch {}
