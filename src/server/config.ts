import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (where package.json lives), whether running from src/ via tsx or from dist/. */
function findRoot(dir = path.dirname(fileURLToPath(import.meta.url))): string {
  if (existsSync(path.join(dir, "package.json"))) return dir;
  const parent = path.dirname(dir);
  if (parent === dir) throw new Error("package.json not found");
  return findRoot(parent);
}
const root = findRoot();

const port = Number(process.env.PORT ?? 3001);

/**
 * Public origin of this server as the browser inside Claude sees it.
 * Locally that is http://localhost:3001; behind a tunnel set PUBLIC_BASE_URL
 * (e.g. https://fx-rfq.example.trycloudflare.com) so the UI uses wss://.
 */
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const publicWsBase = publicBaseUrl.replace(/^http/, "ws");

export const config = {
  port,
  /** Where stdio instances reach the shared engine (always local, even behind a tunnel). */
  engineUrl: `http://localhost:${port}`,
  uiHtmlPath: path.join(root, "dist/ui/quote-board.html"),
  devHostDir: path.join(root, "dist/dev-host"),
  publicBaseUrl,
  wsUrl: `${publicWsBase}/prices`,
  /** Origins the UI iframe may connect to (CSP connect-src). */
  connectDomains: [publicBaseUrl, publicWsBase],
};
