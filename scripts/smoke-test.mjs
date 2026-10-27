// End-to-end check against a running server: MCP tools, UI resource, WebSocket stream, accept.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

const base = process.env.BASE_URL ?? "http://localhost:3001";
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base)));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => `${t.name}[${t._meta?.ui?.visibility ?? "model,app"}]`).join(", "));

const res = await client.readResource({ uri: "ui://fx-rfq/quote-board.html" });
const c = res.contents[0];
console.log("resource:", c.mimeType, `${c.text.length} bytes`, "csp:", JSON.stringify(c._meta?.ui?.csp));

const r = await client.callTool({ name: "request_fx_quotes", arguments: { pair: "USD/GBP", side: "BUY", amount: 1_000_000 } });
const view = r.structuredContent;
console.log("rfq:", view.rfq.rfqId, view.rfq.pair, view.quotes.map((q) => `${q.bank}=${q.price}`).join(" "));
console.log("text:", r.content[0].text);

const ticks = await new Promise((resolve, reject) => {
  const ws = new WebSocket(view.stream.wsUrl);
  const seen = [];
  ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", rfqId: view.rfq.rfqId })));
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.type === "quote") seen.push(`${msg.quote.bank}#${msg.quote.seq}=${msg.quote.price}`);
  });
  ws.on("error", reject);
  setTimeout(() => (ws.close(), resolve(seen)), 2500);
});
console.log(`ws ticks in 2.5s: ${ticks.length}`, ticks.slice(0, 6).join(" "));

const latest = (await client.callTool({ name: "get_rfq_quotes", arguments: { rfqId: view.rfq.rfqId } })).structuredContent;
const pick = latest.quotes[0];
const acc = await client.callTool({ name: "accept_quote", arguments: { rfqId: view.rfq.rfqId, quoteId: pick.quoteId } });
console.log("accept:", acc.content[0].text);

const stale = await client.callTool({ name: "accept_quote", arguments: { rfqId: view.rfq.rfqId, quoteId: pick.quoteId } });
console.log("double accept:", stale.content[0].text);

const blotter = await client.callTool({ name: "list_trades", arguments: {} });
console.log("trades:", blotter.content[0].text);
await client.close();
