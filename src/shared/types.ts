// Types shared between the MCP server and the inline UI.

export type Side = "BUY" | "SELL";
export type RfqStatus = "OPEN" | "ACCEPTED" | "EXPIRED" | "CANCELLED";

export interface BankInfo {
  id: string;
  name: string;
  /** Brand colour used by the UI for the bank badge. */
  color: string;
}

export interface Quote {
  quoteId: string;
  rfqId: string;
  bank: string;
  bankName: string;
  /** Sequence number per bank within an RFQ; increases on every tick. */
  seq: number;
  bid: number;
  ask: number;
  mid: number;
  /** The price the client deals at for this RFQ's side (ask for BUY, bid for SELL). */
  price: number;
  spreadBps: number;
  issuedAt: number;
  validUntil: number;
}

export interface Rfq {
  rfqId: string;
  pair: string;
  base: string;
  quote: string;
  side: Side;
  amount: number;
  dealtCurrency: string;
  contraCurrency: string;
  banks: BankInfo[];
  decimals: number;
  status: RfqStatus;
  createdAt: number;
  expiresAt: number;
  tradeId?: string;
}

export interface Trade {
  tradeId: string;
  rfqId: string;
  quoteId: string;
  bank: string;
  bankName: string;
  pair: string;
  side: Side;
  dealtCurrency: string;
  amount: number;
  contraCurrency: string;
  contraAmount: number;
  rate: number;
  decimals: number;
  executedAt: number;
  valueDate: string;
  status: "BOOKED";
}

/** structuredContent returned by request_fx_quotes / get_rfq_quotes. */
export interface RfqView {
  kind: "rfq";
  rfq: Rfq;
  quotes: Quote[];
  trade?: Trade;
  stream: { wsUrl: string };
  serverTime: number;
}

/** structuredContent returned by list_trades. */
export interface BlotterView {
  kind: "blotter";
  trades: Trade[];
}

/**
 * True when the client ends up buying the pair's base currency: BUY in the base
 * currency, or SELL of the quote currency. They then pay the ask, so lower is better.
 */
export function clientBuysBase(rfq: Pick<Rfq, "side" | "dealtCurrency" | "base">): boolean {
  return (rfq.side === "BUY") === (rfq.dealtCurrency === rfq.base);
}

export type AcceptResult =
  | { kind: "accepted"; trade: Trade; rfq: Rfq }
  | { kind: "rejected"; reason: "QUOTE_EXPIRED" | "RFQ_CLOSED" | "UNKNOWN_QUOTE" | "UNKNOWN_RFQ"; message: string; rfq?: Rfq };

// ---- WebSocket protocol -------------------------------------------------

export type ClientMessage =
  | { type: "subscribe"; rfqId: string }
  | { type: "unsubscribe"; rfqId: string }
  | { type: "ping"; t: number };

export type ServerMessage =
  | { type: "snapshot"; rfq: Rfq; quotes: Quote[]; serverTime: number }
  | { type: "quote"; quote: Quote; serverTime: number }
  | { type: "status"; rfq: Rfq; trade?: Trade }
  | { type: "error"; rfqId?: string; message: string }
  | { type: "pong"; t: number; serverTime: number };
