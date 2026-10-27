import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureEngine, startEngine } from "./engine.js";
import { createProxyServer } from "./proxy.js";
import { config } from "./config.js";

const stdio = process.argv.includes("--stdio");
// In stdio mode stdout carries the MCP protocol, so all logging goes to stderr.
const log = (...args: unknown[]) => console.error("[fx-rfq]", ...args);

if (stdio) {
  // Claude Desktop launches this. Use the shared engine on config.port, starting it here if none is running.
  const mode = await ensureEngine();
  log(mode === "local" ? "Hosting the price engine in this process" : `Using the price engine at ${config.engineUrl}`);
  await createProxyServer().connect(new StdioServerTransport());
  log("MCP server running on stdio");
} else if (!(await startEngine())) {
  log(`Port ${config.port} is already in use (is another fx-rfq server running?).`);
  process.exit(1);
}
