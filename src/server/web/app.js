// The admin page: what is costing the user money (decision 0003: find, price, propose, act,
// verify), the proposals that would fix it, and the connections and comparisons behind it.
// Money arrives as decimal strings and is only ever handled as strings or BigInt cents; floats
// are used for bar widths and nothing else.
//
// The server's findings carry the numbers they were priced from (`inputs`). This page builds
// its own short headlines from those numbers, so what the user scans is "Chase Total Checking
// earns nothing" and "$352 a year", and the full detail sits one click away.

const ICONS = {
  logo: '<path d="M7 11.5a5 5 0 0 1 10 0z" fill="currentColor"/><path d="M3.5 12h17M7 16.5h10M10 21h4"/>',
  inbox:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  bank: '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="m12 2 8 5H4z"/>',
  card: '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>',
  wallet:
    '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  down: '<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
  up: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  tick: '<path d="M20 6 9 17l-5-5"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  sparkle:
    '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  pin: '<path d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  list: '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  target:
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  pie: '<path d="M21 12c.55 0 1-.45.95-1A10 10 0 0 0 13 2.05c-.55-.05-1 .4-1 .95v8a1 1 0 0 0 1 1z"/><path d="M21.2 15.9A10 10 0 1 1 8 2.83"/>',
  split:
    '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.17-2.87L3 3"/><path d="m15 9 6-6"/>',
  calendar:
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  grip: '<circle cx="9" cy="6" r=".6"/><circle cx="15" cy="6" r=".6"/><circle cx="9" cy="12" r=".6"/><circle cx="15" cy="12" r=".6"/><circle cx="9" cy="18" r=".6"/><circle cx="15" cy="18" r=".6"/>',
};

const CATEGORIES = {
  cash: { label: "Cash", icon: "wallet", view: "#cash" },
  card: { label: "Cards", icon: "card", view: "#cards" },
  debt: { label: "Debt", icon: "down", view: null },
  securities: { label: "Investments", icon: "up", view: "#investments" },
};

// Light unless the user switched to dark in the top bar; not the system setting.
const THEME_KEY = "tidysum-theme";

function savedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $("#theme");
  const label = theme === "dark" ? "Switch to light" : "Switch to dark";
  btn.replaceChildren(icon(theme === "dark" ? "sun" : "moon"));
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

const VIEWS = ["actions", "plan", "cash", "cards", "investments", "connections"];

// DOM ---------------------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

/** Icons are constant markup from ICONS; user data only ever goes in through textContent. */
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.9",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  svg.innerHTML = ICONS[name] || "";
  return svg;
}

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") {
      for (const [prop, val] of Object.entries(v))
        e.style.setProperty(
          prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
          String(val),
        );
    } else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid instanceof Node ? kid : String(kid));
  }
  return e;
}

/** replaceChildren that skips null and false, which replaceChildren would print as text. */
function fill(root, ...kids) {
  root.replaceChildren(
    ...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false),
  );
}

function extLink(text, href, cls = "ext") {
  if (!href) return null;
  return h("a", { class: cls, href, target: "_blank", rel: "noreferrer" }, text, icon("external"));
}

// Formatting --------------------------------------------------------------------------------

/** "1234.5" -> 123450n. Extra decimal places are cut, not rounded; the server sends two. */
function cents(s) {
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(String(s ?? "0").trim());
  if (!m) return 0n;
  const v = BigInt((m[2] || "0") + `${m[3] || ""}00`.slice(0, 2));
  return m[1] ? -v : v;
}

const asCents = (s) => (typeof s === "bigint" ? s : cents(s));
const groups = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "$9,257.43". */
function usd(s) {
  const c = asCents(s);
  const abs = c < 0n ? -c : c;
  return `${c < 0n ? "−" : ""}$${groups(abs / 100n)}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** "$9,257": whole dollars, rounded half up, for headlines and lists. Exact figures sit in the details. */
function usd0(s) {
  const c = asCents(s);
  const abs = c < 0n ? -c : c;
  const dollars = (abs + 50n) / 100n;
  if (abs > 0n && dollars === 0n) return `${c < 0n ? "−" : ""}<$1`;
  return `${c < 0n ? "−" : ""}$${groups(dollars)}`;
}

/** "0.188" as "18.8", for a fraction shown as a percent (not money). */
function fractionPct(s) {
  return String(Math.round(Number(s ?? 0) * 1000) / 10);
}

/** "3.80%" from "3.80"; "0%" for zero. */
function pct(s) {
  const t = String(s ?? "0");
  return /^0*(\.0*)?$/.test(t) ? "0%" : `${t}%`;
}

/** Card reward rates: "2.00" -> "2%", "1.50" -> "1.5%". */
function rate(s) {
  const t = String(s ?? "0");
  return `${t.includes(".") ? t.replace(/\.?0+$/, "") : t}%`;
}

/**
 * "2% on everything" instead of the same 2% listed per category: a flat rate on everything
 * else swallows the categories that earn no more than it.
 */
function earnsSummary(list) {
  const flat = list.find((e) => /^everything/i.test(e.category));
  const flatBp = flat ? cents(flat.percent) : -1n;
  return [
    flat ? `${rate(flat.percent)} on everything` : null,
    ...list
      .filter((e) => e !== flat && cents(e.percent) > flatBp)
      .map((e) => `${rate(e.percent)} on ${String(e.category).toLowerCase()}`),
  ].filter(Boolean);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

/** Date-only strings are calendar days, not UTC midnights. */
function toDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
}

function day(s) {
  if (!s) return "";
  return toDate(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function dayShort(s) {
  if (!s) return "";
  const d = toDate(s);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function ago(s) {
  if (!s) return "never";
  const secs = (Date.now() - new Date(s).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ]) {
    if (Math.abs(secs) >= size) return rtf.format(-Math.round(secs / size), unit);
  }
  return "just now";
}

// Banks report names like "TOTAL CHECKING" and "Ultimate Rewards®". People don't.
const ACRONYMS = new Set([
  "USAA",
  "HSA",
  "FSA",
  "IRA",
  "CD",
  "ATM",
  "US",
  "USD",
  "PNC",
  "TD",
  "BMO",
]);

const titleCase = (t) =>
  t
    .toLowerCase()
    .replace(/[a-z0-9]+/g, (w) =>
      ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
    );

/** "TOTAL CHECKING" -> "Total Checking", also inside mixed text ("Chase TOTAL CHECKING"). */
function tidyName(s) {
  const t = String(s ?? "")
    .replace(/[®™©]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[a-z]/.test(t)) return titleCase(t);
  return t.replace(/\b[A-Z][A-Z0-9]+(?: [A-Z][A-Z0-9]+)*\b/g, (run) =>
    run.length >= 5 && !ACRONYMS.has(run) ? titleCase(run) : run,
  );
}

/**
 * Some banks name accounts "Owner Name - Cash Plus Account - ****2572". Keep the product part:
 * mask-only parts go, and of the rest the last part is the account's own name.
 */
function shortAccountName(s) {
  const parts = String(s ?? "")
    .split(/\s+-\s+/)
    .filter((p) => !/^[*x•]+\d*$/i.test(p.trim()));
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
}

/** "Chase Total Checking": the institution, unless the account's name already says it. */
function accountLabel(name, institution) {
  const n = tidyName(shortAccountName(name)) || "Account";
  // "Principal Financial Group - Participant Logon": the login page's name isn't the bank's.
  const inst = tidyName(String(institution ?? "").split(/\s+-\s+/)[0]);
  if (!inst || n.toLowerCase().includes(inst.toLowerCase().split(" ")[0])) return n;
  return `${inst} ${n}`;
}

/** Bare decimals in server prose become dollars ("9257.43" -> "$9,257.43"), ISO dates become days. */
function prose(s) {
  return String(s ?? "")
    .replace(/[®™]/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|[^\d$.,])(\d+\.\d{2})(?![\d%])/g, (_, pre, n) => `${pre}${usd(n)}`)
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (_, d) => day(d))
    .replace(/\b[A-Z][A-Z0-9]+(?: [A-Z][A-Z0-9]+)+\b/g, (run) => titleCase(run));
}

/** A stable, pleasant hue per name, for avatars and card swatches. */
const HUES = [158, 200, 265, 330, 185, 20, 140, 290, 225];
// Roughly each issuer's own colour, so a card looks like its bank.
const BRAND_HUES = [
  [/chase|sapphire|freedom|prime visa/i, 214],
  [/capital one|venture|savor|quicksilver/i, 350],
  [/citi/i, 202],
  [/amex|american express/i, 208],
  [/wealthfront/i, 262],
  [/fidelity/i, 140],
  [/ally/i, 290],
  [/sofi/i, 190],
  [/apple/i, 220],
  [/discover/i, 25],
];
function hue(text) {
  const brand = BRAND_HUES.find(([re]) => re.test(String(text)));
  if (brand) return brand[1];
  let x = 0;
  for (const ch of String(text)) x = (x * 31 + ch.codePointAt(0)) % 997;
  return HUES[x % HUES.length];
}

function initials(name) {
  const words = String(name)
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase();
}

// Feedback ----------------------------------------------------------------------------------

function toast(message, kind = "info") {
  const el = h(
    "div",
    { class: `toast is-${kind}`, role: kind === "error" ? "alert" : "status" },
    icon(kind === "error" ? "error" : kind === "ok" ? "check" : "info"),
    h("div", null, message),
  );
  $("#toasts").append(el);
  setTimeout(
    () => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 220);
    },
    kind === "error" ? 9000 : 4000,
  );
}

function confirmDialog(title, body, okLabel, tone = "danger") {
  const dialog = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-ok").textContent = okLabel;
  $("#confirm-ok").className = `btn btn-${tone}`;
  return new Promise((resolve) => {
    const done = (answer) => {
      if (dialog.open) dialog.close();
      resolve(answer);
    };
    $("#confirm-ok").onclick = () => done(true);
    $("#confirm-cancel").onclick = () => done(false);
    dialog.oncancel = () => resolve(false);
    dialog.showModal();
  });
}

/** Runs a button's action with the button disabled, then reloads what it changed. */
async function act(button, fn, okMessage, reload) {
  button.disabled = true;
  try {
    await fn();
    if (okMessage) toast(okMessage, "ok");
    await load(...reload);
  } catch (e) {
    toast(e.message, "error");
    button.disabled = false;
  }
}

/** Server errors arrive as "invalid body (400)"; people get a sentence. */
function friendly(e) {
  // The demo refuses what would touch real accounts, and says why.
  if (e.status === 403 && data.items?.demo) return e.message;
  if (e.status === 401 || e.status === 403) return "Your session ended. Reload the page.";
  if (e.status >= 500) return "Something went wrong on the server. Try again in a moment.";
  if (e.status === undefined) return "Couldn't reach Tidysum. Is it still running?";
  return e.message;
}

// Data --------------------------------------------------------------------------------------

async function api(path, body) {
  let res;
  try {
    res = await fetch(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  } catch {
    throw new Error("Couldn't reach Tidysum. Is it still running?");
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const err = new Error(detail?.error || `${path}: ${res.status}`);
    err.status = res.status;
    err.message = friendly(err);
    throw err;
  }
  return res.json();
}

const SOURCES = {
  items: "/api/items",
  proposals: "/api/proposals",
  actions: "/api/actions",
  mis: "/api/misallocations",
  products: "/api/products",
  cashHistory: "/api/cash-history",
  cards: "/api/cards",
  allocation: "/api/allocation",
  research: "/api/research",
  plan: "/api/plan",
  styles: () => `/api/styles${styleAge ? `?age=${styleAge}` : ""}`,
  activity: "/api/activity",
};

/** The age typed for a style whose mix depends on it, so what it would change can be shown. */
let styleAge = null;

/** Latest response per source; { error, status } when it failed, undefined while loading. */
const data = {};

async function load(...keys) {
  await Promise.all(
    keys.map(async (k) => {
      try {
        const src = SOURCES[k];
        data[k] = await api(typeof src === "function" ? src() : src);
      } catch (e) {
        data[k] = { error: e.message, status: e.status };
      }
    }),
  );
  render();
}

const ALL = Object.keys(SOURCES);
const ok = (k) => (data[k] && !data[k].error ? data[k] : null);

// Per-browser memory of cards the user said aren't in the catalog. A convenience only: losing it
// just brings the question back.
const NOT_LISTED_KEY = "tidysum.cardsNotListed";
function notListed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(NOT_LISTED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function setNotListed(accountId, on) {
  const s = notListed();
  if (on) s.add(accountId);
  else s.delete(accountId);
  try {
    localStorage.setItem(NOT_LISTED_KEY, JSON.stringify([...s]));
  } catch {
    // Private windows can refuse storage; the question just stays.
  }
}

// Plaid Link --------------------------------------------------------------------------------

async function openLink(itemId) {
  if (typeof Plaid === "undefined")
    throw new Error("Plaid Link didn't load. Check your connection.");
  const { linkToken, multi } = await api("/api/link-token", itemId ? { itemId } : {});
  let saved = false;
  // Multi-Item Link: the user adds several institutions in one session; Link hands off once at
  // the end and the server fetches every Item the session added.
  const saveSession = async () => {
    if (saved) return;
    saved = true;
    toast("Saving your connections…");
    const { itemIds, errors } = await api("/api/link-sessions", { linkToken });
    if (itemIds.length) {
      toast(`Linked ${plural(itemIds.length, "institution")}. Syncing in the background.`, "ok");
    } else if (errors.length) toast(`Couldn't save: ${errors.join("; ")}`, "error");
    else toast("Nothing was linked.");
    await load(...ALL);
  };
  const handler = Plaid.create({
    token: linkToken,
    onEvent: (eventName) => {
      if (multi && eventName === "HANDOFF") saveSession().catch((e) => toast(e.message, "error"));
    },
    onSuccess: async (publicToken) => {
      try {
        if (multi && !itemId) return await saveSession();
        toast("Saving…");
        if (itemId) await api(`/api/items/${itemId}/repaired`, {});
        else await api("/api/items", { publicToken });
        toast(
          itemId ? "Fixed. Syncing in the background." : "Linked. Syncing in the background.",
          "ok",
        );
        await load(...ALL);
      } catch (e) {
        toast(e.message, "error");
      }
    },
    onExit: (err) => {
      if (err) toast(`Link closed: ${err.display_message || err.error_code}`, "error");
    },
  });
  handler.open();
}

function startLink(button, itemId) {
  button.disabled = true;
  openLink(itemId)
    .catch((e) => toast(e.message, "error"))
    .finally(() => {
      button.disabled = false;
    });
}

function linkButton(label, opts = {}) {
  return h(
    "button",
    {
      class: `btn ${opts.primary === false ? "" : "btn-primary"} ${opts.small ? "btn-sm" : ""}`,
      type: "button",
      onclick: (ev) => startLink(ev.currentTarget, opts.itemId),
    },
    opts.itemId ? icon("refresh") : icon("plus"),
    label,
  );
}

/** Empty states elsewhere point to Connections, where linking lives, instead of a second button. */
const toConnections = (text) => [
  text,
  " ",
  h("a", { class: "inline-link", href: "#connections" }, "Go to Connections"),
];

// Shared pieces -----------------------------------------------------------------------------

function skeleton(rows = 3) {
  return h(
    "div",
    { "aria-busy": "true", "aria-label": "Loading" },
    h("div", { class: "skeleton skel-hero" }),
    Array.from({ length: rows }, () => h("div", { class: "skeleton skel-row" })),
  );
}

function empty(iconName, title, text, action, good) {
  return h(
    "div",
    { class: `empty ${good ? "is-good" : ""}` },
    h("div", { class: "empty-icon" }, icon(iconName)),
    h("h3", null, title),
    text ? h("p", null, text) : null,
    action || null,
  );
}

function failed(what, d) {
  if (d.status === 404) {
    return empty("info", `${what} isn't set up`, "This server has no catalog configured for it.");
  }
  return empty(
    "alert",
    `Couldn't load ${what.toLowerCase()}`,
    d.error,
    h(
      "button",
      { class: "btn", type: "button", onclick: () => load(...ALL) },
      icon("refresh"),
      "Try again",
    ),
  );
}

function notice(kind, text, end) {
  return h(
    "div",
    { class: `notice notice-${kind}` },
    icon(kind === "info" ? "info" : "alert"),
    h("div", { class: "notice-text" }, text),
    end || null,
  );
}

function sectionHead(title, hint) {
  return h(
    "div",
    { class: "section-head" },
    h("h2", null, title),
    hint ? h("span", { class: "hint" }, hint) : null,
  );
}

/** Expandable blocks keep their state across re-renders. */
const openFolds = new Set();
function fold(key, summary, ...content) {
  const d = h(
    "details",
    { class: "fold", open: openFolds.has(key) },
    h("summary", null, icon("chevron"), summary),
    h("div", { class: "fold-body" }, ...content),
  );
  d.addEventListener("toggle", () => {
    if (d.open) openFolds.add(key);
    else openFolds.delete(key);
  });
  return d;
}

function bullets(list) {
  return list.length
    ? h(
        "ul",
        { class: "bullets" },
        list.map((x) => h("li", null, prose(x))),
      )
    : null;
}

/** Quiet footer: how numbers are worked out and heads-ups. The disclosure is in the page footer. */
function fineprint({ notes = [], assumptions = [], notCovered = [] }) {
  if (!notes.length && !assumptions.length && !notCovered.length) return null;
  return h(
    "footer",
    { class: "fineprint" },
    notes.length
      ? fold(`notes-${location.hash}`, `Worth knowing (${notes.length})`, bullets(notes))
      : null,
    assumptions.length
      ? fold(
          `assumptions-${location.hash}`,
          "How these numbers are worked out",
          bullets(assumptions),
        )
      : null,
    notCovered.length
      ? fold("not-covered", "What Tidysum doesn't check yet", bullets(notCovered))
      : null,
  );
}

