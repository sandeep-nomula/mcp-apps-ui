# FX RFQ: an MCP App for live bank quotes in Claude

Ask Claude for FX prices ("get me prices to buy 1m USD/GBP from bank1 and bank2"). Claude calls this MCP server,
and the reply shows an interactive **quote board inline in the chat**:

- prices from **bank1, bank2 and bank3** tick live over a **WebSocket**
- big-figure/pips display, up/down flashes, sparklines, spread in bp, a validity countdown per quote, and a **BEST** marker
- the user clicks **Buy/Sell @ price** on the quote they want. The server checks the quote is still valid, books the trade, and the board turns into a **trade ticket**
- Claude is told about the booked trade (`ui/update-model-context`), and the user can post the confirmation to the chat
- `list_trades` shows an inline **trade blotter** of accepted trades

Built on the official MCP Apps extension ([`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps)) and the MCP TypeScript SDK.

## How it works

```
Claude ──tools/call request_fx_quotes──▶ MCP server (/mcp) ──▶ RFQ engine (simulated banks)
   │                                                               │ quote ticks
   │ renders ui://fx-rfq/quote-board.html in a sandboxed iframe    ▼
   └──▶ Quote board ◀────────── WebSocket ws://…/prices ──── price stream
             │
             └─ app.callServerTool(accept_quote) ──▶ (through Claude) ──▶ MCP server books the trade
```

| Tool | Visible to | Purpose |
|---|---|---|
| `request_fx_quotes` | model + app | Opens an RFQ (pair, side, amount, optional `dealtCurrency`, `banks`) and renders the quote board |
| `list_trades` | model + app | Inline blotter of accepted trades |
| `accept_quote` | **app only** | Books a trade on a specific quote. Claude itself cannot call it, so a trade only happens when the user clicks |
| `get_rfq_quotes` | app only | Polling fallback when the WebSocket can't connect |
| `cancel_rfq` | app only | Stops the stream without trading |

The UI resource declares `_meta.ui.csp.connectDomains` so the host lets the iframe open the WebSocket.
**If the socket can't connect, the board polls `get_rfq_quotes` through Claude instead** (the footer shows
"Streaming via MCP (polling)"), so prices keep ticking either way.

Quotes are valid for 2.5 to 4 s depending on the bank (with a 250 ms grace period), and an RFQ expires after 2 minutes. An expired quote
is rejected with "price moved, pick a live price". Pricing is simulated: a random walk on mid rates, and each bank has its own
spread, size premium, skew and refresh rate. Supported currencies are USD, GBP, EUR, JPY, CHF, AUD and CAD.

## Run it

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

The server listens on `http://localhost:3001`:

- `POST /mcp`: MCP endpoint (Streamable HTTP, stateless)
- `ws://localhost:3001/prices`: price stream
- `http://localhost:3001/dev/`: **local test host** that renders the app the way Claude does (sandboxed iframe + `AppBridge`), so you can try the whole flow without Claude

Check a running server end to end (tools, resource, WebSocket ticks, accept, double-accept rejection):

```bash
npm run smoke
```

## Connect it to Claude

### Claude Desktop (local, stdio)

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude:

```json
{
  "mcpServers": {
    "fx-rfq": {
      "command": "node",
      "args": ["D:\\code\\mcp-apps-ui\\dist\\server\\server\\index.js", "--stdio"]
    }
  }
}
```

Claude Desktop may start **several** stdio copies of the server and send the model's and the board's tool calls to
different ones. So every stdio copy is a thin proxy to **one shared price engine** on port 3001: the first copy
starts the engine in its own process, and later copies (or a running `npm start`) reuse it. If the copy hosting the
engine exits, the next request starts a new one. Use `scripts/restart-claude-with-fx-rfq.ps1` to add the entry: Claude
rewrites `claude_desktop_config.json` while running, so the entry must be added while Claude is closed.

### Claude on the web / remote connector

Claude connects to remote MCP servers over HTTPS, so expose the server through a tunnel and tell it its public URL.
The UI then uses `wss://` on the same host:

```bash
cloudflared tunnel --url http://localhost:3001
```

```bash
PUBLIC_BASE_URL=https://<your-tunnel>.trycloudflare.com npm start
```

Then add `https://<your-tunnel>.trycloudflare.com/mcp` as a custom connector in Claude (Settings → Connectors).

> **Why a public URL for the WebSocket:** Claude renders apps in a sandboxed iframe on its own origin. Chromium-based
> browsers treat a page on a public origin connecting to `localhost` as a Local Network Access request, which can be
> blocked or need a permission prompt. A public `wss://` URL avoids that. Without one the board still works, through polling.

Then ask Claude something like:

> Get me live prices to buy 1,000,000 USD/GBP from bank1 and bank2

> Sell 250k EUR/USD, all banks

> Show my accepted trades

## Project layout

```
src/
  shared/types.ts        RFQ / quote / trade types and the WebSocket protocol
  server/
    index.ts             Entry: engine over HTTP, or --stdio proxy for Claude Desktop
    engine.ts            Shared price engine: /mcp, /prices WebSocket, /dev on one port
    proxy.ts             stdio MCP server that forwards to the shared engine
    mcp.ts               MCP tools and the ui:// resource (registerAppTool / registerAppResource)
    rfq-engine.ts        RFQs, per-bank quote streams, quote validation, trade booking
    market.ts            Simulated mid-rate random walk
    price-stream.ts      WebSocket fan-out of quote ticks
    config.ts            Port, public URL, CSP connect domains
  ui/                    The MCP App (vanilla TS, bundled into one HTML file by vite-plugin-singlefile)
    quote-board.ts       App lifecycle, quote board, trade ticket, blotter
    price-feed.ts        WebSocket client with MCP polling fallback
  dev-host/              Local stand-in for Claude, for testing the app in a browser
scripts/smoke-test.mjs   End-to-end check against a running server
```

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | HTTP + WebSocket port |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Origin the UI uses for the WebSocket and CSP (`https://…` makes it use `wss://`) |

Trades and RFQs are kept in memory and reset when the server restarts.
