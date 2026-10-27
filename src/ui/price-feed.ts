import type { Quote, Rfq, RfqView, ServerMessage, Trade } from "../shared/types";

export type FeedMode = "ws" | "poll" | "off";

export interface FeedHandlers {
  onSnapshot(rfq: Rfq, quotes: Quote[], serverTime: number): void;
  onQuote(quote: Quote, serverTime: number): void;
  onStatus(rfq: Rfq, trade?: Trade): void;
  onMode(mode: FeedMode): void;
  /** The server no longer knows this RFQ (e.g. it restarted). */
  onLost(message: string): void;
}

const POLL_MS = 750;
const WS_CONNECT_TIMEOUT_MS = 2500;
const MAX_WS_RETRIES = 3;

/**
 * Streams quotes for one RFQ over the server's WebSocket. If the socket can't
 * be opened (CSP, network, port clash) it falls back to polling the
 * app-only `get_rfq_quotes` MCP tool through the host.
 */
export class PriceFeed {
  private ws?: WebSocket;
  private pollTimer?: number;
  private retries = 0;
  private closed = false;
  private lastSeq = new Map<string, number>();

  constructor(
    private rfqId: string,
    private wsUrl: string,
    private poll: (rfqId: string) => Promise<RfqView | undefined>,
    private h: FeedHandlers,
  ) {}

  start() {
    this.connectWs();
  }

  stop() {
    this.closed = true;
    this.stopPolling();
    if (this.ws) {
      this.ws.onclose = null;
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "unsubscribe", rfqId: this.rfqId }));
        this.ws.close();
      } catch {
        /* already gone */
      }
    }
    this.h.onMode("off");
  }

  private connectWs() {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch {
      return this.fallback();
    }
    this.ws = ws;
    const timeout = window.setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close();
    }, WS_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      window.clearTimeout(timeout);
      ws.send(JSON.stringify({ type: "subscribe", rfqId: this.rfqId }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      switch (msg.type) {
        case "snapshot":
          this.retries = 0;
          this.stopPolling();
          this.h.onMode("ws");
          msg.quotes.forEach((q) => this.lastSeq.set(q.bank, q.seq));
          this.h.onSnapshot(msg.rfq, msg.quotes, msg.serverTime);
          break;
        case "quote":
          this.emitQuote(msg.quote, msg.serverTime);
          break;
        case "status":
          this.h.onStatus(msg.rfq, msg.trade);
          if (msg.rfq.status !== "OPEN") this.stop();
          break;
        case "error":
          // The socket reached a server that doesn't know this RFQ
          // (e.g. another instance owns the port): use MCP polling instead.
          ws.onclose = null;
          ws.close();
          this.fallback(true);
          break;
      }
    };
    ws.onclose = () => {
      window.clearTimeout(timeout);
      if (this.closed) return;
      this.fallback();
      if (this.retries++ < MAX_WS_RETRIES) window.setTimeout(() => this.connectWs(), 1000 * this.retries);
    };
  }

  private emitQuote(q: Quote, serverTime: number) {
    if ((this.lastSeq.get(q.bank) ?? 0) >= q.seq) return;
    this.lastSeq.set(q.bank, q.seq);
    this.h.onQuote(q, serverTime);
  }

  private fallback(permanent = false) {
    if (this.closed) return;
    if (permanent) this.retries = MAX_WS_RETRIES + 1;
    if (this.pollTimer !== undefined) return;
    this.h.onMode("poll");
    const tick = async () => {
      if (this.closed) return;
      try {
        const view = await this.poll(this.rfqId);
        if (view) {
          view.quotes.forEach((q) => this.emitQuote(q, view.serverTime));
          if (view.rfq.status !== "OPEN") {
            this.h.onStatus(view.rfq, view.trade);
            return this.stop();
          }
        }
      } catch (e) {
        const message = (e as Error).message ?? "";
        if (/not found/i.test(message)) {
          this.stop();
          return this.h.onLost(message);
        }
        /* otherwise transient; try again next tick */
      }
      if (this.pollTimer !== undefined) this.pollTimer = window.setTimeout(tick, POLL_MS);
    };
    this.pollTimer = window.setTimeout(tick, 0);
  }

  private stopPolling() {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }
}
