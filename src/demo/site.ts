import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The page's GET endpoints, as the page asks for them; each is saved as api/<name>.json. */
export const SNAPSHOT_ENDPOINTS = [
  "items",
  "proposals",
  "actions",
  "misallocations",
  "products",
  "cash-history",
  "cards",
  "allocation",
  "research",
  "plan",
  "styles",
  "activity",
] as const;

const WEB = new URL("../server/web/", import.meta.url);

/**
 * Loaded before app.js on the online demo: answers the page's API calls from the saved snapshot,
 * and refuses every change, since a static page has nowhere to keep one.
 */
const STATIC_JS = `// Tidysum's online demo: the real page, reading a saved snapshot of a made-up household.
(() => {
  const realFetch = window.fetch.bind(window);
  const readOnly = () =>
    new Response(
      JSON.stringify({
        error: "This online demo is read-only. Run pnpm demo on your computer to approve, skip and reorder.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  window.fetch = (input, init) => {
    const path = typeof input === "string" ? input : "";
    if (!path.startsWith("/api/")) return realFetch(input, init);
    if (init && init.method && init.method !== "GET") return Promise.resolve(readOnly());
    const name = path.slice(5).split("?")[0];
    return realFetch(\`api/\${name}.json\`);
  };
})();
`;

/**
 * Writes the online demo into `outDir`: the page with relative asset paths, the snapshot loader,
 * and one JSON file per endpoint, read from `request` (the demo app, in process).
 */
export async function writeDemoSite(
  request: (path: string) => Promise<Response>,
  outDir: string,
): Promise<void> {
  await mkdir(join(outDir, "api"), { recursive: true });
  for (const name of SNAPSHOT_ENDPOINTS) {
    const res = await request(`/api/${name}`);
    if (!res.ok) throw new Error(`/api/${name}: ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    // The page tells visitors this copy can't be changed.
    if (name === "items") body.demo = "online";
    await writeFile(join(outDir, "api", `${name}.json`), JSON.stringify(body));
  }
  const html = (await readFile(new URL("index.html", WEB), "utf8"))
    .replaceAll('href="/favicon.svg"', 'href="favicon.svg"')
    .replaceAll('src="/favicon.svg"', 'src="favicon.svg"')
    .replace('href="/app.css"', 'href="app.css"')
    .replace(
      '<script src="/app.js"></script>',
      '<script src="static.js"></script>\n    <script src="app.js"></script>',
    );
  if (!html.includes('src="static.js"')) throw new Error("index.html changed: can't add static.js");
  await writeFile(join(outDir, "index.html"), html);
  await writeFile(join(outDir, "static.js"), STATIC_JS);
  for (const f of ["app.js", "app.css", "favicon.svg", "source-serif-4.woff2"]) {
    await copyFile(new URL(f, WEB), join(outDir, f));
  }
}
