// Adds the fx-rfq server to Claude Desktop's config. Run it while Claude Desktop is fully quit:
// the app rewrites this file from memory while running and would drop the entry.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const running = execSync('tasklist /FI "IMAGENAME eq claude.exe" /NH', { encoding: "utf8" }).toLowerCase().includes("claude.exe");
if (running) {
  console.error("Claude Desktop is still running. Quit it from the system tray (right-click the Claude icon > Quit) and run this again.");
  process.exit(1);
}

const serverJs = path.resolve(__dirname, "..", "dist", "server", "server", "index.js");
if (!fs.existsSync(serverJs)) {
  console.error(`Build output not found at ${serverJs}. Run "npm run build" first.`);
  process.exit(1);
}

// The Microsoft Store (MSIX) build reads its own copy under Packages\Claude_*\LocalCache, so update both.
const appData = process.env.APPDATA ?? path.join(require("os").homedir(), "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA ?? path.join(require("os").homedir(), "AppData", "Local");
const packages = path.join(localAppData, "Packages");
const files = [
  path.join(appData, "Claude", "claude_desktop_config.json"),
  ...(fs.existsSync(packages) ? fs.readdirSync(packages) : [])
    .filter((d) => d.startsWith("Claude_"))
    .map((d) => path.join(packages, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json")),
];

for (const file of files) {
  if (!fs.existsSync(path.dirname(file))) continue;
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
  cfg.mcpServers = { ...(cfg.mcpServers || {}), "fx-rfq": { command: process.execPath, args: [serverJs, "--stdio"] } };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`Added fx-rfq to ${file}`);
}
console.log("Now start Claude Desktop.");
