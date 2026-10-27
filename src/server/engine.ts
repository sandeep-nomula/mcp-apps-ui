import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { attachPriceStream } from "./price-stream.js";
import { market } from "./market.js";
import { config } from "./config.js";

const log = (...args: unknown[]) => console.error("[fx-rfq]", ...args);

/**
 * The price engine: RFQ state, the MCP endpoint over HTTP and the WebSocket price
 * stream, all on one port. There is one engine per machine; every MCP client
 * (Claude's stdio instances via the proxy, or a remote connector) talks to it.
 *
 * Resolves true once listening, false if the port is already taken.
 */
export async function startEngine(): Promise<boolean> {
  const app = express();
  app.use(cors({ origin: "*", exposedHeaders: ["mcp-session-id"] }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, service: "fx-rfq", wsUrl: config.wsUrl, pid: process.pid }));

  // Stateless Streamable HTTP: one MCP server per request; RFQs and trades live in the shared engine.
  app.post("/mcp", async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log("MCP request failed", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").send("Method Not Allowed"));

  // Local test host that mimics Claude rendering the MCP App (see README).
  app.use("/dev", express.static(config.devHostDir));

  const httpServer = createServer(app);
  const listening = await new Promise<boolean>((resolve, reject) => {
    httpServer.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err)));
    httpServer.once("listening", () => resolve(true));
    httpServer.listen(config.port);
  });
  if (!listening) return false;

  attachPriceStream(httpServer);
  market.start();
  log(`Engine pid ${process.pid}`);
  log(`HTTP  ${config.publicBaseUrl}/mcp`);
  log(`WS    ${config.wsUrl}`);
  log(`Dev   ${config.publicBaseUrl}/dev/`);
  return true;
}

export async function engineIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${config.engineUrl}/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** Uses the running engine, or starts one in this process. */
export async function ensureEngine(): Promise<"remote" | "local"> {
  if (await engineIsUp()) return "remote";
  if (await startEngine()) return "local";
  // Lost a start-up race with another instance, which is now the engine.
  if (await engineIsUp()) return "remote";
  throw new Error(`Port ${config.port} is used by another program. Set PORT to a free port.`);
}