function stat(label, value, tone, sub) {
  return h(
    "div",
    { class: "stat" },
    h("div", { class: "stat-label" }, label),
    h("div", { class: `stat-value num ${tone || ""}` }, value),
    sub ? h("div", { class: "stat-sub" }, sub) : null,
  );
}

function fact(label, value, tone) {
  return h(
    "div",
    { class: "fact" },
    h("dt", null, label),
    h("dd", { class: `num ${tone || ""}` }, value),
  );
}

/**
 * Plaid or the bank failing on their side (a server error, the bank not answering). Tidysum
 * tries again by itself, so it only asks the owner once it has gone on for days.
 */
const RETRY_GRACE_MS = 3 * 86_400_000;
const isRetrying = (it) =>
  it.status === "error" &&
  !!it.lastSyncedAt &&
  Date.now() - new Date(it.lastSyncedAt).getTime() < RETRY_GRACE_MS;
const needsAttention = (it) => it.status !== "active" && !isRetrying(it);

/** Warnings this page turns into inline fixes, so they aren't also shown as text. */
const isCardQuestion = (w) => /doesn't say which card it is/.test(w);
const isConnectionStale = (w) => /is out of date \(/.test(w);
const isInterestWarning = (w) => /charged .* in interest in the last year/.test(w);

const NOT_COVERED_LABELS = [
  [/^securities:\s*/i, "Investments: "],
  [/^debt:\s*/i, "Debt: "],
  [/priced by deposit_rate,/, "priced by the cash comparison,"],
];
const tidyNotCovered = (s) => NOT_COVERED_LABELS.reduce((t, [re, to]) => t.replace(re, to), s);

// Findings ----------------------------------------------------------------------------------

function cashAccount(id) {
  return ok("products")?.accounts.find((a) => a.account_id === id) || null;
}

function heldCard(id) {
  return ok("cards")?.held_cards.find((c) => c.account_id === id) || null;
}

/** The product's own name, without a provider prefix that repeats it. */
function productName(provider, name) {
  const p = tidyName(provider).split(" ")[0];
  return name.toLowerCase().startsWith(p.toLowerCase()) ? name : `${tidyName(provider)} ${name}`;
}

/**
 * What the user sees for one finding: a short headline, one line of why, the numbers behind it,
 * what to do, and where to go next. Built from the finding's inputs, with the server's prose as
 * the fallback for any detector this page doesn't know.
 */
function describe(m) {
  const i = m.inputs || {};
  const base = {
    title: prose(m.summary),
    sub: prose(m.action),
    facts: [],
    detail: null,
    notes: [],
    todo: null,
    primary: null,
    secondary: null,
  };

  if (m.detector === "deposit_rate" && i.alternative) {
    const acct = cashAccount(m.account_ids[0]);
    const fromSummary = /^(.*?)(?: at (.*?))? earns /.exec(m.summary || "");
    const name = accountLabel(
      acct?.account_name ?? fromSummary?.[1] ?? "Your account",
      acct?.institution_name ?? fromSummary?.[2],
    );
    const alt = i.alternative;
    const altName = productName(alt.provider, acct?.alternatives?.[0]?.name ?? alt.provider);
    const nowApy = i.current?.effective_apy ?? "0";
    const earnsNothing = cents(nowApy) === 0n;
    return {
      ...base,
      title: earnsNothing ? `${name} earns nothing` : `${name} earns only ${pct(nowApy)}`,
      sub: `${altName} pays ${pct(alt.apy)} on the same ${usd0(i.balance)}.`,
      notes: [
        alt.requires
          ? `${pct(alt.apy)} needs: ${alt.requires}. Without that, it's +${usd(alt.annual_gain_without_conditions)} a year.`
          : null,
        alt.stale
          ? `This rate was last checked ${day(alt.verified_on)}. Confirm it before you move money.`
          : null,
        i.balance_basis ? `Balance is the ${i.balance_basis}.` : null,
      ],
      todo: `Open a ${altName} and move the cash you don't need day to day.`,
      primary: { label: "Compare accounts", href: "#cash" },
      secondary: { label: `${tidyName(alt.provider).split(" ")[0]} rates`, href: alt.source_url },
    };
  }

  if (m.detector === "card_wallet") {
    const name = /^Adding (.*) would earn/.exec(m.summary || "")?.[1] || "this card";
    const fee =
      i.annual_fee && cents(i.annual_fee) !== 0n
        ? `${usd0(i.annual_fee)} annual fee`
        : "No annual fee";
    return {
      ...base,
      title: `Get the ${name}`,
      sub: [...earnsSummary(i.earns_on || []).slice(0, 2), fee].join(" · "),
      notes: [
        i.requires ? `Needs ${i.requires.replace(/^[A-Z]/, (c) => c.toLowerCase())}.` : null,
        i.verified_on ? `Terms checked ${day(i.verified_on)}.` : null,
      ],
      todo: `Apply for the ${name}, then use it where it beats your other cards.`,
      primary: i.source_url ? { label: "See the card", href: i.source_url, external: true } : null,
      secondary: { label: "Compare cards", href: "#cards" },
    };
  }

  if (m.detector === "card_usage") {
    const from = i.from_bank_card_payable;
    return {
      ...base,
      title: "Pay bills with a card, not your bank",
      sub: `${usd0(from)} you paid from your bank last year could have earned rewards.`,
      detail: i.payees?.length ? payeeList(i.payees) : null,
      facts: [
        i.rewards ? fact("Rewards now", `${usd(i.rewards.current)}/yr`) : null,
        i.rewards
          ? fact("On your best card", `${usd(i.rewards.with_bank_spending_on_cards)}/yr`, "gain")
          : null,
      ],
      todo: "Move those bills and purchases to your best card, then pay the card in full each month.",
      primary: { label: "See where you spend", href: "#cards" },
    };
  }

  if (m.detector === "foreign_fees") {
    const card = heldCard(m.account_ids[0]);
    const raw = card?.account_name ?? /^(.*) charged /.exec(m.summary || "")?.[1] ?? "A card";
    const name = accountLabel(raw, card?.institution_name);
    return {
      ...base,
      title: "Stop paying foreign transaction fees",
      sub: `Charged on ${name} last year.`,
      todo: "Use a card with no foreign transaction fee abroad and on sites that charge in other currencies.",
      primary: { label: "Compare cards", href: "#cards" },
    };
  }

  if (m.detector === "card_statement") {
    return {
      ...base,
      title: "Pay your card statement in full",
      sub: prose(m.summary),
      todo: prose(m.action),
    };
  }

  if (m.detector === "retirement_rate" && i.new_percent) {
    const plan = i.plan_name || "your 401(k)";
    const raise = i.kind === "raise";
    return {
      ...base,
      title: raise
        ? `Raise ${plan} to ${i.new_percent}%`
        : `Lower ${plan} to ${i.new_percent}% for ${i.year}`,
      sub: raise
        ? `${i.current_percent}% falls short of the ${i.year} limit. Pre-tax money saves tax only in its own year.`
        : `At ${i.current_percent}%, the ${i.year} limit comes ${i.unmatched} paychecks early and those get no match.`,
      notes: [
        i.limit_official === false
          ? `The ${i.year} limit is the expected one; the IRS hasn't announced it yet.`
          : null,
        i.facts_as_of ? `From your plan's site on ${day(i.facts_as_of)}.` : null,
      ],
      todo: prose(m.action),
      primary: { label: "Your plan", href: "#plan" },
    };
  }

  if (m.detector === "fund_fee" && i.fund) {
    return {
      ...base,
      title: `Swap ${i.fund} for index funds`,
      sub: `${pct(i.expense_ratio)} a year against ${pct(Number(i.alternative_expense_ratio).toFixed(2))} for a copy of what it holds. Tax-free inside the plan.`,
      detail: i.copy?.length ? copyTable(i.copy, "Fund holds") : null,
      notes: [
        i.mix_source && i.mix_as_of
          ? `What it holds is from ${i.mix_source}, ${day(i.mix_as_of)}.`
          : null,
        i.fund_kind === "target_date"
          ? "The copy won't shift toward bonds by itself the way the fund does; new money does that, by your plan."
          : null,
        i.facts_as_of ? `Fees from your plan's site on ${day(i.facts_as_of)}.` : null,
      ],
      todo: prose(m.action),
      primary: { label: "Investments", href: "#investments" },
    };
  }

  if (m.detector === "brokerage_window" && i.into) {
    const plan = i.plan_name || "your 401(k)";
    const at = i.window_account?.institution ? ` at ${i.window_account.institution}` : "";
    return {
      ...base,
      title: `Move ${plan}'s brokerage window back into the plan`,
      sub: `${i.stays?.length ? "Nothing to buy there by hand" : "One account fewer, and nothing to buy there by hand"}${at}. Tax-free inside the plan, ${i.matches ? `matching ${i.matches} like your paychecks` : "a copy of what it holds"}.`,
      detail: i.copy?.length
        ? copyTable(i.copy, "Window holds", i.matches ? "Sold: goes into the split" : undefined)
        : null,
      notes: [
        `Its funds cost ${pct(Number(i.expense_ratio).toFixed(2))} a year against ${pct(Number(i.alternative_expense_ratio).toFixed(2))} in the plan's index funds.`,
        ...(i.matches
          ? [
              `As you chose, the money goes in the same split as your paychecks, a copy of ${i.matches}. That changes the mix from what the window holds.`,
            ]
          : []),
        ...(i.stays || []).map(
          (x) =>
            `${x.name} stays in the window: the plan has no fund holding only ${x.missing.join(" and ")}.`,
        ),
        ...(i.spread || []).map(
          (x) =>
            `${x.name} is sold too, as you chose: the plan has no fund holding only ${x.missing.join(" and ")}, so its money is split like the rest.`,
        ),
      ],
      todo: prose(m.action),
      primary: { label: "Investments", href: "#investments" },
    };
  }

  if (m.detector === "roth_ira" && i.tax_year) {
    const convert = i.kind === "convert";
    const backdoor = i.route !== "direct";
    return {
      ...base,
      title: convert
        ? `Convert your traditional IRA to Roth`
        : backdoor
          ? `Do your ${i.tax_year} backdoor Roth`
          : `Fill your ${i.tax_year} Roth IRA`,
      sub: convert
        ? "Until it's converted its growth is taxed, and pre-tax money there on December 31 makes the conversion taxable."
        : `${usd0(i.amount)} of room closes ${day(i.deadline)}. Money there grows tax-free for good.`,
      notes: [
        `Priced as the tax its growth would pay in a taxable account (${pct(fractionPct(i.expected_return))} a year at ${pct(fractionPct(i.gains_tax_rate))} tax)${i.match && !convert ? ", plus the match" : ""}. The room never comes back.`,
        i.match && !convert
          ? `${i.match.membership ?? i.match.provider}'s ${pct(fractionPct(i.match.rate))} match adds ${usd0(i.match.amount)}${cents(i.match.conversion_tax) > 0n ? `, less ${usd0(i.match.conversion_tax)} tax on converting it` : ""}${cents(i.match.membership_fee) > 0n ? ` and ${usd0(i.match.membership_fee)} for a year of ${i.match.membership}` : ""}: ${usd0(i.match.net)}. Taking the money out of ${i.match.provider} within ${i.match.hold_years} years charges the match back.`
          : null,
        i.limit_official === false
          ? `The ${i.tax_year} limit is the expected one; the IRS hasn't announced it yet.`
          : null,
        i.recorded
          ? null
          : `Nothing is recorded for ${i.tax_year} yet, so your agent checks first.`,
      ],
      todo: prose(m.action),
      primary: { label: "Your plan", href: "#plan" },
    };
  }

  if (m.detector === "extra_payment") {
    return {
      ...base,
      title: "Pay down your priciest debt",
      sub: prose(m.summary),
      todo: prose(m.action),
    };
  }

  return base;
}

function dismissButton(m, dismissed) {
  if (!m.id) return null;
  return h(
    "button",
    {
      class: "btn btn-quiet btn-sm",
      type: "button",
      onclick: (ev) =>
        act(
          ev.currentTarget,
          () => api(`/api/misallocations/${m.id}/${dismissed ? "undismiss" : "dismiss"}`, {}),
          dismissed ? "Back on your list." : "Dismissed. It no longer counts toward your total.",
          ["mis"],
        ),
    },
    dismissed ? "Restore" : "Not for me",
  );
}

function actionLink(a, cls) {
  if (!a) return null;
  if (a.external) {
    return h(
      "a",
      { class: cls, href: a.href, target: "_blank", rel: "noreferrer" },
      a.label,
      icon("external"),
    );
  }
  return h(
    "a",
    { class: cls, href: a.href },
    a.label,
    cls.includes("btn-primary") ? icon("arrow") : null,
  );
}

/** One expandable row in the fixes list: a headline and a yearly figure, details on click. */
function fixRow({
  key,
  category,
  title,
  tag,
  sub,
  amount,
  amountNote,
  dismissed,
  gain,
  body,
  progress,
}) {
  const cat = CATEGORIES[category] || { label: category, icon: "info" };
  const open = openFolds.has(key);
  const article = h(
    "article",
    {
      class: `finding cat-${category} ${dismissed ? "is-dismissed" : ""} ${gain ? "is-gain" : ""} ${open ? "is-open" : ""}`,
    },
    h(
      "button",
      {
        class: "finding-head",
        type: "button",
        "aria-expanded": String(open),
        "aria-controls": `${key}-body`,
        onclick: () => {
          const now = !article.classList.contains("is-open");
          article.classList.toggle("is-open", now);
          article.querySelector(".finding-head").setAttribute("aria-expanded", String(now));
          if (now) openFolds.add(key);
          else openFolds.delete(key);
        },
      },
      h("span", { class: "cat-icon", title: cat.label }, icon(cat.icon)),
      h(
        "span",
        { class: "finding-text" },
        h("span", { class: "finding-title" }, title, tag || null),
        sub ? h("span", { class: "finding-sub" }, sub) : null,
      ),
      h(
        "span",
        { class: "finding-cost" },
        amount ? h("span", { class: "num" }, amount) : null,
        h("small", null, amountNote),
      ),
      h("span", { class: "chev" }, icon("chevron")),
    ),
    progress !== null && progress !== undefined
      ? h(
          "span",
          { class: "finding-progress", "aria-hidden": "true" },
          h("i", { style: { width: `${Math.round(progress * 100)}%` } }),
        )
      : null,
    h(
      "div",
      { class: "finding-body", id: `${key}-body`, role: "region" },
      h("div", { class: "finding-inner" }, body),
    ),
  );
  return article;
}

/** The bank payments behind a card_usage finding: who, how much, how often. */
/**
 * A swap side by side (decision 0007): what the fund holds, sleeve by sleeve, and the plan fund
 * and whole percent the copy puts in each.
 */
function copyTable(rows, holdsLabel, soldNote = "No plan fund holds this: split like the rest") {
  return h(
    "div",
    { class: "copy" },
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "Sleeve"),
          h("th", { class: "num" }, holdsLabel),
          h("th", { class: "num" }, "Copy"),
        ),
      ),
      h(
        "tbody",
        null,
        rows.map((r) =>
          h(
            "tr",
            null,
            h(
              "td",
              null,
              h("span", { class: "payee-name" }, r.label),
              h("small", null, r.spread ? soldNote : r.fund),
            ),
            h("td", { class: "num" }, `${r.holds}%`),
            h("td", { class: "num" }, r.spread ? "–" : `${r.percent}%`),
          ),
        ),
      ),
    ),
  );
}

