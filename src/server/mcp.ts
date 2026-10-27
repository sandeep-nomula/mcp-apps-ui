import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { clientBuysBase, type BlotterView, type Quote, type Rfq, type RfqView, type Trade } from "../shared/types.js";
import { CURRENCIES } from "./market.js";
import { BANK_IDS, engine } from "./rfq-engine.js";
import { config } from "./config.js";

const UI_URI = "ui://fx-rfq/quote-board.html";

const fmtAmount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

function rfqView(rfq: Rfq, quotes: Quote[]): RfqView {
  return {
    kind: "rfq",
    rfq,
    quotes,
    trade: engine.tradeFor(rfq.rfqId),
    stream: { wsUrl: config.wsUrl },
    serverTime: Date.now(),
  };
}

function describeTrade(t: Trade) {
  return (
    `${t.tradeId}: ${t.side} ${fmtAmount(t.amount)} ${t.dealtCurrency} ${t.pair} @ ${t.rate.toFixed(t.decimals)} ` +
    `with ${t.bankName} (contra ${fmtAmount(t.contraAmount)} ${t.contraCurrency}), value date ${t.valueDate}`
  );
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "fx-rfq", version: "1.0.0" });

  registerAppResource(
    server,
    "FX Quote Board",
    UI_URI,
    {
      description: "Live streaming FX quotes from multiple banks with one-click accept.",
      _meta: { ui: { csp: { connectDomains: config.connectDomains }, prefersBorder: true } },
    },
    async () => ({
      contents: [
        {
          uri: UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(config.uiHtmlPath, "utf8"),
          _meta: { ui: { csp: { connectDomains: config.connectDomains }, prefersBorder: true } },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "request_fx_quotes",
    {
      title: "Request FX quotes",
      description:
        "Request live, streaming FX prices from several banks (bank1, bank2, bank3) for a currency pair, side and amount. " +
        "Opens an interactive quote board inline in the chat where prices tick in real time and the user can accept " +
        "the price they want. Only the user can accept a price, from the quote board; never claim a trade was done " +
        "unless the user accepted it. Example: BUY 1,000,000 USD/GBP.",
      inputSchema: {
        pair: z.string().describe(`Currency pair as BASE/QUOTE, e.g. "USD/GBP". Supported currencies: ${CURRENCIES.join(", ")}.`),
        side: z.enum(["BUY", "SELL"]).describe("Whether the user buys or sells the dealt currency."),
        amount: z.number().positive().describe("Notional amount in the dealt currency, e.g. 1000000."),
        dealtCurrency: z
          .string()
          .length(3)
          .optional()
          .describe("Currency the amount is expressed in. Defaults to the base currency of the pair."),
        banks: z
          .array(z.enum(BANK_IDS))
          .min(1)
          .optional()
          .describe("Banks to ask for prices. Defaults to all banks."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async (args) => {
      try {
        const { rfq, quotes } = engine.create(args);
        const best = [...quotes].sort((a, b) => (clientBuysBase(rfq) ? a.price - b.price : b.price - a.price))[0];
        const view = rfqView(rfq, quotes);
        return {
          structuredContent: view as unknown as Record<string, unknown>,
          content: [
            {
              type: "text",
              text:
                `RFQ ${rfq.rfqId} is live: ${rfq.side} ${fmtAmount(rfq.amount)} ${rfq.dealtCurrency} ${rfq.pair} ` +
                `from ${rfq.banks.map((b) => b.name).join(", ")}. Prices are streaming in the quote board shown to the user ` +
                `(initial best: ${best.bankName} @ ${best.price.toFixed(rfq.decimals)}). The user accepts a price there; ` +
                `the RFQ expires in ${Math.round((rfq.expiresAt - rfq.createdAt) / 1000)}s.`,
            },
          ],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );

  registerAppTool(
    server,
    "get_rfq_quotes",
    {
      title: "Get RFQ quotes",
      description: "Latest quotes and status for an RFQ. Used by the quote board when the WebSocket stream is unavailable.",
      inputSchema: { rfqId: z.string() },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } },
    },
    async ({ rfqId }) => {
      const rfq = engine.get(rfqId);
      if (!rfq) return errorResult(`RFQ ${rfqId} not found.`);
      const view = rfqView(rfq, engine.latestQuotes(rfqId));
      return {
        structuredContent: view as unknown as Record<string, unknown>,
        content: [{ type: "text", text: `RFQ ${rfqId} is ${rfq.status}.` }],
      };
    },
  );

  registerAppTool(
    server,
    "accept_quote",
    {
      title: "Accept quote",
      description: "Accept a specific bank quote on an open RFQ and book the trade. Called by the quote board when the user clicks Accept.",
      inputSchema: { rfqId: z.string(), quoteId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      // App-only: trades are only ever booked by an explicit user click in the UI.
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } },
    },
    async ({ rfqId, quoteId }) => {
      const result = engine.accept(rfqId, quoteId);
      const text =
        result.kind === "accepted" ? `Trade booked. ${describeTrade(result.trade)}.` : `Quote rejected: ${result.message}`;
      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [{ type: "text", text }],
      };
    },
  );

  registerAppTool(
    server,
    "cancel_rfq",
    {
      title: "Cancel RFQ",
      description: "Stop streaming prices for an RFQ without trading.",
      inputSchema: { rfqId: z.string() },
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } },
    },
    async ({ rfqId }) => {
      const rfq = engine.cancel(rfqId);
      if (!rfq) return errorResult(`RFQ ${rfqId} not found.`);
      return {
        structuredContent: rfqView(rfq, []) as unknown as Record<string, unknown>,
        content: [{ type: "text", text: `RFQ ${rfqId} is ${rfq.status}.` }],
      };
    },
  );

  registerAppTool(
    server,
    "list_trades",
    {
      title: "List accepted trades",
      description: "Show the trades the user has accepted in this session as an inline trade blotter.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async () => {
      const trades = engine.listTrades();
      const view: BlotterView = { kind: "blotter", trades };
      return {
        structuredContent: view as unknown as Record<string, unknown>,
        content: [
          {
            type: "text",
            text: trades.length ? trades.map(describeTrade).join("\n") : "No trades have been accepted yet.",
          },
        ],
      };
    },
  );

  return server;
}
