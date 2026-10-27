import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/types.js";
import { engine } from "./rfq-engine.js";

/** Streams quote ticks for the RFQs each socket subscribed to. */
export function attachPriceStream(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/prices" });
  // ws re-emits the HTTP server's listen errors; the HTTP server's own handler decides what to do.
  wss.on("error", () => {});
  const subscribers = new Map<string, Set<WebSocket>>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (rfqId: string, msg: ServerMessage) => {
    subscribers.get(rfqId)?.forEach((ws) => send(ws, msg));
  };

  engine.on("quote", (quote) => broadcast(quote.rfqId, { type: "quote", quote, serverTime: Date.now() }));
  engine.on("status", (rfq, trade) => {
    broadcast(rfq.rfqId, { type: "status", rfq, trade });
    subscribers.delete(rfq.rfqId);
  });

  wss.on("connection", (ws, req) => {
    // stderr ends up in Claude's mcp-server-fx-rfq.log, handy when checking the iframe really connects.
    console.error(`[fx-rfq] WebSocket connected from origin ${req.headers.origin ?? "(none)"}`);
    const mine = new Set<string>();
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(ws, { type: "error", message: "Invalid JSON" });
      }
      switch (msg.type) {
        case "subscribe": {
          const rfq = engine.get(msg.rfqId);
          if (!rfq) {
            console.error(`[fx-rfq] WebSocket subscribe for unknown RFQ ${msg.rfqId}`);
            return send(ws, { type: "error", rfqId: msg.rfqId, message: "Unknown RFQ" });
          }
          console.error(`[fx-rfq] WebSocket streaming ${rfq.rfqId}`);
          send(ws, { type: "snapshot", rfq, quotes: engine.latestQuotes(rfq.rfqId), serverTime: Date.now() });
          if (rfq.status !== "OPEN") return send(ws, { type: "status", rfq, trade: engine.tradeFor(rfq.rfqId) });
          if (!subscribers.has(rfq.rfqId)) subscribers.set(rfq.rfqId, new Set());
          subscribers.get(rfq.rfqId)!.add(ws);
          mine.add(rfq.rfqId);
          break;
        }
        case "unsubscribe":
          subscribers.get(msg.rfqId)?.delete(ws);
          mine.delete(msg.rfqId);
          break;
        case "ping":
          send(ws, { type: "pong", t: msg.t, serverTime: Date.now() });
          break;
      }
    });
    ws.on("close", () => mine.forEach((id) => subscribers.get(id)?.delete(ws)));
  });

  return wss;
}