function payeeList(payees) {
  return h(
    "div",
    { class: "payees" },
    h("span", { class: "todo-label" }, "Paid from your bank"),
    h(
      "ul",
      null,
      payees.map((p) =>
        h(
          "li",
          null,
          h(
            "div",
            null,
            h("span", { class: "payee-name" }, p.payee),
            h(
              "small",
              null,
              [
                p.categories?.[0] === "Everything else" ? null : p.categories?.[0],
                `${p.payments} ${p.payments === 1 ? "payment" : "payments"}`,
                p.last_date ? `last ${dayShort(p.last_date)}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          ),
          h("span", { class: "num" }, usd0(p.amount)),
        ),
      ),
    ),
  );
}

function findingRow(m) {
  const dismissed = m.state === "dismissed";
  const d = describe(m);
  return fixRow({
    key: `finding-${m.key}`,
    category: m.category,
    title: d.title,
    tag: m.state === "new" ? h("span", { class: "tag-new" }, "New") : null,
    sub: d.sub,
    amount: usd0(m.annual_cost),
    amountNote: dismissed ? "not counted" : "a year",
    dismissed,
    body: [
      d.facts.filter(Boolean).length ? h("dl", { class: "facts" }, d.facts) : null,
      d.detail,
      d.todo
        ? h("div", { class: "todo" }, h("span", { class: "todo-label" }, "What to do"), d.todo)
        : null,
      d.notes.filter(Boolean).length
        ? h(
            "ul",
            { class: "finding-notes" },
            d.notes.filter(Boolean).map((n) => h("li", null, n)),
          )
        : null,
      h(
        "div",
        { class: "finding-actions" },
        dismissed ? null : actionLink(d.primary, "btn btn-primary btn-sm"),
        dismissed ? null : actionLink(d.secondary, "btn btn-sm"),
        h("span", { class: "spacer" }),
        m.first_seen_at
          ? h("span", { class: "seen" }, `Spotted ${dayShort(m.first_seen_at)}`)
          : null,
        dismissButton(m, dismissed),
      ),
    ],
  });
}

// Cards: which catalog card each linked card is ------------------------------------------------

function cardOptions(card, all) {
  // A debit card (PayPal Debit) can only be a bank or wallet account, and a credit card only a
  // credit account.
  const catalog = all.filter((k) => (k.kind || "credit") === (card.kind || "credit"));
  const inst = tidyName(card.institution_name).toLowerCase();
  const first = inst.split(" ")[0];
  const fromIssuer = (k) =>
    !!first &&
    (String(k.issuer || "")
      .toLowerCase()
      .includes(first) ||
      k.name.toLowerCase().startsWith(first));
  const mine = catalog.filter(fromIssuer);
  const others = catalog.filter((k) => !fromIssuer(k));
  const skipped = !card.card_id && notListed().has(card.account_id);
  const opt = (k) => h("option", { value: k.id, selected: k.id === card.card_id }, k.name);
  return [
    h("option", { value: "", selected: !card.card_id && !skipped }, "Pick the card…"),
    mine.length
      ? h("optgroup", { label: `${tidyName(card.institution_name)} cards` }, mine.map(opt))
      : null,
    h("optgroup", { label: mine.length ? "Other cards" : "Cards Tidysum knows" }, others.map(opt)),
    h(
      "optgroup",
      { label: "Not there?" },
      h("option", { value: NOT_LISTED, selected: skipped }, "It's not on this list"),
    ),
  ];
}

const NOT_LISTED = "__none";

/**
 * Saves which card an account is. "Not on this list" also clears any card picked before, so a
 * wrong pick can be undone; the server then falls back to the bank's name, or to 1% back.
 */
async function saveCardChoice(card, value, catalog) {
  const notOnList = value === NOT_LISTED;
  await api(`/api/cards/${card.account_id}`, { cardId: notOnList || !value ? null : value });
  setNotListed(card.account_id, notOnList);
  await load("cards", "mis");
  const now = ok("cards")?.held_cards.find((c) => c.account_id === card.account_id);
  const picked = catalog.find((k) => k.id === value);
  if (picked) return `Saved as ${picked.name}. Your numbers are updated.`;
  if (now?.card_id) return `Tidysum recognizes it as ${now.card_name} from the bank's name.`;
  return notOnList
    ? "Got it. Tidysum counts it as 1% back until it knows that card."
    : "Cleared. Tidysum counts it as 1% back until you pick one.";
}

function cardPicker(card, catalog, opts = {}) {
  return h(
    "select",
    {
      class: `select ${opts.compact ? "select-sm" : ""}`,
      "aria-label": `Which card is ${accountLabel(card.account_name, card.institution_name)}?`,
      onchange: async (ev) => {
        const s = ev.currentTarget;
        s.disabled = true;
        try {
          toast(await saveCardChoice(card, s.value, catalog), "ok");
        } catch (e) {
          toast(e.message, "error");
          s.disabled = false;
        }
      },
    },
    cardOptions(card, catalog),
  );
}

const reportedName = (card) => tidyName(card.card_name.replace(/ \(unidentified.*$/, ""));

/**
 * Questions only the user can answer. The Actions page lists them, and each one links to the single
 * place it's answered (the card picker on Cards, Reconnect on Connections), so there is one way
 * to do each thing.
 */
function needsYouRow(href, art, title, sub, cta, warn) {
  return h(
    "a",
    { class: `task ${warn ? "task-warn" : ""}`, href },
    art,
    h(
      "span",
      { class: "task-text" },
      h("span", { class: "task-title" }, title),
      h("span", { class: "task-sub" }, sub),
    ),
    h("span", { class: "task-cta" }, cta, icon("arrow")),
  );
}

function needsYou() {
  const items = ok("items")?.items || [];
  const cards = ok("cards");
  const skip = notListed();
  const unknown = cards
    ? cards.held_cards.filter((c) => c.identified_by === "assumed" && !skip.has(c.account_id))
    : [];
  const rows = [
    ...items.filter(needsAttention).map((it) => {
      const name = institutionName(it.institutionName) || "A connection";
      return needsYouRow(
        "#connections",
        h("span", { class: "avatar", style: { "--hue": hue(name) } }, initials(name)),
        it.status === "relink_required" ? `Reconnect ${name}` : `${name} isn't syncing`,
        `Last synced ${ago(it.lastSyncedAt)}`,
        "Fix",
        true,
      );
    }),
    ...unknown.map((c) => {
      const inst = tidyName(c.institution_name) || "Your bank";
      return needsYouRow(
        "#cards",
        h(
          "span",
          { class: "card-art", style: { "--hue": hue(`${c.institution_name} ${c.account_name}`) } },
          h("span", null, initials(inst)),
        ),
        `Which ${inst} card is “${reportedName(c)}”?`,
        "Counted as 1% back until you pick it",
        "Pick",
      );
    }),
  ];
  for (const a of ok("actions")?.in_progress || []) {
    if (a.progress?.status !== "your_turn") continue;
    rows.push(
      needsYouRow(
        "#in-progress",
        h("span", { class: `avatar avatar-icon cat-${a.category}` }, icon("alert")),
        `${agentName(a.progress.agent)} needs you`,
        a.progress.your_turn.note,
        "Open",
        true,
      ),
    );
  }
  const mix = ok("allocation");
  // Once it's an action, the Actions page asks; this row would say it twice.
  const asAction = (ok("proposals")?.proposals || []).some(
    (p) => p.finding_key === "new_money" && ["proposed", "approved"].includes(p.state),
  );
  if (mix?.state === "ready" && mix.rebalance && mix.new_money.basis === "catch_up" && !asAction) {
    const labels = Object.fromEntries(mix.buckets.map((b) => [b.key, b.label]));
    rows.push(
      needsYouRow(
        "#investments",
        h("span", { class: "avatar avatar-icon cat-securities" }, icon("up")),
        "Where new money goes",
        mix.new_money.split
          .map((s) => `${s.percent}% ${(labels[s.bucket] || s.bucket).toLowerCase()}`)
          .join(", "),
        "See",
      ),
    );
  }
  if (!rows.length) return null;
  return h(
    "section",
    { class: "section" },
    sectionHead("Needs you"),
    h("div", { class: "tasks" }, rows),
  );
}

// Actions: the home page (decisions 0003 and 0005) ---------------------------------------------
// What Tidysum found, one action at a time to approve, what the owner's agent is doing with the
// approved ones, and what a sync has since confirmed. The UI informs and takes approvals; the
// owner's own agent does the hands-on work over MCP.

/** Which waiting action the page shows; kept across reloads so a decision lands on the next. */
let actionFocus = null;
/** The action the card last showed, so a new one slides in and a re-render doesn't. */
let actionShown = null;

/** The headline, one-line why and details for an action: the finding's own words when it fixes one. */
function actionText(a) {
  if (a.finding) {
    const d = describe({ ...a.finding, category: a.category });
    return { title: d.title, sub: d.sub, notes: d.notes.filter(Boolean), d };
  }
  return { title: prose(a.title), sub: prose(a.rationale), notes: [], d: null };
}

/** "Claude Code" from "mcp:claude-code": the MCP client that carried out or suggested it. */
function agentName(source) {
  const name = String(source || "")
    .replace(/^mcp:/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  return !name || name === "Unknown" ? "Your agent" : name;
}

/**
 * Who carries an approved action out (decision 0005): the owner's agent (trades included, up to
 * Submit), Tidysum itself for investing with no steps for an agent, or the owner. The server says; older servers didn't, so the rule is repeated here.
 */
function carriedBy(a) {
  if (a.carried_by) return a.carried_by;
  const forAgent = a.steps.some((s) => s.by === "agent");
  if (a.category === "securities" && !forAgent) return "tidysum";
  return forAgent ? "agent" : "owner";
}

/**
 * An action's days in a few words (decision 0006): when it can start and when it runs out of
 * time. Empty for an action with neither.
 */
function whenText(a) {
  const by = a.due_by ? `due by ${dayShort(a.due_by)}` : "";
  if (a.timing === "scheduled")
    return [`Starts ${dayShort(a.not_before)}`, by].filter(Boolean).join(", ");
  if (a.timing === "waiting") return calmText(a.market);
  if (a.timing === "overdue") return `Was due by ${dayShort(a.due_by)}`;
  if (a.timing === "due" && a.wait_for === "calm_markets")
    return `Markets are calm, so it can start now${by ? `, ${by}` : ""}`;
  if (a.timing === "due") return by ? by[0].toUpperCase() + by.slice(1) : "Can start now";
  return "";
}

/** Why an action waits for calm markets (decision 0008), with the latest VIX close. */
function calmText(m) {
  const at = m?.threshold ?? "20";
  const rule = `calm is ${at} or below five days running, with none above ${m?.spike ?? "25"} in three weeks`;
  return m?.vix
    ? `Waits for calm markets: the VIX was ${Number(m.vix).toFixed(1)} on ${dayShort(m.as_of)}${m.peak && Number(m.peak) > Number(m.spike) ? ` and reached ${Number(m.peak).toFixed(1)} lately` : ""}; ${rule}`
    : `Waits for calm markets: ${rule}`;
}

/** A small line with an action's days, on its card. */
function whenLine(a) {
  const text = whenText(a);
  if (!text) return null;
  return h(
    "p",
    { class: `action-when ${a.timing === "overdue" ? "is-late" : ""}` },
    icon("clock"),
    h("span", null, text),
    (a.timing === "scheduled" || a.timing === "waiting") && a.state !== "approved"
      ? h(
          "span",
          { class: "action-when-note" },
          a.timing === "waiting"
            ? "Approve it now and it starts when markets are calm. You'll get a notification."
            : "Approve it now and it waits until then.",
        )
      : null,
  );
}

/** Each step with who does it: the agent (sparkle), the owner (person), done, or waiting on you. */
function actionSteps(a) {
  const p = a.progress;
  const turn = p?.status === "your_turn" ? p.your_turn : null;
  const tidysum = carriedBy(a) === "tidysum";
  return h(
    "ol",
    { class: "action-steps" },
    a.steps.map((s, i) => {
      const n = i + 1;
      const done = p?.done.includes(n);
      const mine = turn?.step === n;
      const byAgent = s.by === "agent";
      const who = done
        ? "Done"
        : mine
          ? "Your turn"
          : byAgent
            ? tidysum
              ? "Tidysum"
              : "Your agent"
            : "You";
      return h(
        "li",
        { class: done ? "is-done" : mine ? "is-turn" : byAgent ? "is-agent" : "is-you" },
        h(
          "span",
          { class: "step-mark", title: who, "aria-label": who },
          icon(done ? "tick" : mine ? "alert" : byAgent ? "sparkle" : "user"),
        ),
        h(
          "span",
          { class: "step-text" },
          s.text,
          !done && !mine && s.needs_you
            ? h("span", { class: "step-you" }, `You: ${s.needs_you.toLowerCase()}`)
            : null,
        ),
      );
    }),
  );
}

/** Who carries out the steps, and where the owner's agent has got to (decision 0005). */
function whoDoesIt(a) {
  const p = a.progress;
  const who = agentName(p?.agent);
  const line = (text, kind = "info", iconName) =>
    h(
      "p",
      { class: `action-who is-${kind}` },
      icon(iconName || (kind === "warn" ? "alert" : "sparkle")),
      h("span", null, text),
    );
  if (p?.status === "working") {
    const next = a.steps.findIndex((_, i) => !p.done.includes(i + 1));
    return line(
      next < 0
        ? `${who} has done every step.`
        : `${who} is on step ${next + 1} of ${a.steps.length}.`,
      "live",
    );
  }
  if (p?.status === "your_turn") return line(`${who} needs you: ${p.your_turn.note}`, "warn");
  if (p?.status === "stopped") {
    return line(
      `${who} stopped${p.note ? `: ${p.note}` : "."} Ask it to start again, or finish the steps yourself.`,
      "warn",
    );
  }
  if (p?.status === "finished")
    return line(
      `${who} finished it. ${followUpOf(a) ? confirmWhen(a) : "The next sync confirms it worked."}`,
      "info",
      "check",
    );
  const by = carriedBy(a);
  if (by === "tidysum") {
    return line(
      a.state === "approved"
        ? "Approved. Tidysum places investing steps itself once its trading connection is set up."
        : "Investing steps are carried out by Tidysum itself, once its trading connection is set up.",
      "info",
      "shield",
    );
  }
  if (by === "owner") return line("These steps need you; no agent can do them.", "info", "user");
  return line(
    a.state === "approved"
      ? "Approved. Your agent picks it up next time you ask it to carry out your Tidysum actions."
      : "Approve it and your AI agent does these steps, stopping only where it needs you.",
  );
}

function decide(button, a, path, message) {
  if (path === "dismiss" || path === "done") actionFocus = null;
  return act(button, () => api(`/api/proposals/${a.id}/${path}`, {}), message, [
    "actions",
    "proposals",
    "mis",
  ]);
}

async function approveAction(button, a) {
  actionFocus = null;
  await act(
    button,
    () => api(`/api/proposals/${a.id}/approve`, {}),
    a.timing === "scheduled"
      ? `Approved. It waits under Scheduled until ${dayShort(a.not_before)}.`
      : a.timing === "waiting"
        ? "Approved. It waits under Scheduled until markets are calm."
        : carriedBy(a) === "agent"
          ? "Approved. Your agent can carry it out now."
          : "Approved.",
    ["actions", "proposals", "mis"],
  );
}

/**
 * Which bank a cash action sends the money to. Tidysum suggests the best rate; the owner can pick
 * another (one that takes their paycheck, say) and the action's steps follow the pick.
 */
function bankChooser(a) {
  if (a.finding?.detector !== "deposit_rate") return null;
  const acct = cashAccount(a.finding.account_ids[0]);
  const options = acct?.alternatives || [];
  if (options.length < 2 && !acct?.chosen_product_id) return null;
  const save = async (ev) => {
    const s = ev.currentTarget;
    s.disabled = true;
    try {
      await api(`/api/products/${acct.account_id}/choice`, { productId: s.value || null });
      await load("products", "mis", "actions", "proposals");
      toast("Saved. The steps now follow that bank.", "ok");
    } catch (e) {
      toast(e.message, "error");
      s.disabled = false;
    }
  };
  return h(
    "label",
    { class: "action-choice" },
    h("span", null, "Bank"),
    h(
      "select",
      { class: "select select-sm", onchange: save },
      acct.chosen_product_id ? h("option", { value: "" }, "Whichever pays the most") : null,
      options.map((o) =>
        h(
          "option",
          { value: o.product_id, selected: o.product_id === options[0].product_id },
          `${productName(o.provider, o.name)} · ${pct(o.apy)} · +${usd0(o.annual_gain)} a year`,
        ),
      ),
    ),
  );
}

/** The investing action's split, as chips: "31% US stocks". */
function newMoneySplit() {
  const mix = ok("allocation");
  if (mix?.state !== "ready" || !mix.new_money?.split?.length) return null;
  const labels = Object.fromEntries(mix.buckets.map((b) => [b.key, b.label]));
  return h(
    "div",
    { class: "chips" },
    mix.new_money.split.map((s) =>
      h(
        "span",
        { class: "chip-static" },
        h("b", { class: "num" }, `${s.percent}%`),
        ` ${labels[s.bucket] || s.bucket}`,
      ),
    ),
  );
}

function actionCard(a, position, count) {
  const { title, sub, notes, d } = actionText(a);
  const value = a.expected_annual_value ? cents(a.expected_annual_value) : 0n;
  const blocked = a.state === "blocked";
  const v = a.validation || { violations: [], warnings: [] };
  const cat = CATEGORIES[a.category] || { label: a.category, icon: "info" };
  const isNew = actionShown !== a.id;
  actionShown = a.id;
  const step = (dir) =>
    h(
      "button",
      {
        class: "btn btn-quiet btn-icon",
        type: "button",
        "aria-label": dir < 0 ? "Previous action" : "Next action",
        title: dir < 0 ? "Previous (←)" : "Next (→)",
        disabled: count < 2,
        onclick: () => moveFocus(dir),
      },
      icon("chevron"),
    );
  const newMoney = a.finding_key === "new_money";
  const facts = d?.facts.filter(Boolean) || [];
  const links = [
    d?.primary && !d.primary.href.startsWith("#actions") ? d.primary : null,
    d?.secondary,
    newMoney ? { label: "Your mix", href: "#investments" } : null,
  ].filter(Boolean);
  return h(
    "article",
    { class: `action-card cat-${a.category} ${isNew ? "is-new" : ""}`, id: "decide" },
    h(
      "header",
      { class: "action-top" },
      h("span", { class: "cat-icon" }, icon(cat.icon)),
      h("span", { class: "action-cat" }, cat.label),
      h("span", { class: "spacer" }),
      count > 1 ? h("span", { class: "action-count num" }, `${position + 1} of ${count}`) : null,
      count > 1 ? h("span", { class: "action-nav" }, step(-1), step(1)) : null,
    ),
    h("h2", { class: "action-title" }, newMoney ? "Invest new money toward your mix" : title),
    whenLine(a),
    value > 0n
      ? h(
          "p",
          { class: "action-worth" },
          h("span", { class: "num" }, `+${usd0(value)}`),
          h("small", null, " a year"),
        )
      : null,
    newMoney
      ? h(
          "div",
          { class: "action-sub" },
          h("p", null, "Each paycheck you invest, split like this. Nothing gets sold."),
          newMoneySplit(),
        )
      : sub
        ? h("p", { class: "action-sub" }, sub)
        : null,
    bankChooser(a),
    v.violations.map((x) => notice("danger", prose(x))),
    v.warnings.map((x) => notice("warn", prose(x))),
    a.steps.length
      ? h(
          "div",
          { class: "action-plan" },
          h("span", { class: "todo-label" }, "The plan"),
          actionSteps(a),
          whoDoesIt(a),
        )
      : null,
    facts.length || d?.detail
      ? fold(
          `numbers-${a.id}`,
          "The numbers",
          facts.length ? h("dl", { class: "facts" }, facts) : null,
          d?.detail,
        )
      : null,
    notes.length || links.length
      ? h(
          "div",
          { class: "action-foot" },
          notes.length
            ? h(
                "ul",
                { class: "finding-notes" },
                notes.map((n) => h("li", null, n)),
              )
            : null,
          links.length
            ? h(
                "div",
                { class: "action-links" },
                links.map((l) => actionLink(l, "inline-link")),
              )
            : null,
        )
      : null,
    h(
      "div",
      { class: "action-buttons" },
      blocked
        ? null
        : h(
            "button",
            {
              class: "btn btn-primary btn-lg",
              type: "button",
              onclick: (ev) => approveAction(ev.currentTarget, a),
            },
            icon("tick"),
            "Approve",
          ),
      h(
        "button",
        {
          class: "btn btn-lg",
          type: "button",
          onclick: (ev) => decide(ev.currentTarget, a, "snooze", "Okay. It'll be back next week."),
        },
        "Not now",
      ),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn btn-quiet btn-sm",
          type: "button",
          onclick: (ev) =>
            decide(ev.currentTarget, a, "dismiss", "Got it. Tidysum won't suggest this again."),
        },
        "Don't suggest again",
      ),
    ),
    a.source !== "tidysum"
      ? h(
          "p",
          { class: "seen" },
          a.source === "owner"
            ? `Added by you · ${dayShort(a.created_at)}`
            : `Suggested by ${agentName(a.source)} · ${dayShort(a.created_at)}`,
        )
      : null,
    h(
      "div",
      { class: "action-ask" },
      icon("sparkle"),
      h("span", null, "Not sure? Have your agent check it against your plan first."),
      copyButton(askExplain(a), "Copy question"),
    ),
  );
}

/** Moves the card to the previous or next waiting action. */
function moveFocus(dir) {
  const queue = ok("actions")?.queue || [];
  if (queue.length < 2) return;
  const at = Math.max(
    0,
    queue.findIndex((a) => a.id === actionFocus),
  );
  actionFocus = queue[(at + dir + queue.length) % queue.length].id;
  renderActions();
}

/** Everything waiting, beside the card: what's coming, and a way to jump to any of it. */
function queueList(queue, current) {
  const list = h(
    "ol",
    { class: "is-sortable" },
    queue.map((a) => {
      const { title } = actionText(a);
      const value = a.expected_annual_value ? cents(a.expected_annual_value) : 0n;
      const on = a.id === current.id;
      return h(
        "li",
        { "data-id": a.id },
        grip(),
        h(
          "button",
          {
            type: "button",
            class: `queue-item cat-${a.category}`,
            "aria-current": on ? "true" : null,
            onclick: () => {
              actionFocus = a.id;
              renderActions();
              if (window.matchMedia("(max-width: 899px)").matches)
                $("#decide")?.scrollIntoView({ behavior: "smooth", block: "start" });
            },
          },
          h("span", { class: "queue-dot" }),
          h(
            "span",
            { class: "queue-title" },
            a.finding_key === "new_money" ? "Invest new money toward your mix" : title,
          ),
          value > 0n
            ? h("span", { class: "queue-value num" }, `+${usd0(value)}`)
            : a.timing === "scheduled"
              ? h("span", { class: "queue-value" }, dayShort(a.not_before))
              : a.timing === "waiting"
                ? h("span", { class: "queue-value" }, "Calm")
                : null,
        ),
      );
    }),
  );
  sortable(list, "queue");
  return h(
    "nav",
    { class: "queue", "aria-label": "Waiting for you" },
    h(
      "div",
      { class: "queue-head" },
      h("span", null, "Waiting for you"),
      h("span", { class: "num" }, String(queue.length)),
    ),
    list,
    h("div", { class: "queue-ask" }, copyButton(ASK_ORDER, "Ask your agent which first")),
  );
}

// Drag to reorder --------------------------------------------------------------------------
// The owner puts waiting and in-progress actions in their own order, kept per user on the
// server: Up next follows it, and so does their agent. A mouse drags a whole row; a finger drags
// by the grip, so the page still scrolls under it. The grip's up and down arrows move a row too.

let sorting = false;
let renderAfterSort = false;

/** The handle a row is dragged by. */
function grip() {
  return h(
    "button",
    {
      type: "button",
      class: "grip",
      title: "Drag to reorder",
      "aria-label": "Move: drag, or use the up and down arrow keys",
    },
    icon("grip"),
  );
}

/** Makes the rows of `list` (children with data-id) draggable into a new order. Returns it. */
function sortable(list, section) {
  const rows = () => [...list.children].filter((el) => el.dataset.id);
  const order = () => rows().map((el) => el.dataset.id);
  list.dataset.sort = section;

  list.addEventListener("keydown", (ev) => {
    const handle = ev.target.closest(".grip");
    if (!handle || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
    ev.preventDefault();
    const row = handle.closest("[data-id]");
    const ids = order();
    const at = ids.indexOf(row.dataset.id);
    const to = at + (ev.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(at, 1));
    saveOrder(section, ids, row.dataset.id);
  });

  list.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || sorting) return;
    const row = ev.target.closest("[data-id]");
    if (row?.parentElement !== list || rows().length < 2) return;
    const byGrip = !!ev.target.closest(".grip");
    if (!byGrip && (ev.pointerType !== "mouse" || ev.target.closest(".finding-body, a, input")))
      return;
    drag(ev, row, byGrip);
  });

  function drag(ev, row, now) {
    const before = order();
    const origin = () => {
      const parent = row.offsetParent || document.body;
      return parent.getBoundingClientRect().top + parent.clientTop;
    };
    const grab = ev.clientY - (origin() + row.offsetTop);
    const startY = ev.clientY;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let y = ev.clientY;
    let dy = 0;
    let live = false;
    let frame = 0;

    const follow = () => {
      dy = y - grab - (origin() + row.offsetTop);
      row.style.transform = `translateY(${dy}px)`;
    };
    // The row goes before the first other row whose middle is below its own middle.
    const reorder = () => {
      const mid = y - grab + row.offsetHeight / 2 - origin();
      const others = rows().filter((r) => r !== row);
      const next = others.find((r) => mid < r.offsetTop + r.offsetHeight / 2) || null;
      if (next === row.nextElementSibling || (!next && row === rows().at(-1))) return;
      const first = new Map(others.map((r) => [r, r.getBoundingClientRect().top]));
      if (next) list.insertBefore(row, next);
      else list.append(row);
      if (!still) {
        for (const r of others) {
          const d = first.get(r) - r.getBoundingClientRect().top;
          if (d)
            r.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], {
              duration: 160,
              easing: "cubic-bezier(.2,.8,.2,1)",
            });
        }
      }
      follow();
    };
    // Near the top or bottom of the window, the page scrolls so a long list can be reached.
    const tick = () => {
      const edge = 72;
      const bottom =
        window.innerHeight - (window.matchMedia("(max-width: 760px)").matches ? 96 : edge);
      const step =
        y < edge ? -Math.ceil((edge - y) / 6) : y > bottom ? Math.ceil((y - bottom) / 6) : 0;
      if (step) {
        window.scrollBy(0, step);
        follow();
        reorder();
      }
      frame = requestAnimationFrame(tick);
    };
    const begin = () => {
      live = true;
      sorting = true;
      row.classList.add("is-dragging");
      list.classList.add("is-sorting");
      document.body.classList.add("is-sorting");
      try {
        ev.target.setPointerCapture(ev.pointerId);
      } catch {}
      frame = requestAnimationFrame(tick);
    };
    const move = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      y = e.clientY;
      if (!live) {
        if (Math.abs(y - startY) < 5) return;
        begin();
      }
      e.preventDefault();
      follow();
      reorder();
    };
    const finish = (cancel) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("keydown", onEscape, true);
      cancelAnimationFrame(frame);
      if (!live) return;
      if (cancel) for (const id of before) list.append(list.querySelector(`[data-id="${id}"]`));
      const from = cancel ? 0 : dy;
      row.style.transform = "";
      if (!still && from)
        row.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], {
          duration: 160,
          easing: "cubic-bezier(.2,.8,.2,1)",
        });
      row.classList.remove("is-dragging");
      list.classList.remove("is-sorting");
      document.body.classList.remove("is-sorting");
      sorting = false;
      // The click a mouse sends after letting go isn't a click on the row.
      const swallow = (e) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 250);
      const after = order();
      if (!cancel && after.join() !== before.join()) saveOrder(section, after);
      else if (renderAfterSort) renderActions();
    };
    const up = (e) => e.pointerId === ev.pointerId && finish(false);
    const cancelled = (e) => e.pointerId === ev.pointerId && finish(true);
    const onEscape = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      finish(true);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelled);
    window.addEventListener("keydown", onEscape, true);
    if (now) {
      ev.preventDefault();
      begin();
    }
  }
  return list;
}

