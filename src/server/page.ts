import { readFileSync } from "node:fs";

// The admin page: what is costing the user money, the proposals that would fix it, connections
// (link a new one, repair or remove one), and the account and card comparisons behind the
// findings. Plain HTML, CSS and JS in ./web, read once at startup and served as separate files so
// the CSP can forbid inline scripts. No build step.

const read = (name: string) => readFileSync(new URL(`./web/${name}`, import.meta.url), "utf8");

export const INDEX_HTML = read("index.html");
export const APP_CSS = read("app.css");
export const APP_JS = read("app.js");
export const FAVICON_SVG = read("favicon.svg");