/** Shows the new order at once and keeps it on the server; a failure puts the old one back. */
async function saveOrder(section, ids, focusId) {
  const r = data.actions;
  const list = r?.[section];
  if (!list) return;
  const byId = new Map(list.map((a) => [a.id, a]));
  r[section] = [
    ...ids.map((id) => byId.get(id)).filter(Boolean),
    ...list.filter((a) => !ids.includes(a.id)),
  ];
  renderAfterSort = false;
  renderActions();
  if (focusId)
    document.querySelector(`[data-sort="${section}"] [data-id="${focusId}"] .grip`)?.focus();
  try {
    await api("/api/actions/order", { ids });
  } catch (e) {
    toast(`Couldn't keep that order. ${e.message}`, "error");
    load("actions");
  }
}

/** An approved action being carried out, or a finished one, as a compact row. */
function actionRow(a, finished, movable = false) {
  const { title } = actionText(a);
  const confirmed = a.state === "confirmed";
  const realized = a.finding?.realized_annual_value;
  const value = cents(realized ?? a.expected_annual_value ?? "0");
  const p = a.progress;
  const live = !finished && p?.status === "working";
  const row = fixRow({
    key: `action-${a.id}`,
    category: a.category,
    title: a.finding_key === "new_money" ? "Invest new money toward your mix" : title,
    tag: finished
      ? h(
          "span",
          { class: `tag-new ${confirmed ? "tag-done" : ""}` },
          confirmed ? "Confirmed" : "Done",
        )
      : live
        ? h("span", { class: "tag-new tag-live" }, h("i"), "Working")
        : p?.status === "your_turn"
          ? h("span", { class: "tag-new tag-warn" }, "Needs you")
          : a.timing === "overdue"
            ? h("span", { class: "tag-new tag-warn" }, "Overdue")
            : a.due_by && p?.status !== "finished"
              ? h("span", { class: "tag-new" }, `Due ${dayShort(a.due_by)}`)
              : null,
    sub: finished
      ? confirmed
        ? realized
          ? "Measured from your accounts since."
          : a.finding_key === "new_money"
            ? "Your mix is back on target."
            : a.category === "securities"
              ? "Checked: it took effect."
              : "A sync showed it's fixed."
        : p?.status === "finished"
          ? `${didIt(p)} ${confirmWhen(a)}`
          : confirmWhen(a)
      : p?.status === "finished"
        ? `${didIt(p)} ${confirmWhen(a)}`
        : p?.status === "your_turn"
          ? `${agentName(p.agent)} needs you: ${p.your_turn.note}`
          : live
            ? `${agentName(p.agent)} is on step ${Math.min(p.done.length + 1, a.steps.length)} of ${a.steps.length}`
            : p?.status === "stopped"
              ? `${agentName(p.agent)} stopped`
              : carriedBy(a) === "agent"
                ? "Ready for your agent"
                : carriedBy(a) === "tidysum"
                  ? "Waiting for Tidysum's trading connection"
                  : plural(a.steps.length, "step"),
    amount: value > 0n ? usd0(value) : null,
    amountNote: value > 0n ? (realized ? "a year, measured" : "a year") : "",
    gain: true,
    progress: !finished && a.steps.length ? (p?.done.length || 0) / a.steps.length : null,
    body: finished
      ? [agentReport(p), actionSteps(a)]
      : [
          agentReport(p),
          actionSteps(a),
          whoDoesIt(a),
          h(
            "div",
            { class: "finding-actions" },
            p?.status === "finished"
              ? null
              : h(
                  "button",
                  {
                    class: "btn btn-sm",
                    type: "button",
                    onclick: (ev) =>
                      decide(ev.currentTarget, a, "done", "Nice. The next sync will confirm it."),
                  },
                  icon("tick"),
                  "It's done",
                ),
            h("span", { class: "spacer" }),
            h(
              "button",
              {
                class: "btn btn-quiet btn-sm",
                type: "button",
                onclick: (ev) => decide(ev.currentTarget, a, "dismiss", "Approval withdrawn."),
              },
              "Withdraw approval",
            ),
          ),
        ],
  });
  if (movable) {
    row.dataset.id = a.id;
    row.prepend(grip());
  }
  return row;
}

/** "Claude Code did it: set 28% pre-tax." What the agent says it did, cut short for one line. */
function didIt(p) {
  const who = agentName(p.agent);
  if (!p.note) return `${who} did it.`;
  const note = prose(p.note).replace(/\.$/, "");
  if (note.length <= 70) return `${who}: ${note}.`;
  return `${who}: ${note.slice(0, 70).replace(/[\s,;:]+\S*$/, "")}…`;
}

/** The action that checks this one later (decision 0006), if one is waiting. */
function followUpOf(a) {
  const r = ok("actions");
  return [...(r?.queue || []), ...(r?.in_progress || []), ...(r?.scheduled || [])].find(
    (x) => x.follow_up_of === a.id,
  );
}

/** How a done action gets confirmed: by its follow-up check on a day, or by a sync. */
function confirmWhen(a) {
  const fu = followUpOf(a);
  if (fu) {
    return fu.not_before && fu.timing === "scheduled"
      ? `Tidysum checks it on ${dayShort(fu.not_before)}.`
      : "Your agent's check confirms it.";
  }
  return "Waiting for a sync to confirm it.";
}

/** What the agent reported when it finished, in full. Agent text: set as text only. */
function agentReport(p) {
  if (p?.status !== "finished" || !p.note) return null;
  return h(
    "p",
    { class: "agent-report" },
    icon("sparkle"),
    h("span", null, h("strong", null, `${agentName(p.agent)}: `), prose(p.note)),
  );
}

/** An action approved ahead, waiting for its first day (decision 0006). */
function scheduledRow(a) {
  const { title } = actionText(a);
  const value = cents(a.expected_annual_value ?? "0");
  const who = carriedBy(a);
  return fixRow({
    key: `action-${a.id}`,
    category: a.category,
    title,
    tag: h(
      "span",
      { class: "tag-new tag-done" },
      a.timing === "waiting" ? "Calm markets" : dayShort(a.not_before),
    ),
    sub:
      a.timing === "waiting"
        ? `${calmText(a.market)}. ${
            who === "agent"
              ? "Your agent starts then, and you get a notification."
              : who === "tidysum"
                ? "Tidysum carries it out then."
                : "Tidysum reminds you then."
          }`
        : `${a.due_by ? `Due by ${dayShort(a.due_by)}. ` : ""}${
            who === "agent"
              ? "Ready for your agent that day."
              : who === "tidysum"
                ? "Tidysum carries it out that day."
                : "Tidysum reminds you that day."
          }`,
    amount: value > 0n ? usd0(value) : null,
    amountNote: value > 0n ? "a year" : "",
    gain: true,
    body: [
      actionSteps(a),
      h(
        "div",
        { class: "finding-actions" },
        h("span", { class: "spacer" }),
        h(
          "button",
          {
            class: "btn btn-quiet btn-sm",
            type: "button",
            onclick: (ev) => decide(ev.currentTarget, a, "dismiss", "Approval withdrawn."),
          },
          "Withdraw approval",
        ),
      ),
    ],
  });
}

/** What to tell the owner's agent, copied with one click. Matches the skill's trigger. */
const AGENT_ASK = "Carry out my approved Tidysum actions.";

/**
 * Tidysum has no chat (decision 0002): weighing an action up happens with the owner's own agent.
 * These are the questions to paste into it, with the action's id so it finds the right one.
 */
const askExplain = (a) =>
  `Look at my Tidysum action “${actionText(a).title}” (id ${a.id}). Is it right for me? Check it against my plan and tell me the catch, if any.`;
const ASK_ORDER =
  "Go through the Tidysum actions waiting for my approval and tell me which to approve first, and why.";

function copyButton(text, label) {
  return h(
    "button",
    {
      class: "btn btn-sm",
      type: "button",
      onclick: async (ev) => {
        const b = ev.currentTarget;
        try {
          await navigator.clipboard.writeText(text);
          b.classList.add("is-copied");
          b.lastChild.textContent = "Copied";
          setTimeout(() => {
            b.classList.remove("is-copied");
            b.lastChild.textContent = label;
          }, 1800);
        } catch {
          toast(`Couldn't copy. Tell your agent: “${text}”`);
        }
      },
    },
    icon("copy"),
    h("span", null, label),
  );
}

/** Approved work no agent has picked up yet: one line to hand it over. */
function agentHandoff(going) {
  const ready = going.filter((a) => carriedBy(a) === "agent" && !a.progress);
  if (!ready.length) return null;
  return h(
    "div",
    { class: "handoff" },
    h("span", { class: "handoff-icon" }, icon("sparkle")),
    h(
      "div",
      { class: "handoff-text" },
      h(
        "strong",
        null,
        ready.length === 1
          ? "1 approved action is ready for your agent"
          : `${ready.length} approved actions are ready for your agent`,
      ),
      h("span", null, "Ask your AI agent: ", h("q", null, AGENT_ASK)),
    ),
    copyButton(AGENT_ASK, "Copy"),
  );
}

/** One sentence, one number: what the open findings cost a year, by category. */
function hero(r) {
  const total = cents(r.annual_cost);
  const items = ok("items")?.items || [];
  const figure = h("span", { class: "hero-figure num" }, usd0(total));
  const segments = Object.keys(CATEGORIES)
    .map((k) => ({ key: k, c: cents(r.by_category[k]) }))
    .filter((s) => s.c > 0n);
  return h(
    "section",
    { class: `hero ${total > 0n ? "" : "is-clear"}` },
    total > 0n
      ? h(
          "h1",
          { class: "hero-title" },
          h("span", null, "You could keep about ", figure),
          h("span", null, " more each year."),
        )
      : items.length
        ? h("h1", { class: "hero-title is-good" }, "Everything is in good order.")
        : h("h1", { class: "hero-title" }, "Let's see where your money could do more."),
    h(
      "p",
      { class: "hero-sub" },
      total > 0n
        ? `That's about ${usd0(r.monthly_cost)} a month. Each change below waits for your approval.`
        : items.length
          ? "Tidysum checks again after every sync and drafts a fix for anything it finds."
          : toConnections("Link your banks and cards to start."),
    ),
    segments.length
      ? h(
          "div",
          { class: "mix" },
          h(
            "div",
            { class: "mix-bar", role: "img", "aria-label": "Yearly cost by category" },
            segments.map((s) =>
              h("span", {
                class: `cat-${s.key}`,
                style: { flexGrow: String(Number(s.c)) },
                title: `${CATEGORIES[s.key].label}: ${usd(s.c)} a year`,
              }),
            ),
          ),
          h(
            "ul",
            { class: "mix-legend" },
            segments.map((s) =>
              h(
                "li",
                { class: `cat-${s.key}` },
                h("span", { class: "swatch" }),
                CATEGORIES[s.key].label,
                h("span", { class: "num" }, usd0(s.c)),
              ),
            ),
          ),
        )
      : null,
  );
}

function renderActions() {
  // A drag in progress keeps its rows; the page catches up when it ends.
  if (sorting) {
    renderAfterSort = true;
    return;
  }
  const root = $("#actions-body");
  const r = data.actions;
  const mis = ok("mis");
  if (!r || !data.mis) return fill(root, skeleton(2));
  if (r.error) return fill(root, failed("Actions", r));
  if (data.mis.error) return fill(root, failed("Findings", data.mis));

  const { queue, in_progress: going, finished } = r;
  const scheduled = r.scheduled || [];
  let at = queue.findIndex((a) => a.id === actionFocus);
  if (at < 0) at = 0;
  const current = queue[at];
  actionFocus = current?.id ?? null;

  // A finding with no action yet (no policy to draft against, say) still shows, with its own
  // details, so nothing found goes unseen.
  const drafted = new Set(
    [...queue, ...going, ...scheduled, ...finished, ...(ok("proposals")?.proposals || [])]
      .map((a) => a.finding_key)
      .filter(Boolean),
  );
  const loose = mis.items.filter((m) => m.state !== "dismissed" && !drafted.has(m.key));
  const dismissed = mis.items.filter((m) => m.state === "dismissed");
  const items = ok("items")?.items || [];
  const notes = mis.warnings.filter(
    (w) =>
      !isCardQuestion(w) && !(isConnectionStale(w) && items.some((it) => it.status !== "active")),
  );

  fill(
    root,
    hero(mis),
    needsYou(),
    current
      ? h(
          "section",
          { class: "section decide-wrap" },
          sectionHead("Up next", queue.length > 1 ? "← → to look through them" : null),
          h(
            "div",
            { class: `decide ${queue.length > 1 ? "has-queue" : ""}` },
            actionCard(current, at, queue.length),
            queue.length > 1 ? queueList(queue, current) : null,
          ),
          r.snoozed
            ? h(
                "p",
                { class: "seen action-snoozed" },
                `${plural(r.snoozed, "action")} set aside for a week.`,
              )
            : null,
        )
      : h(
          "section",
          { class: "section", id: "decide" },
          empty(
            "check",
            "Nothing to decide",
            going.length || scheduled.length
              ? "Everything waiting has a decision. What's in progress and scheduled is below."
              : r.snoozed
                ? `${plural(r.snoozed, "action")} set aside for a week. Tidysum drafts a new one whenever a sync finds money in the wrong place.`
                : "Tidysum drafts a new action whenever a sync finds money in the wrong place.",
            null,
            true,
          ),
        ),
    loose.length
      ? h(
          "section",
          { class: "section" },
          sectionHead("Also found"),
          h(
            "div",
            { class: "findings" },
            loose.map((m) => findingRow(m)),
          ),
        )
      : null,
    going.length
      ? h(
          "section",
          { class: "section", id: "in-progress" },
          sectionHead("In progress"),
          agentHandoff(going),
          going.length > 1
            ? sortable(
                h(
                  "div",
                  { class: "findings is-sortable" },
                  going.map((a) => actionRow(a, false, true)),
                ),
                "in_progress",
              )
            : h(
                "div",
                { class: "findings" },
                going.map((a) => actionRow(a, false)),
              ),
        )
      : null,
    scheduled.length
      ? h(
          "section",
          { class: "section", id: "scheduled" },
          sectionHead("Scheduled", "approved, waiting for their day or for calm markets"),
          h(
            "div",
            { class: "findings" },
            scheduled.map((a) => scheduledRow(a)),
          ),
        )
      : null,
    finished.length
      ? h(
          "section",
          { class: "section", id: "done" },
          sectionHead("Done", "the last 90 days"),
          h(
            "div",
            { class: "findings" },
            finished.map((a) => actionRow(a, true)),
          ),
        )
      : null,
    activityFeed(),
    dismissed.length
      ? h(
          "section",
          { class: "section section-quiet" },
          fold(
            "dismissed",
            `Not for you (${dismissed.length})`,
            h(
              "div",
              { class: "findings" },
              dismissed.map((m) => findingRow(m)),
            ),
          ),
        )
      : null,
    fineprint({ notes, notCovered: mis.not_covered.map(tidyNotCovered) }),
  );
}

// Left and right arrows look through the waiting actions, unless a control has the keys.
document.addEventListener("keydown", (ev) => {
  if (currentView !== "actions" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  if (ev.target.closest?.("input, select, textarea, dialog, [contenteditable]")) return;
  ev.preventDefault();
  moveFocus(ev.key === "ArrowLeft" ? -1 : 1);
});

// Activity ---------------------------------------------------------------------------------
// What Tidysum, the owner's agent and the owner did lately, from the audit log: the agent's work
// is visible here even when nothing is in progress any more.

/** Who wrote an audit event: Tidysum's own loop, the owner's agent, or the owner. */
function actorOf(actor) {
  const a = String(actor || "");
  if (a.startsWith("mcp:")) return { kind: "agent", name: agentName(a) };
  if (a === "tidysum" || a === "purser") return { kind: "tidysum", name: "Tidysum" };
  return { kind: "you", name: "You" };
}

const quoteTitle = (t) => (t ? `“${prose(t).replace(/\.$/, "")}”` : "an action");

/** One line of the feed, in plain words. Titles and notes are data, set as text only. */
function activityText(e, count) {
  const who = actorOf(e.actor);
  const t = quoteTitle(e.title);
  const many = count > 1;
  switch (e.event) {
    case "proposal.created":
      if (who.kind === "tidysum")
        return many ? `drafted ${count} actions for you to decide` : `drafted ${t}`;
      return many ? `suggested ${count} actions` : `suggested ${t}`;
    case "proposal.approved":
      return `approved ${t}`;
    case "proposal.approval_refused":
      return `couldn't approve ${t}: the numbers or rules changed`;
    case "proposal.done":
      return who.kind === "agent" ? `finished ${t}` : `marked ${t} done`;
    case "proposal.confirmed":
      return `confirmed ${t} worked, from a sync`;
    case "proposal.dismissed":
      return who.kind === "tidysum" ? `withdrew ${t}` : `turned down ${t}`;
    case "proposal.snoozed":
      return `set ${t} aside for a week`;
    case "proposal.withdrawn":
      return `withdrew ${t}: the problem went away`;
    case "proposal.due":
      return `says ${t} is due now`;
    case "proposal.due_soon":
      return `reminded you ${t} is due tomorrow`;
    case "proposal.overdue":
      return `says ${t} is past its due day`;
    case "proposal.waiting":
      return `put ${t} back to wait: markets turned jumpy`;
    case "proposal.dispatched":
      return `asked your agent to carry out ${t}`;
    case "action.started":
      return `started on ${t}`;
    case "action.step_done":
      return `did step ${e.step ?? "?"} of ${t}`;
    case "action.your_turn":
      return `needs you on ${t}${e.note ? `: ${e.note}` : ""}`;
    case "action.stopped":
      return `stopped ${t}${e.note ? `: ${e.note}` : ""}`;
    case "action.finished":
      return `finished ${t}`;
    case "misallocation.found":
      return many
        ? `found ${count} places your money could do more`
        : `found: ${prose(e.title || "a new leak")}`;
    case "misallocation.resolved":
      return `saw it's fixed: ${prose(e.title || "a leak")}`;
    default:
      return e.event;
  }
}

/** Drafts and findings land in bursts after a sync; one line says "drafted 7 actions". */
function groupActivity(events) {
  const out = [];
  for (const e of events) {
    const last = out.at(-1);
    const burst =
      last &&
      ["proposal.created", "misallocation.found"].includes(e.event) &&
      last.e.event === e.event &&
      last.e.actor === e.actor &&
      Math.abs(new Date(last.e.at) - new Date(e.at)) < 10 * 60_000;
    if (burst) last.count++;
    else out.push({ e, count: 1 });
  }
  return out;
}

function activityFeed(limit = 6) {
  const r = ok("activity");
  if (!r?.events?.length) return null;
  const rows = groupActivity(r.events).slice(0, limit);
  return h(
    "section",
    { class: "section", id: "lately" },
    sectionHead("Lately", "Tidysum, your agent and you"),
    h(
      "ol",
      { class: "feed panel" },
      rows.map(({ e, count }) => {
        const who = actorOf(e.actor);
        return h(
          "li",
          { class: `feed-item is-${who.kind}` },
          h(
            "span",
            { class: "feed-avatar", title: who.name },
            icon(who.kind === "agent" ? "sparkle" : who.kind === "you" ? "user" : "logo"),
          ),
          h("p", { class: "feed-text" }, h("strong", null, who.name), " ", activityText(e, count)),
          h("time", { class: "feed-time", datetime: e.at, title: day(e.at) }, ago(e.at)),
        );
      }),
    ),
  );
}

// Connections -------------------------------------------------------------------------------

const ITEM_STATES = {
  active: ["Syncing", "pill-gain"],
  relink_required: ["Needs you", "pill-warn"],
  error: ["Not syncing", "pill-warn"],
  disconnected: ["Disconnected", ""],
};

const ITEM_DETAILS = {
  ITEM_LOGIN_REQUIRED: "The bank wants you to sign in again.",
  PENDING_EXPIRATION: "Access expires soon. Reconnect to keep syncing.",
  PENDING_DISCONNECT: "The bank will disconnect soon. Reconnect to keep syncing.",
  USER_PERMISSION_REVOKED: "Access was turned off at the bank.",
};

/** What to tell the owner about a connection that isn't syncing, in words, never Plaid's codes. */
function itemDetail(it, name) {
  if (it.status === "active") return null;
  if (isRetrying(it)) return `${name} isn't answering right now. Tidysum keeps trying on its own.`;
  if (it.status === "error")
    return `${name} hasn't answered for a while. Reconnecting often fixes it.`;
  if (it.status === "relink_required") {
    return ITEM_DETAILS[it.statusDetail] || "Reconnect to keep syncing.";
  }
  return null;
}

/** "Morgan Stanley - StockPlan Connect / Benefit Access" is a login page; people say "Morgan Stanley". */
const institutionName = (s) => tidyName(String(s ?? "").split(/\s+-\s+/)[0]);

function institutionRow(it) {
  const name = institutionName(it.institutionName) || "Unnamed connection";
  const broken = needsAttention(it);
  const retrying = isRetrying(it);
  const [label, cls] = retrying
    ? ["Retrying", ""]
    : ITEM_STATES[it.status] || [tidyName(it.status), ""];
  const detail = itemDetail(it, name);
  const synced = it.lastSyncedAt ? `Synced ${ago(it.lastSyncedAt)}` : "Not synced yet";
  return h(
    "div",
    { class: `conn ${broken ? "is-attention" : ""}` },
    h("div", { class: "avatar avatar-lg", style: { "--hue": hue(name) } }, initials(name)),
    h(
      "div",
      { class: "conn-id" },
      h("div", { class: "conn-name" }, name),
      h(
        "div",
        {
          class: `conn-sub ${broken ? "warn" : ""}`,
          title: it.lastSyncedAt ? new Date(it.lastSyncedAt).toLocaleString() : "",
        },
        detail ? `${detail} ${synced}.` : synced,
        it.source === "csv" ? " · from a file" : null,
      ),
    ),
    broken || retrying
      ? h("span", { class: `pill ${cls}` }, h("span", { class: "dot" }), label)
      : null,
    it.source === "plaid" && broken && it.status !== "disconnected"
      ? linkButton("Reconnect", { itemId: it.id, small: true })
      : null,
    // The demo's banks stay put: there is nothing real of yours to disconnect.
    ok("items")?.demo
      ? null
      : h(
          "button",
          {
            class: "btn btn-sm btn-quiet btn-icon",
            type: "button",
            title: `Remove ${name}`,
            "aria-label": `Remove ${name}`,
            onclick: async (ev) => {
              const b = ev.currentTarget;
              const yes = await confirmDialog(
                `Remove ${name}?`,
                "This disconnects it and deletes its accounts and everything synced from them. Only the audit log is kept.",
                "Remove",
              );
              if (yes) {
                act(b, () => api(`/api/items/${it.id}/remove`, {}), `Removed ${name}.`, ALL);
              }
            },
          },
          icon("trash"),
        ),
  );
}

// Plaid asks a returning user for their phone number, then texts a code. With the number saved,
// Link fills it in and only the code is left to type.
let editingPhone = false;
function phoneRow(ending) {
  if (ending && !editingPhone) {
    return h(
      "div",
      { class: "conn phone-row" },
      h(
        "div",
        { class: "conn-id" },
        h("div", { class: "conn-name" }, `Phone ending ${ending}`),
        h("div", { class: "conn-sub" }, "Plaid fills it in, so you only type the code it texts."),
      ),
      h(
        "button",
        {
          class: "btn btn-sm",
          type: "button",
          onclick: () => {
            editingPhone = true;
            render();
          },
        },
        "Change",
      ),
      h(
        "button",
        {
          class: "btn btn-sm btn-quiet btn-icon",
          type: "button",
          title: "Forget this number",
          "aria-label": "Forget this number",
          onclick: (ev) =>
            act(ev.currentTarget, () => api("/api/phone", { phone: null }), "Forgot your number.", [
              "items",
            ]),
        },
        icon("trash"),
      ),
    );
  }
  const input = h("input", {
    class: "input",
    type: "tel",
    autocomplete: "tel",
    inputmode: "tel",
    placeholder: "(555) 123-4567",
    "aria-label": "Phone number",
  });
  return h(
    "form",
    {
      class: "conn phone-row",
      onsubmit: (ev) => {
        ev.preventDefault();
        const b = ev.currentTarget.querySelector("button[type=submit]");
        act(
          b,
          async () => {
            await api("/api/phone", { phone: input.value });
            editingPhone = false;
          },
          "Saved. Plaid will fill it in next time.",
          ["items"],
        );
      },
    },
    h(
      "div",
      { class: "conn-id" },
      h("div", { class: "conn-name" }, "Your phone number"),
      h("div", { class: "conn-sub" }, "Plaid fills it in, so you only type the code it texts."),
    ),
    input,
    h("button", { class: "btn btn-sm btn-primary", type: "submit" }, "Save"),
    editingPhone
      ? h(
          "button",
          {
            class: "btn btn-sm btn-quiet",
            type: "button",
            onclick: () => {
              editingPhone = false;
              render();
            },
          },
          "Cancel",
        )
      : null,
  );
}

function renderConnections() {
  const root = $("#connections-body");
  const r = data.items;
  // The header button is the one way to link; the empty state carries it instead when there's
  // nothing linked yet.
  $("#link-new").hidden = !r || !!r.error || r.items.length === 0 || !!r.demo;
  if (!r) return fill(root, skeleton(1));
  if (r.error) return fill(root, failed("Connections", r));
  const phone = r.demo
    ? null
    : h("div", { class: "panel list phone-panel" }, phoneRow(r.phoneEnding));
  if (r.items.length === 0) {
    return fill(
      root,
      empty(
        "bank",
        "Nothing linked yet",
        "Link your banks, cards and brokerages, several in one go. Tidysum only reads them.",
        linkButton("Link institutions"),
      ),
      phone,
    );
  }
  const sorted = [...r.items].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  fill(root, h("div", { class: "panel list" }, sorted.map(institutionRow)), phone, agentPanel());
}

/** A command to copy, shown in full so the owner sees what it does before running it. */
function commandRow(label, cmd) {
  return h(
    "div",
    { class: "cmd" },
    h("span", { class: "cmd-label" }, label),
    h("code", { class: "cmd-text" }, cmd),
    copyButton(cmd, "Copy"),
  );
}

/**
 * The owner's agent is a connection too: the one that reads all of this and does the legwork
 * (decision 0005). When it last reported, what it may and may not do, and how to connect one.
 */
function agentPanel() {
  const r = ok("activity");
  const last = (r?.events || []).find((e) => actorOf(e.actor).kind === "agent");
  return h(
    "section",
    { class: "section" },
    sectionHead("Your agent"),
    h(
      "article",
      { class: "panel agent-panel" },
      h(
        "div",
        { class: "agent-panel-head" },
        h("span", { class: "handoff-icon" }, icon("sparkle")),
        h(
          "div",
          null,
          h("h3", null, last ? `${agentName(last.actor)} is connected` : "Bring your own agent"),
          h(
            "p",
            { class: "muted small" },
            last
              ? `Last reported ${ago(last.at)}. Reading doesn't show here; suggesting and carrying out actions does.`
              : "Claude, Claude Code or any MCP client. Reading doesn't show here; it shows up once it suggests or carries out an action.",
          ),
        ),
      ),
      h(
        "ul",
        { class: "agent-can" },
        h(
          "li",
          { class: "is-yes" },
          icon("tick"),
          "Reads your accounts, findings, plan and actions",
        ),
        h(
          "li",
          { class: "is-yes" },
          icon("tick"),
          "Suggests actions, and carries out the ones you approve",
        ),
        h(
          "li",
          { class: "is-no" },
          icon("error"),
          "Can't approve anything, place trades or see your bank logins",
        ),
      ),
      fold(
        "agent-connect",
        "Connect an agent",
        r?.mcp
          ? commandRow(
              "Over the network",
              `claude mcp add --transport http tidysum ${location.origin}/mcp --header "Authorization: Bearer $TIDYSUM_MCP_TOKEN"`,
            )
          : null,
        commandRow(
          "On this computer",
          "claude mcp add tidysum -- pnpm -s --dir /path/to/tidysum tidysum mcp",
        ),
        h(
          "p",
          { class: "muted small" },
          "Then ask it to “carry out my approved Tidysum actions”. The tidysum-actions skill in the repo tells it how.",
        ),
      ),
    ),
  );
}

// Cash --------------------------------------------------------------------------------------

function apyLadder(a) {
  const rows = [
    { you: true, name: "Now", sub: tidyName(a.institution_name), apy: a.current.effective_apy },
    ...a.alternatives.slice(0, 4).map((alt) => ({
      name: alt.name,
      sub: tidyName(alt.provider),
      apy: alt.apy,
      gain: alt.annual_gain,
      alt,
      picked: alt.product_id === a.chosen_product_id,
    })),
  ];
  let maxBp = 1n;
  for (const r of rows) if (cents(r.apy) > maxBp) maxBp = cents(r.apy);
  return h(
    "div",
    { class: "ladder" },
    rows.map((r, i) =>
      h(
        "div",
        {
          class: `rung ${r.you ? "is-you" : ""} ${i === 1 ? "is-best" : ""} ${r.picked ? "is-picked" : ""}`,
        },
        h(
          "div",
          { class: "rung-name" },
          h(
            "div",
            { class: "rung-title" },
            r.alt?.source_url
              ? h(
                  "a",
                  {
                    href: r.alt.source_url,
                    target: "_blank",
                    rel: "noreferrer",
                    title: `${r.alt.name} rates, as of ${day(r.alt.rates_as_of)}`,
                  },
                  r.name,
                )
              : r.name,
          ),
          h(
            "div",
            { class: "rung-sub" },
            r.sub,
            r.picked
              ? h(
                  "span",
                  { class: "tag-pick", title: "The bank you picked for this account" },
                  "Your pick",
                )
              : null,
            r.alt?.requires
              ? h(
                  "span",
                  {
                    class: "tag-cond",
                    title: `Needs: ${r.alt.requires}. Without that, +${usd(r.alt.annual_gain_without_conditions)} a year.`,
                  },
                  "conditions",
                )
              : null,
            r.alt?.stale
              ? h(
                  "span",
                  {
                    class: "tag-cond",
                    title: `Last checked ${day(r.alt.verified_on)}. Confirm before you move money.`,
                  },
                  "rate may be old",
                )
              : null,
          ),
        ),
        h(
          "div",
          { class: "rung-bar" },
          h("i", {
            style: { width: `${Math.max(2, (Number(cents(r.apy)) / Number(maxBp)) * 100)}%` },
          }),
        ),
        h("div", { class: "rung-apy num" }, pct(r.apy)),
        h(
          "div",
          { class: "rung-gain num" },
          r.you
            ? h("span", { class: "muted" }, `${usd0(a.current.annual_interest)}/yr`)
            : `+${usd0(r.gain)}/yr`,
        ),
      ),
    ),
  );
}

function accountCard(a) {
  const name = accountLabel(a.account_name, a.institution_name);
  const fees = cents(a.current.annual_fees);
  return h(
    "article",
    { class: "panel acct" },
    h(
      "div",
      { class: "acct-head" },
      h(
        "div",
        { class: "avatar avatar-lg", style: { "--hue": hue(a.institution_name || name) } },
        initials(a.institution_name || name),
      ),
      h(
        "div",
        { class: "acct-id" },
        h("h3", null, name),
        h("div", { class: "muted small" }, titleCase(String(a.subtype || "").replace(/_/g, " "))),
      ),
      h(
        "div",
        { class: "acct-balance" },
        h("div", { class: "num" }, usd(a.balance)),
        h(
          "small",
          { title: a.balance_basis },
          /^average/.test(a.balance_basis) ? "average balance" : "balance",
        ),
      ),
    ),
    fees > 0n ? notice("warn", `It also cost you ${usd(fees)} in fees over the last year.`) : null,
    a.skipped
      ? notice("info", `Not compared: ${prose(a.skipped)}.`)
      : a.alternatives.length === 0
        ? h("p", { class: "acct-ok" }, icon("check"), "Already the best rate Tidysum knows.")
        : // Under a dollar a year isn't worth a new account; say so instead of drawing a ladder.
          cents(a.alternatives[0].annual_gain) < 100n
          ? h(
              "p",
              { class: "acct-ok" },
              icon("check"),
              `Earns ${pct(a.current.effective_apy)}, within a dollar a year of the best rate Tidysum knows.`,
            )
          : apyLadder(a),
  );
}

const monthLabel = (m, withYear) =>
  toDate(`${m}-01`).toLocaleDateString(undefined, {
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });

/** One column per month: the average balance, with the part above the buffer in coral. */
function historyChart(r) {
  const buffer = cents(r.buffer);
  let max = buffer;
  for (const m of r.monthly) if (cents(m.average_balance) > max) max = cents(m.average_balance);
  if (max <= 0n) return null;
  const share = (c) => `${(Number(c < 0n ? 0n : c) / Number(max)) * 100}%`;
  const every = Math.max(1, Math.ceil(r.monthly.length / 6));
  const tick = (m, first) =>
    first || m.endsWith("-01") ? `${monthLabel(m)} ’${m.slice(2, 4)}` : monthLabel(m);
  return h(
    "div",
    { class: "hist", role: "img", "aria-label": "Average cash balance by month" },
    h(
      "div",
      { class: "hist-plot" },
      buffer > 0n
        ? h(
            "div",
            { class: "hist-buffer", style: { bottom: share(buffer) } },
            h("span", null, `${usd0(buffer)} buffer`),
          )
        : null,
      r.monthly.map((m) => {
        const idle = cents(m.average_idle);
        const total = cents(m.average_balance);
        return h(
          "div",
          {
            class: "hist-col",
            title:
              `${monthLabel(m.month, true)}: ${usd0(m.average_balance)} on average, ` +
              `${usd0(m.average_idle)} above the buffer. Earned ${usd(m.interest_earned)}, ` +
              `could have earned ${usd(m.would_have_earned)}.`,
          },
          h("i", { class: "hist-kept", style: { height: share(total - idle) } }),
          h("i", { class: "hist-idle", style: { height: share(idle) } }),
        );
      }),
    ),
    h(
      "div",
      { class: "hist-axis" },
      r.monthly.map((m, i) => h("span", null, i % every === 0 ? tick(m.month, i === 0) : "")),
    ),
  );
}

function historyTable(r) {
  return h(
    "div",
    { class: "hist-table-wrap" },
    h(
      "table",
      { class: "hist-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          ["Month", "Average cash", "Above buffer", "Earned", `At ${pct(r.best.apy)}`, "Lost"].map(
            (t) => h("th", null, t),
          ),
        ),
      ),
      h(
        "tbody",
        null,
        [...r.monthly]
          .reverse()
          .map((m) =>
            h(
              "tr",
              null,
              h(
                "td",
                null,
                monthLabel(m.month, true),
                m.days < 28 ? h("small", null, ` ${m.days}d`) : null,
              ),
              h("td", { class: "num" }, usd0(m.average_balance)),
              h("td", { class: "num" }, usd0(m.average_idle)),
              h("td", { class: "num" }, usd(m.interest_earned)),
              h("td", { class: "num" }, usd(m.would_have_earned)),
              h("td", { class: "num cost" }, usd(m.lost)),
            ),
          ),
      ),
    ),
  );
}

/** What the cash above the buffer has already cost, from rebuilt daily balances. */
function cashHistorySection() {
  const r = ok("cashHistory");
  if (!r?.window || !r.best) return null;
  const since = monthLabel(r.window.from.slice(0, 7), true);
  const lost = cents(r.lost);
  return h(
    "section",
    { class: "section" },
    sectionHead("Interest your idle cash missed"),
    h(
      "article",
      { class: "panel hist-panel" },
      h(
        "p",
        { class: "hist-headline" },
        lost > 0n
          ? [
              "About ",
              h("span", { class: "cost num" }, usd0(r.lost)),
              ` of interest missed since ${since}`,
            ]
          : "Your idle cash has earned about what a high-yield account would have paid.",
      ),
      historyChart(r),
      h(
        "ul",
        { class: "hist-legend" },
        h("li", { class: "is-kept" }, h("span", { class: "swatch" }), "Kept as your buffer"),
        h(
          "li",
          { class: "is-idle" },
          h("span", { class: "swatch" }),
          "Above it, earning next to nothing",
        ),
      ),
      h(
        "dl",
        { class: "facts" },
        fact("Average cash", usd0(r.average_balance)),
        fact("Above buffer", usd0(r.average_idle)),
        fact("Earned", usd(r.interest_earned)),
      ),
      fold("cash-history-months", "Month by month", historyTable(r)),
    ),
  );
}

function renderCash() {
  const root = $("#cash-body");
  const r = data.products;
  if (!r) return fill(root, skeleton(2));
  if (r.error) return fill(root, failed("Cash accounts", r));
  const loss = cents(r.annual_loss);
  const summary = h(
    "section",
    { class: "summary" },
    h(
      "div",
      null,
      h(
        "p",
        { class: "summary-title" },
        loss > 0n ? "Your cash could earn " : "Your cash is already in good places",
        loss > 0n ? h("span", { class: "gain num" }, usd0(loss)) : null,
        loss > 0n ? " more a year" : null,
      ),
      loss > 0n ? h("p", { class: "muted" }, `About ${usd0(r.monthly_loss)} a month.`) : null,
      r.benchmark
        ? h(
            "p",
            { class: "muted" },
            `For comparison, a 3-month US Treasury bill pays ${r.benchmark.yield}% ` +
              `(as of ${day(r.benchmark.as_of)}).`,
          )
        : null,
    ),
  );
  const history = ok("cashHistory");
  fill(
    root,
    r.accounts.length ? summary : null,
    h(
      "section",
      { class: "section" },
      r.accounts.length ? sectionHead("Your accounts") : null,
      r.accounts.length
        ? h("div", { class: "stack" }, r.accounts.map(accountCard))
        : empty(
            "bank",
            "No checking or savings linked",
            toConnections("Link a bank to see what your cash could earn."),
          ),
    ),
    cashHistorySection(),
    fineprint({
      notes: [...r.warnings, ...(history?.window ? history.warnings : [])],
      assumptions: [...r.assumptions, ...(history?.window ? history.assumptions : [])],
    }),
  );
}

// Investments -------------------------------------------------------------------------------
// Percentages only, by design: the owner doesn't want to see what the holdings are worth, or
// to be told to sell. The page says where new money goes.

/** "41%" from "41.2"; whole percents read faster and the drift band is points wide anyway. */
const share = (s) => `${Math.round(Number(s))}%`;

function mixRow(b) {
  // No warning colours: a bucket off target is just where new money goes, or where it doesn't.
  const tone = b.status === "ok" ? "pill-gain" : b.status === "under" ? "pill-accent" : "";
  const label = { ok: "On target", under: "Below target", over: "Above target" }[b.status];
  const scale = (s) => `${Math.min(100, Math.max(0, Number(s)))}%`;
  return h(
    "div",
    { class: "alloc-row" },
    h("span", { class: "alloc-name" }, b.label),
    h(
      "span",
      {
        class: "alloc-track",
        role: "img",
        "aria-label": `${b.label}: ${share(b.current)}, target ${share(b.target)}`,
      },
      h("i", { class: `alloc-fill is-${b.status}`, style: { width: scale(b.current) } }),
      h("b", {
        class: "alloc-target",
        style: { left: scale(b.target) },
        title: `Target ${share(b.target)}`,
      }),
    ),
    h("span", { class: "alloc-now num" }, share(b.current)),
    h("span", { class: "alloc-goal num muted" }, `of ${share(b.target)}`),
    h("span", { class: `pill ${tone}` }, label),
  );
}

/** One line of the new-money split: its share, the bucket, and the fund to buy. */
function splitRow(s, labels) {
  return h(
    "div",
    { class: "split-row" },
    h("span", { class: "split-pct num" }, `${s.percent}%`),
    h(
      "span",
      { class: "split-text" },
      h("span", { class: "split-name" }, labels[s.bucket] || s.bucket),
      s.buy
        ? h(
            "span",
            { class: "split-buy muted" },
            h("b", null, s.buy.ticker),
            s.buy.name ? ` ${tidyName(s.buy.name)}` : null,
          )
        : null,
    ),
  );
}

const ALLOCATION_EMPTY = {
  no_policy: [
    "Set a policy to get a target",
    "Run tidysum policy set with your target allocation.",
  ],
  no_target: ["No target allocation", "Add an allocation section to your policy."],
  no_holdings: ["No investments linked", toConnections("Link a brokerage to see your mix.")],
  nothing_classified: [
    "None of your holdings match a bucket",
    "Add their tickers to your policy or the security catalog.",
  ],
};

// Research sleeve: a small capped slice for investment-miner's picks, apart from the mix.
// Its scores are research evidence, never a target weight, and the page says so once.

/** The sleeve against its cap. The track runs to 1.25x the cap so the cap mark sits inside. */
function sleeveRow(sl) {
  const full = Number(sl.cap) * 1.25 || 1;
  const scale = (s) => `${Math.min(100, Math.max(0, (Number(s) / full) * 100))}%`;
  const label = sl.over
    ? "At its cap"
    : Number(sl.room) >= 0.5
      ? `Room for ${share(sl.room)}`
      : "At its cap";
  return h(
    "div",
    { class: "alloc-row" },
    h("span", { class: "alloc-name" }, "Sleeve"),
    h(
      "span",
      {
        class: "alloc-track",
        role: "img",
        "aria-label": `Research sleeve: ${share(sl.current)} of investable assets, cap ${share(sl.cap)}`,
      },
      h("i", { class: "alloc-fill is-under", style: { width: scale(sl.current) } }),
      h("b", {
        class: "alloc-target",
        style: { left: scale(sl.cap) },
        title: `Cap ${share(sl.cap)}`,
      }),
    ),
    h("span", { class: "alloc-now num" }, share(sl.current)),
    h("span", { class: "alloc-goal num muted" }, `cap ${share(sl.cap)}`),
    h("span", { class: `pill ${sl.over ? "" : "pill-accent"}` }, label),
  );
}

// Only the sleeve's own picks are marked: the page never says which single stocks you hold.
const HELD = { sleeve: "In your sleeve" };

function candidateRow(c) {
  return h(
    "div",
    { class: "cand-row" },
    h("span", { class: "cand-rank num muted" }, String(c.rank)),
    h(
      "span",
      { class: "cand-text" },
      h(
        "span",
        { class: "cand-name" },
        h("b", null, c.ticker),
        c.name ? h("span", { class: "muted" }, ` ${tidyName(c.name)}`) : null,
      ),
      h("span", { class: "cand-why muted" }, c.summary),
    ),
    HELD[c.held] ? h("span", { class: "pill" }, HELD[c.held]) : null,
  );
}

/** Institutional lists the owner switched to their biggest drops. */
const dropView = new Set();

function runMeta(run) {
  const when =
    run.age_days === 0 ? "today" : `${run.age_days} day${run.age_days === 1 ? "" : "s"} old`;
  const partial =
    run.status === "partial"
      ? ` · partial, ${run.fetched_pct === null ? "most" : `${run.fetched_pct}%`} of data fetched`
      : "";
  return `${dayShort(run.as_of)} · ${when}${partial}`;
}

function viewToggle(key) {
  const on = dropView.has(key);
  const pick = (drops) => () => {
    if (drops) dropView.add(key);
    else dropView.delete(key);
    render();
  };
  return h(
    "span",
    { class: "cand-toggle", role: "group", "aria-label": "Order" },
    h(
      "button",
      {
        class: "btn btn-sm btn-quiet",
        type: "button",
        "aria-pressed": String(!on),
        onclick: pick(false),
      },
      "Top picks",
    ),
    h(
      "button",
      {
        class: "btn btn-sm btn-quiet",
        type: "button",
        "aria-pressed": String(on),
        onclick: pick(true),
      },
      "Biggest drops",
    ),
  );
}

function researchList(l) {
  const key = `${l.product}:${l.label}`;
  const drops = l.biggest_drops?.length ? dropView.has(key) : false;
  const rows = drops ? l.biggest_drops : l.candidates;
  const top = rows.slice(0, 5);
  const rest = rows.slice(5);
  return h(
    "div",
    { class: "panel cand-list" },
    h(
      "div",
      { class: "cand-head" },
      h(
        "span",
        { class: "cand-heading" },
        h("span", { class: "cand-title" }, l.label),
        h("span", { class: "muted small" }, runMeta(l.run)),
      ),
      l.biggest_drops?.length ? viewToggle(key) : null,
    ),
    drops
      ? h(
          "p",
          { class: "cand-hint muted small" },
          "Funds' top conviction picks, furthest below their 52-week high first. Something to look into, not a bargain by itself.",
        )
      : null,
    top.map(candidateRow),
    rest.length
      ? fold(`research-${l.run.run_id}-${drops}`, `${rest.length} more`, rest.map(candidateRow))
      : null,
  );
}

/** One line on the newest scan, and a button to run a new one. */
function scanBar(r) {
  const scan = r.scan;
  if (!scan) return null;
  const inst = r.lists.filter((l) => l.product === "institutional");
  const newest = inst.map((l) => l.run).sort((a, b) => (a.as_of < b.as_of ? 1 : -1))[0];
  let text;
  if (scan.state === "running") {
    const pct = scan.pct ? ` ${scan.pct}%` : "";
    text = `Scanning ${scan.product === "assets" ? "the asset watchlist" : "what big funds hold"}…${pct}. Takes about 15 minutes; this page updates when it's done.`;
  } else if (scan.state === "unavailable") {
    text = "investment-miner isn't running, so a new scan can't start from here.";
  } else if (scan.last?.status === "failed") {
    text = `The last scan failed: ${scan.last.error || "no reason given"}.`;
  } else {
    text = newest
      ? `Latest fund scan: ${dayShort(newest.as_of)}${newest.age_days === 0 ? ", today" : ""}. The miner also scans every weekday evening.`
      : "No fund scan yet. The miner scans every weekday evening, or start one now.";
  }
  return h(
    "div",
    { class: "panel scan-bar" },
    h("span", { class: "muted small" }, text),
    scan.state === "idle"
      ? h(
          "button",
          {
            class: "btn btn-sm",
            type: "button",
            onclick: (ev) =>
              act(
                ev.currentTarget,
                () => api("/api/research/scan", {}),
                "Scan started. It takes about 15 minutes.",
                ["research"],
              ),
          },
          "Scan now",
        )
      : null,
  );
}

/** While a scan runs, and for a little while after it ends, check back so new picks appear. */
let researchPoll;
let researchAfterScan = 0;
let researchSeen;
function pollResearch(r) {
  // Once per response, not once per render.
  if (r === researchSeen) return;
  researchSeen = r;
  clearTimeout(researchPoll);
  const running = r?.scan?.state === "running";
  if (running) researchAfterScan = 8;
  else if (researchAfterScan > 0) researchAfterScan--;
  if (running || researchAfterScan > 0) researchPoll = setTimeout(() => load("research"), 10_000);
}

/** Heads-ups about the research: import problems, then each run's limitations and warnings. */
function researchNotes() {
  const r = ok("research");
  if (!r || r.state === "off") return [];
  return [
    ...r.warnings,
    ...new Set(r.lists.flatMap((l) => [...l.run.limitations, ...l.run.warnings])),
  ];
}

function researchSection() {
  const r = ok("research");
  pollResearch(r);
  if (!r || r.state === "off") return null;
  if (!r.sleeve && r.state === "no_runs" && !r.read && !r.scan) return null;
  const funds = r.lists.filter((l) => l.product === "institutional");
  const assets = r.lists.filter((l) => l.product !== "institutional");
  return h(
    "section",
    { class: "section" },
    sectionHead("Research sleeve", "investment-miner picks, apart from your mix"),
    r.sleeve
      ? h("div", { class: "panel alloc-list" }, sleeveRow(r.sleeve))
      : notice("info", "Add a research_sleeve to your policy to set its cap."),
    scanBar(r),
    r.stale
      ? notice(
          "warn",
          r.newest_run_age_days === null
            ? "No usable investment-miner run yet, so there are no current picks."
            : `The newest research run is ${r.newest_run_age_days} days old, so these picks may be out of date.`,
        )
      : null,
    // The picks are research to look into, not a to-do: one tap away, not on the page.
    funds.length
      ? h(
          "div",
          { class: "cand-more" },
          fold(
            "research-funds",
            `What big funds are buying (${plural(funds.length, "list")})`,
            funds.map(researchList),
          ),
        )
      : null,
    assets.length
      ? h(
          "div",
          { class: "cand-more" },
          fold(
            "research-assets",
            "Asset watchlist: funds and metals furthest below their highs",
            assets.map(researchList),
          ),
        )
      : null,
    h("p", { class: "muted small" }, r.note),
  );
}

function renderInvestments() {
  const root = $("#investments-body");
  const r = data.allocation;
  // Investment advice is only on for users managing their own money.
  $("#nav-investments").hidden = !r || !!r.error || r.state === "off";
  if (!r) return fill(root, skeleton(2));
  if (r.error) return fill(root, failed("Investments", r));
  if (r.state === "off") return fill(root, empty("info", "Investments are off for this account"));
  if (r.state !== "ready") {
    const [title, text] = ALLOCATION_EMPTY[r.state] || ["Nothing to show", null];
    return fill(root, empty("up", title, text));
  }
  const labels = Object.fromEntries(r.buckets.map((b) => [b.key, b.label]));
  const nm = r.new_money;
  const catchUp = nm.basis === "catch_up";
  // Calm by design: what to do with the next paycheck leads, nothing asks you to sell, and
  // nothing shows amounts or ups and downs.
  const summary = h(
    "section",
    { class: "summary split" },
    h(
      "div",
      null,
      h("p", { class: "summary-title" }, "Where new money goes"),
      h(
        "p",
        { class: "muted" },
        catchUp
          ? "Each paycheck you invest, split like this, until your mix reaches its target. Nothing needs selling."
          : "Your mix is on target, so new money follows it.",
      ),
    ),
    h(
      "div",
      { class: "split-list" },
      // Biggest share first: "mostly this, some of that".
      [...nm.split]
        .sort((a, b) => Number(b.percent) - Number(a.percent))
        .map((s) => splitRow(s, labels)),
    ),
  );
  fill(
    root,
    summary,
    h(
      "section",
      { class: "section" },
      sectionHead("Your mix", "Now, and the target"),
      h("div", { class: "panel alloc-list" }, r.buckets.map(mixRow)),
    ),
    Number(r.unclassified.percent) > 0
      ? h(
          "p",
          { class: "muted small" },
          `${share(r.unclassified.percent)} of your holdings fit no bucket and are left out.`,
        )
      : null,
    researchSection(),
    fineprint({
      notes: [
        ...(r.counted_once || []).map(
          (o) =>
            `${accountLabel(o.account, o.institution)} is part of ${accountLabel(o.inside, o.inside_institution)}, so it counts once.`,
        ),
        ...(catchUp && nm.catch_up
          ? [
              `The split changes as your mix moves. It takes new money worth about ${nm.catch_up}% of what you have invested today to reach the target, and then new money follows the target.`,
            ]
          : []),
        ...researchNotes(),
      ],
    }),
  );
}

// Plan --------------------------------------------------------------------------------------
// The owner's own written plan. The server lays it out (src/plan/layout.ts) as sections of plain
// text runs, never HTML, so nothing in it can run on the page. Each section is a fold with a
// one-line preview; a long item shows its first sentence and keeps the rest behind "More".

function planSpans(spans) {
  return spans.map((sp) => {
    if (sp.href && /^https?:\/\//i.test(sp.href)) {
      return h(
        "a",
        { class: "inline-link", href: sp.href, target: "_blank", rel: "noopener noreferrer" },
        sp.text,
      );
    }
    if (sp.code) return h("code", null, sp.text);
    if (sp.bold) return h("strong", null, sp.text);
    return sp.text;
  });
}

/** The first sentence, then the rest one click away. */
function planText(head, more) {
  const wrap = h("span", { class: "plan-text" }, h("span", null, planSpans(head)));
  if (!more.length) return wrap;
  const label = h("span", null, "More");
  const btn = h(
    "button",
    {
      type: "button",
      class: "plan-more-btn",
      "aria-expanded": "false",
      onclick: () => {
        const open = wrap.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", String(open));
        label.textContent = open ? "Less" : "More";
      },
    },
    label,
    icon("chevron"),
  );
  wrap.append(h("span", { class: "plan-more" }, " ", planSpans(more)), " ", btn);
  return wrap;
}

/** Bar colors: the money-style color for a bucket it names, otherwise one of four spares. */
function mixClasses(rows) {
  const used = new Set();
  let spare = 0;
  return rows.map((r) => {
    if (r.key && !used.has(r.key)) {
      used.add(r.key);
      return `seg-${r.key}`;
    }
    return `seg-n${spare++ % 4}`;
  });
}

function planBar(rows, classes) {
  return h(
    "div",
    {
      class: "style-bar",
      role: "img",
      "aria-label": rows.map((r) => `${r.percent}% ${r.label}`).join(", "),
    },
    rows.map((r, i) => h("span", { class: `seg ${classes[i]}`, style: { flexGrow: r.percent } })),
  );
}

function planMix(p) {
  const classes = mixClasses(p.rows);
  return h(
    "div",
    { class: "plan-mix" },
    planBar(p.rows, classes),
    h(
      "ul",
      { class: "plan-mix-rows" },
      p.rows.map((r, i) =>
        h(
          "li",
          null,
          h("span", { class: `swatch ${classes[i]}` }),
          h("span", { class: "num" }, `${r.percent}%`),
          h("span", { class: "plan-mix-label" }, r.label),
          r.note.length ? h("span", { class: "plan-mix-note" }, planSpans(r.note)) : null,
        ),
      ),
    ),
  );
}

function planItems(p) {
  return h(
    p.ordered ? "ol" : "ul",
    {
      class: `plan-items ${p.ordered ? "is-ordered" : ""}`,
      style: p.ordered ? { counterReset: `plan-step ${p.start - 1}` } : null,
    },
    p.items.map((it) =>
      h(
        "li",
        null,
        h(
          "div",
          { class: "plan-item" },
          it.tag
            ? h("span", { class: `plan-tag ${/^now\b/i.test(it.tag) ? "is-now" : ""}` }, it.tag)
            : null,
          planText(it.head, it.more),
        ),
      ),
    ),
  );
}

function planTable(p) {
  return h(
    "div",
    { class: "plan-table-wrap" },
    h(
      "table",
      { class: "plan-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          p.header.map((c) => h("th", null, planSpans(c))),
        ),
      ),
      h(
        "tbody",
        null,
        p.rows.map((r) =>
          h(
            "tr",
            null,
            r.map((c) => h("td", null, planSpans(c))),
          ),
        ),
      ),
    ),
  );
}

function planPart(p) {
  switch (p.type) {
    case "heading":
      return h("h3", null, planSpans(p.spans));
    case "note":
      return p.title
        ? h(
            "div",
            { class: "plan-callout" },
            h("strong", null, p.title),
            h("p", null, planText(p.head, p.more)),
          )
        : h("p", { class: "plan-note" }, planText(p.head, p.more));
    case "items":
      return planItems(p);
    case "mix":
      return planMix(p);
    case "pairs":
      return h(
        "dl",
        { class: "plan-pairs", "aria-label": p.header.join(" and ") },
        p.rows.flatMap((r) => [h("dt", null, planSpans(r.key)), h("dd", null, planSpans(r.value))]),
      );
    case "table":
      return planTable(p);
    default:
      return null;
  }
}

/** An icon for a section from the words in its title; a book when none fits. */
const PLAN_ICONS = [
  [/mission|purpose|vision|why/i, "flag"],
  [/stand|status|snapshot|today|where i am/i, "pin"],
  [/next|to-?do|steps|actions/i, "list"],
  [/goal/i, "target"],
  [/mix|allocation|portfolio/i, "pie"],
  [/dollar|order|priorit|flow|budget/i, "split"],
  [/rule|principle/i, "shield"],
  [/account/i, "bank"],
  [/calendar|schedule|when/i, "calendar"],
  [/against|avoid|rejected|won.t/i, "ban"],
];
const planIcon = (title) => PLAN_ICONS.find(([re]) => re.test(title))?.[1] ?? "book";

function planPreview(preview) {
  if (preview.mix) {
    const classes = mixClasses(preview.mix);
    return h(
      "span",
      { class: "plan-acc-mix" },
      planBar(preview.mix, classes),
      h(
        "span",
        { class: "plan-acc-legend" },
        preview.mix.map((r, i) =>
          h(
            "span",
            null,
            h("span", { class: `swatch ${classes[i]}` }),
            h("span", { class: "num" }, `${r.percent}%`),
            ` ${r.label}`,
          ),
        ),
      ),
    );
  }
  return preview.text ? h("span", { class: "plan-acc-preview" }, preview.text) : null;
}

// Which sections are open, by title, kept in this browser.
const PLAN_OPEN_KEY = "tidysum.plan.open";
let planOpenSet = null;
function planOpen() {
  if (!planOpenSet) {
    try {
      planOpenSet = new Set(JSON.parse(localStorage.getItem(PLAN_OPEN_KEY) || "[]"));
    } catch {
      planOpenSet = new Set();
    }
  }
  return planOpenSet;
}
function savePlanOpen() {
  try {
    localStorage.setItem(PLAN_OPEN_KEY, JSON.stringify([...planOpen()]));
  } catch {
    // Private windows: the folds just start closed next time.
  }
}

function planSection(sec, onToggle) {
  const d = h(
    "details",
    { class: "plan-acc", open: planOpen().has(sec.title) },
    h(
      "summary",
      null,
      h("span", { class: "plan-acc-icon" }, icon(planIcon(sec.title))),
      h(
        "span",
        { class: "plan-acc-main" },
        h("span", { class: "plan-acc-title" }, sec.title),
        planPreview(sec.preview),
      ),
      sec.count ? h("span", { class: "plan-acc-count" }, String(sec.count)) : h("span"),
      h("span", { class: "plan-acc-chev" }, icon("chevron")),
    ),
    h("div", { class: "plan-acc-body" }, sec.parts.map(planPart)),
  );
  d.addEventListener("toggle", () => {
    if (d.open) planOpen().add(sec.title);
    else planOpen().delete(sec.title);
    savePlanOpen();
    onToggle();
  });
  return d;
}

// Money styles ------------------------------------------------------------------------------
// Well-known ways of running money. Picking one fills the policy's rules (buffer, cards, debt,
// target mix); the owner can tweak any of them afterwards. Each card shows the mix as a bar and
// the key rules as chips; everything else is one click away in Details.

/** The age typed, or the one the owner's current style was set up with. */
const currentAge = () => styleAge ?? ok("styles")?.current?.age ?? null;

function styleMix(mix) {
  if (!mix?.length) {
    return h("div", { class: "style-mix is-empty" }, h("span", null, "Keeps your current mix"));
  }
  return h(
    "div",
    { class: "style-mix" },
    h(
      "div",
      {
        class: "style-bar",
        role: "img",
        "aria-label": mix.map((m) => `${m.percent}% ${m.label}`).join(", "),
      },
      mix.map((m) => h("span", { class: `seg seg-${m.key}`, style: { flexGrow: m.percent } })),
    ),
    h(
      "ul",
      { class: "style-legend" },
      mix.map((m) =>
        h(
          "li",
          null,
          h("span", { class: `swatch seg-${m.key}` }),
          h("span", { class: "num" }, `${m.percent}%`),
          m.label,
        ),
      ),
    ),
  );
}

function styleChips(g) {
  if (!g) return null;
  const chips = [
    [icon("shield"), g.cash],
    g.while_in_debt ? [icon("down"), g.while_in_debt] : null,
    g.debt ? [icon("arrow"), g.debt] : null,
    g.cards ? [icon("card"), g.cards] : null,
  ].filter(Boolean);
  return h(
    "ul",
    { class: "style-chips" },
    chips.map(([ic, text]) => h("li", null, ic, text)),
  );
}

function ageInput(style) {
  const input = h("input", {
    type: "number",
    min: "18",
    max: "90",
    inputmode: "numeric",
    class: "style-age",
    placeholder: "Age",
    "aria-label": `Your age, for ${style.name}`,
    value: currentAge() ?? "",
  });
  input.addEventListener("change", () => {
    const n = Number(input.value);
    styleAge = Number.isInteger(n) && n >= 18 && n <= 90 ? n : null;
    if (!styleAge && input.value) toast("Enter an age from 18 to 90.", "error");
    load("styles");
  });
  return h(
    "label",
    { class: "style-mix is-empty style-age-row" },
    h("span", null, "Bonds match your age"),
    h("span", { class: "style-age-field" }, input),
  );
}

/** "Cash buffer  3 months of spending  instead of $5,000", no strikethrough. */
function changeRows(changes) {
  return h(
    "dl",
    { class: "style-diff" },
    changes.flatMap((c) => [
      h("dt", null, c.rule),
      h(
        "dd",
        null,
        h("strong", null, c.to),
        h("span", { class: "muted" }, ` instead of ${c.from}`),
      ),
    ]),
  );
}

function sourcesLine(style) {
  return h(
    "p",
    { class: "small muted" },
    "Sources: ",
    style.sources.flatMap((src, i) => [
      i ? ", " : "",
      h(
        "a",
        { class: "inline-link", href: src.url, target: "_blank", rel: "noopener noreferrer" },
        src.title,
      ),
    ]),
  );
}

async function useStyle(button, style) {
  const lines = style.changes.map((c) => `${c.rule}: ${c.to}`).join("\n");
  const yes = await confirmDialog(
    `Use ${style.name}?`,
    `${lines}\n\nYour accounts, limits and research sleeve stay as they are. You can change any rule later.`,
    "Use this style",
    "primary",
  );
  if (!yes) return;
  act(
    button,
    () =>
      api("/api/policy/style", {
        id: style.id,
        ...(style.needs_age && currentAge() ? { age: currentAge() } : {}),
      }),
    `Now using ${style.name}.`,
    ["styles", "actions", "mis", "allocation"],
  );
}

function useButton(style, current, cls = "btn-sm") {
  const isCurrent = current?.id === style.id;
  if (!style.changes?.length) return null;
  return h(
    "button",
    {
      type: "button",
      class: `btn ${cls} ${isCurrent || cls ? "" : "btn-primary"}`,
      onclick: (e) => useStyle(e.currentTarget, style),
    },
    isCurrent ? "Reset to this style" : "Use this style",
  );
}

/** Everything behind a style, in a dialog, so the cards stay short. */
function openStyleDetails(style, current) {
  const close = () => dialog.close();
  const pick = useButton(style, current, "");
  if (pick) {
    const run = pick.onclick;
    pick.onclick = (e) => {
      close();
      run(e);
    };
  }
  const dialog = h(
    "dialog",
    { class: "dialog style-dialog", "aria-label": style.name },
    h(
      "header",
      { class: "style-dialog-head" },
      h("div", null, h("h2", null, style.name), h("p", { class: "muted small" }, style.advocates)),
      h(
        "button",
        { type: "button", class: "btn btn-quiet btn-icon", "aria-label": "Close", onclick: close },
        "✕",
      ),
    ),
    h("p", null, style.summary),
    style.changes?.length
      ? h("section", null, h("h3", null, "What changes for you"), changeRows(style.changes))
      : null,
    h(
      "section",
      null,
      h("h3", null, "The rules, and how Tidysum follows them"),
      h(
        "ul",
        { class: "style-rules" },
        style.rules.map((r) =>
          h("li", null, h("strong", null, r.rule), h("span", null, r.applied)),
        ),
      ),
    ),
    style.left_to_you.length
      ? h("section", null, h("h3", null, "Left to you and your AI"), bullets(style.left_to_you))
      : null,
    sourcesLine(style),
    pick ? h("div", { class: "dialog-actions" }, pick) : null,
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function styleCard({ name, who, tagline, selected, badge, body, chips, actions }) {
  return h(
    "article",
    { class: `panel style-card ${selected ? "is-current" : ""}` },
    h(
      "header",
      { class: "style-head" },
      h("div", null, h("h3", null, name), who ? h("p", { class: "style-who" }, who) : null),
      selected ? h("span", { class: "pill pill-accent style-badge" }, icon("check"), badge) : null,
    ),
    h("p", { class: "style-tagline" }, tagline),
    body,
    chips,
    actions ? h("footer", { class: "style-foot" }, actions) : null,
  );
}

/** What the owner runs on now: their own rules or a style, with its mix and key rules. */
function styleNow(now, mine) {
  const tweaks = now?.tweaks ?? [];
  return h(
    "div",
    { class: "panel style-now" },
    h(
      "div",
      { class: "style-now-name" },
      h("span", { class: "style-now-label" }, icon("check"), "Now using"),
      h("strong", null, now ? now.name : "Your own rules"),
      tweaks.length
        ? h(
            "span",
            { class: "muted small" },
            `With your changes: ${tweaks.map((t) => `${t.rule.toLowerCase()} ${t.to}`).join(", ")}`,
          )
        : h("span", { class: "muted small" }, now ? now.advocates : "Rules you set yourself"),
    ),
    styleMix(mine.mix),
    styleChips(mine),
  );
}

function stylePanel() {
  const r = data.styles;
  if (!r) return skeleton(1);
  if (r.error) return failed("Money styles", r);
  const now = r.current;
  const cards = r.styles.map((s) => {
    const selected = now?.id === s.id;
    return styleCard({
      name: s.name,
      who: s.advocates,
      tagline: s.tagline,
      selected,
      badge: "Current",
      body: s.needs_age && !s.result?.mix ? ageInput(s) : styleMix(s.result?.mix),
      chips: styleChips(s.result),
      actions: [
        selected ? null : useButton(s, now),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-sm btn-quiet",
            onclick: () => openStyleDetails(s, now),
          },
          "Details",
        ),
      ],
    });
  });
  return h(
    "section",
    { class: "styles" },
    sectionHead("Money style", "Pick one to fill in your rules. Change any rule later."),
    r.mine ? styleNow(now, r.mine) : null,
    h("div", { class: "style-grid" }, cards),
    h("p", { class: "muted small style-note" }, r.note),
  );
}

function renderPlan() {
  const root = $("#plan-body");
  const r = data.plan;
  const styles = stylePanel();
  $("#nav-plan").hidden = !ok("plan") && !ok("styles");
  if (!r) return fill(root, styles, skeleton(3));
  if (r.error) return fill(root, styles, failed("Plan", r));
  if (r.state !== "ready") {
    return fill(
      root,
      styles,
      empty(
        "info",
        "No written plan yet",
        "Write one in Markdown and run tidysum plan set <file>.",
      ),
    );
  }
  const toggleAll = h("button", { type: "button", class: "btn btn-sm btn-quiet plan-toggle-all" });
  const syncToggle = () => {
    const all = folds.length && folds.every((d) => d.open);
    toggleAll.textContent = all ? "Close all" : "Open all";
  };
  const folds = r.sections.map((sec) => planSection(sec, syncToggle));
  toggleAll.onclick = () => {
    const open = !folds.every((d) => d.open);
    for (const d of folds) d.open = open;
  };
  syncToggle();
  const when = r.reviewed
    ? `Reviewed ${day(r.reviewed)}`
    : `Updated ${day(r.updated_at.slice(0, 10))}`;
  fill(
    root,
    styles,
    h(
      "div",
      { class: "section-head plan-top" },
      h("h2", null, "Your written plan"),
      h("span", { class: "hint" }, when),
      folds.length > 1 ? toggleAll : null,
    ),
    r.intro.length ? h("div", { class: "plan-intro" }, r.intro.map(planPart)) : null,
    folds.length ? h("div", { class: "panel plan-accs" }, folds) : null,
  );
}

// Cards -------------------------------------------------------------------------------------

function heldCardRow(card, catalog) {
  const assumed = card.identified_by === "assumed";
  const skipped = assumed && notListed().has(card.account_id);
  const name = accountLabel(card.account_name, card.institution_name);
  return h(
    "div",
    { class: `held ${assumed && !skipped ? "is-question" : ""}` },
    h(
      "div",
      {
        class: "card-art",
        style: { "--hue": hue(`${card.institution_name} ${card.account_name}`) },
      },
      h("span", null, initials(tidyName(card.institution_name) || name)),
    ),
    h(
      "div",
      { class: "held-id" },
      h("div", { class: "held-name" }, name),
      card.pick
        ? h("div", { class: "held-sub" }, `Pick ${card.pick.choice} as ${card.pick.label}`)
        : null,
      assumed
        ? h(
            "div",
            { class: "held-sub" },
            skipped
              ? "Not in Tidysum's list yet, so counted as 1% back"
              : h(
                  "span",
                  { class: "warn" },
                  `Bank calls it “${reportedName(card)}”. Counted as 1% back until you pick it.`,
                ),
          )
        : null,
    ),
    cardPicker(card, catalog, { compact: true }),
  );
}

function renderCards() {
  const root = $("#cards-body");
  const r = data.cards;
  if (!r) return fill(root, skeleton(2));
  if (r.error) return fill(root, failed("Credit cards", r));
  if (!r.held_cards.length && !r.spending.by_category.length) {
    return fill(
      root,
      empty("card", "No credit cards linked", toConnections("Link a card to see what it earns.")),
    );
  }
  const gain = cents(r.recommended_wallet.annual_gain);

  const summary = h(
    "section",
    { class: "summary" },
    h(
      "div",
      null,
      h(
        "p",
        { class: "summary-title" },
        gain > 0n ? "The right cards would earn you " : "No new card would pay for itself",
        gain > 0n ? h("span", { class: "gain num" }, usd0(gain)) : null,
        gain > 0n ? " more a year" : null,
      ),
      gain > 0n
        ? h(
            "p",
            { class: "muted" },
            `With ${r.recommended_wallet.cards
              .map((c) => c.name)
              .join(", ")
              .replace(/, ([^,]*)$/, " and $1")}.`,
          )
        : h("p", { class: "muted" }, "Your cards already fit how you spend."),
    ),
    h(
      "div",
      { class: "stats" },
      stat("Rewards now", `${usd0(r.rewards.current)}/yr`),
      stat("Spent on cards", usd0(r.spending.on_cards)),
      cents(r.spending.from_bank_card_payable) > 0n
        ? stat("Could go on a card", usd0(r.spending.from_bank_card_payable), "cost")
        : null,
    ),
  );

  const rows = r.spending.by_category.slice(0, 8).map((c) => ({
    ...c,
    onCards: cents(c.on_cards),
    fromBank: cents(c.from_bank),
  }));
  // BigInt, so no Math.max.
  let max = 1n;
  for (const c of rows) if (c.onCards + c.fromBank > max) max = c.onCards + c.fromBank;
  const width = (c) => `${(Number(c) / Number(max)) * 100}%`;
  const spend = h(
    "div",
    { class: "panel spend" },
    rows.map((c) =>
      h(
        "div",
        { class: `spend-row ${c.card_payable ? "" : "is-not-payable"}` },
        h(
          "div",
          { class: "spend-label" },
          c.label,
          c.card_payable ? null : h("small", null, c.card_note || "usually can't go on a card"),
        ),
        h(
          "div",
          {
            class: "spend-bar",
            title: `${usd(c.onCards)} on cards, ${usd(c.fromBank)} from your bank`,
          },
          h("span", { class: "on-cards", style: { width: width(c.onCards) } }),
          h("span", { class: "from-bank", style: { width: width(c.fromBank) } }),
        ),
        h("div", { class: "spend-total num" }, usd0(c.onCards + c.fromBank)),
      ),
    ),
  );

  const recs = r.recommendations.slice(0, 6).map((c) =>
    h(
      "article",
      { class: "panel rec" },
      h(
        "div",
        { class: "rec-head" },
        h(
          "div",
          { class: "card-art card-art-lg", style: { "--hue": hue(`${c.issuer} ${c.name}`) } },
          h("span", null, initials(c.issuer)),
        ),
        h(
          "div",
          { class: "big-figure gain" },
          h("span", { class: "num" }, `+${usd0(c.annual_gain)}`),
          h("small", null, "a year, after fees"),
        ),
      ),
      h("h3", null, c.name),
      h(
        "div",
        { class: "muted small" },
        `${c.issuer} · ${cents(c.annual_fee) === 0n ? "No annual fee" : `${usd0(c.annual_fee)} annual fee`}`,
      ),
      c.earns_on.length
        ? h(
            "div",
            { class: "chips" },
            earnsSummary(c.earns_on)
              .slice(0, 3)
              .map((t) => h("span", { class: "chip-static" }, t)),
          )
        : null,
      c.requires
        ? h(
            "p",
            { class: "muted small" },
            `Needs ${c.requires.replace(/^[A-Z]/, (x) => x.toLowerCase())}.`,
          )
        : null,
      h(
        "div",
        { class: "rec-foot" },
        extLink("Terms", c.source_url),
        c.notes
          ? h(
              "span",
              { class: "rec-note", tabindex: "0", "aria-label": prose(c.notes) },
              icon("info"),
              h("span", { class: "rec-note-text" }, prose(c.notes)),
            )
          : null,
      ),
    ),
  );

  const interest = r.warnings.filter(isInterestWarning);
  const notes = r.warnings.filter((w) => !isCardQuestion(w) && !isInterestWarning(w));

  fill(
    root,
    summary,
    interest.map((w) => h("div", { class: "section" }, notice("danger", prose(w)))),
    h(
      "section",
      { class: "section" },
      sectionHead("Your cards"),
      r.held_cards.length
        ? h(
            "div",
            { class: "panel list" },
            r.held_cards.map((k) => heldCardRow(k, r.catalog_cards)),
          )
        : empty(
            "card",
            "No credit cards linked",
            toConnections("Link a card to see what it earns."),
          ),
    ),
    rows.length
      ? h(
          "section",
          { class: "section" },
          h(
            "div",
            { class: "section-head" },
            h("h2", null, "Where you spend"),
            h(
              "div",
              { class: "key" },
              h("span", null, h("i"), "On cards"),
              h("span", null, h("i", { class: "light" }), "From your bank"),
              h(
                "span",
                { class: "muted" },
                `${dayShort(r.window.from)} – ${dayShort(r.window.to)}`,
              ),
            ),
          ),
          spend,
        )
      : null,
    h(
      "section",
      { class: "section" },
      sectionHead("Cards that would pay you more"),
      recs.length
        ? h("div", { class: "rec-grid" }, recs)
        : empty(
            "check",
            "Your cards are already the best fit",
            "No card Tidysum knows would pay for itself on your spending.",
            null,
            true,
          ),
    ),
    fineprint({ notes, assumptions: r.assumptions }),
  );
}

// Shell -------------------------------------------------------------------------------------

function renderBadges() {
  const r = ok("items");
  const items = r?.items || [];
  const broken = items.filter(needsAttention);
  const lastSync = items
    .map((it) => it.lastSyncedAt)
    .filter(Boolean)
    .sort()
    .pop();
  // Connections live behind this chip: how fresh the data is, or what needs fixing.
  const sync = $("#sync");
  sync.classList.toggle("is-warn", broken.length > 0);
  sync.classList.toggle("is-ok", !broken.length && !!lastSync);
  $("#sync-text").textContent = broken.length
    ? broken.length === 1
      ? `${institutionName(broken[0].institutionName)} needs you`
      : `${broken.length} connections need you`
    : lastSync
      ? `Synced ${ago(lastSync)}`
      : r && !items.length
        ? "Link accounts"
        : "Connections";
  sync.title = "Connections";
  const actions = ok("actions");
  const waiting =
    (actions?.queue || []).filter((a) => a.state === "proposed").length +
    (actions?.in_progress || []).filter((a) => a.progress?.status === "your_turn").length;
  const badge = $("#badge-actions");
  badge.hidden = waiting === 0;
  badge.textContent = String(waiting);
}

/** Every report carries the same no-referral disclosure; the page shows it once, at the foot. */
function renderDisclosure() {
  const text = ["mis", "products", "cards"].map((k) => ok(k)?.disclosure).find(Boolean);
  $("#disclosure").textContent = text ? prose(text) : "";
}

/**
 * The demo says what it is: a made-up person at real banks, with their public rates as of a day,
 * and online, a snapshot that can't change.
 */
function renderDemoBar() {
  const items = ok("items");
  const demo = items?.demo;
  const bar = $("#demo-bar");
  bar.hidden = !demo;
  if (!demo || bar.dataset.kind === String(demo)) return;
  bar.dataset.kind = String(demo);
  fill(
    bar,
    h("strong", {}, "Demo. "),
    "A made-up person at real banks",
    items.demo_checked_on
      ? `, with their public rates as of ${day(items.demo_checked_on)}. `
      : ". ",
    "Not affiliated with any institution named. ",
    demo === "online" ? "Read-only here; run pnpm demo to approve." : "Approve and skip freely.",
  );
}

function render() {
  renderDemoBar();
  renderDisclosure();
  renderActions();
  renderConnections();
  renderCash();
  renderCards();
  renderInvestments();
  renderPlan();
  renderBadges();
}

/** Lets entrance animations play for a moment, so re-renders after a click don't replay them. */
let enterTimer;
function enter() {
  document.body.classList.add("is-entering");
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => document.body.classList.remove("is-entering"), 1200);
}

let currentView = null;
function route() {
  const hash = location.hash.slice(1);
  // In-page anchors (like #in-progress) stay on Actions, the home page; so do old #overview links.
  const view = VIEWS.includes(hash) ? hash : "actions";
  if (view === currentView) return;
  currentView = view;
  enter();
  for (const s of document.querySelectorAll("[data-view]")) s.hidden = s.dataset.view !== view;
  // The no-referral disclosure is about ranking products, so it sits under the pages that rank
  // them. The not-advice line under it shows on every page.
  $("#disclosure").hidden = !["actions", "cash", "cards"].includes(view);
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  // On a phone the tabs scroll sideways; keep the open one in sight.
  const tabs = $(".tabs");
  const tab = tabs.querySelector('[aria-current="page"]');
  if (tab && tabs.scrollWidth > tabs.clientWidth) {
    const t = tab.getBoundingClientRect();
    const box = tabs.getBoundingClientRect();
    tabs.scrollLeft += t.left - box.left - (box.width - t.width) / 2;
  }
  const title = document.querySelector(`[data-view="${view}"]`)?.dataset.title;
  document.title = view === "actions" ? "Tidysum" : `${title} · Tidysum`;
  if (VIEWS.includes(hash)) window.scrollTo({ top: 0 });
}

for (const el of document.querySelectorAll("[data-icon]")) el.replaceWith(icon(el.dataset.icon));
setTheme(savedTheme());
$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}
});
// The one place new institutions are linked. Every other page points here.
$("#link-new").addEventListener("click", (ev) => startLink(ev.currentTarget));
window.addEventListener("hashchange", route);
route();
render();
load(...ALL).then(enter);
