import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { clientBuysBase, type AcceptResult, type BankInfo, type Quote, type Rfq, type Side, type Trade } from "../shared/types.js";
import { type Currency, decimalsFor, market, parsePair } from "./market.js";

interface BankProfile extends BankInfo {
  /** Base spread in basis points for small tickets. */
  spreadBps: number;
  /** Extra spread in bps per USD 1m notional. */
  sizeBpsPerMillion: number;
  /** Fixed skew of the bank's mid in bps (positive = higher prices). */
  skewBps: number;
  /** Random range of time between two quote refreshes. */
  tickMs: [number, number];
  /** How long a quote stays executable. */
  validityMs: number;
}

export const BANKS: BankProfile[] = [
  { id: "bank1", name: "Bank1", color: "#2f6fed", spreadBps: 1.4, sizeBpsPerMillion: 0.12, skewBps: 0.25, tickMs: [350, 900], validityMs: 3000 },
  { id: "bank2", name: "Bank2", color: "#d9480f", spreadBps: 1.1, sizeBpsPerMillion: 0.18, skewBps: -0.2, tickMs: [450, 1200], validityMs: 2500 },
  { id: "bank3", name: "Bank3", color: "#0c8f6a", spreadBps: 1.8, sizeBpsPerMillion: 0.08, skewBps: 0.05, tickMs: [600, 1500], validityMs: 4000 },
];
export const BANK_IDS = BANKS.map((b) => b.id) as [string, ...string[]];

const RFQ_TTL_MS = 120_000;
/** Grace period for network latency when a quote is accepted right at expiry. */
const ACCEPT_GRACE_MS = 250;
/** How many past quotes per bank are kept so slightly older clicks can still be honoured. */
const QUOTE_HISTORY = 6;

interface RfqState {
  rfq: Rfq;
  base: Currency;
  quote: Currency;
  /** Latest quotes per bank, newest last. */
  history: Map<string, Quote[]>;
  /** Next tick timer per bank. */
  ticks: Map<string, NodeJS.Timeout>;
  expiry?: NodeJS.Timeout;
}

export interface NewRfqInput {
  pair: string;
  side: Side;
  amount: number;
  dealtCurrency?: string;
  banks?: string[];
}

type Events = {
  quote: [Quote];
  status: [Rfq, Trade | undefined];
};

function round(n: number, decimals: number) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function shortId(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Spot value date: T+2 business days (weekends skipped, holidays ignored). */
function spotValueDate(from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let added = 0;
  while (added < 2) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

export class RfqEngine extends EventEmitter<Events> {
  private rfqs = new Map<string, RfqState>();
  private trades: Trade[] = [];

  create(input: NewRfqInput): { rfq: Rfq; quotes: Quote[] } {
    const { base, quote } = parsePair(input.pair);
    const dealt = (input.dealtCurrency ?? base).toUpperCase();
    if (dealt !== base && dealt !== quote) {
      throw new Error(`dealtCurrency must be ${base} or ${quote}.`);
    }
    if (!(input.amount > 0)) throw new Error("amount must be positive.");
    const requested = input.banks?.length ? input.banks : BANK_IDS;
    const profiles = BANKS.filter((b) => requested.includes(b.id));
    if (profiles.length === 0) throw new Error(`No known banks in ${requested.join(", ")}.`);

    const now = Date.now();
    const rfq: Rfq = {
      rfqId: shortId("RFQ"),
      pair: `${base}/${quote}`,
      base,
      quote,
      side: input.side,
      amount: input.amount,
      dealtCurrency: dealt,
      contraCurrency: dealt === base ? quote : base,
      banks: profiles.map(({ id, name, color }) => ({ id, name, color })),
      decimals: decimalsFor(base, quote),
      status: "OPEN",
      createdAt: now,
      expiresAt: now + RFQ_TTL_MS,
    };
    const state: RfqState = { rfq, base, quote, history: new Map(), ticks: new Map() };
    this.rfqs.set(rfq.rfqId, state);

    // Every bank answers immediately, then keeps streaming on its own cadence.
    for (const bank of profiles) {
      this.publish(state, bank);
      this.schedule(state, bank);
    }
    state.expiry = setTimeout(() => this.close(rfq.rfqId, "EXPIRED"), RFQ_TTL_MS);
    state.expiry.unref();

    return { rfq, quotes: this.latestQuotes(rfq.rfqId) };
  }

  get(rfqId: string): Rfq | undefined {
    return this.rfqs.get(rfqId)?.rfq;
  }

  latestQuotes(rfqId: string): Quote[] {
    const state = this.rfqs.get(rfqId);
    if (!state || state.rfq.status !== "OPEN") return [];
    return [...state.history.values()].map((h) => h[h.length - 1]).filter(Boolean);
  }

  tradeFor(rfqId: string): Trade | undefined {
    return this.trades.find((t) => t.rfqId === rfqId);
  }

  listTrades(): Trade[] {
    return [...this.trades].reverse();
  }

  cancel(rfqId: string): Rfq | undefined {
    return this.close(rfqId, "CANCELLED");
  }

  accept(rfqId: string, quoteId: string): AcceptResult {
    const state = this.rfqs.get(rfqId);
    if (!state) return { kind: "rejected", reason: "UNKNOWN_RFQ", message: `RFQ ${rfqId} not found.` };
    const { rfq } = state;
    if (rfq.status !== "OPEN") {
      return { kind: "rejected", reason: "RFQ_CLOSED", message: `RFQ is ${rfq.status.toLowerCase()}.`, rfq };
    }
    const quote = [...state.history.values()].flat().find((q) => q.quoteId === quoteId);
    if (!quote) return { kind: "rejected", reason: "UNKNOWN_QUOTE", message: "Quote not recognised.", rfq };
    if (Date.now() > quote.validUntil + ACCEPT_GRACE_MS) {
      return { kind: "rejected", reason: "QUOTE_EXPIRED", message: `${quote.bankName} quote expired. Pick a live price.`, rfq };
    }

    const now = new Date();
    const dealtIsBase = rfq.dealtCurrency === rfq.base;
    const contraAmount = round(dealtIsBase ? rfq.amount * quote.price : rfq.amount / quote.price, 2);
    const trade: Trade = {
      tradeId: shortId("TRD"),
      rfqId,
      quoteId,
      bank: quote.bank,
      bankName: quote.bankName,
      pair: rfq.pair,
      side: rfq.side,
      dealtCurrency: rfq.dealtCurrency,
      amount: rfq.amount,
      contraCurrency: rfq.contraCurrency,
      contraAmount,
      rate: quote.price,
      decimals: rfq.decimals,
      executedAt: now.getTime(),
      valueDate: spotValueDate(now),
      status: "BOOKED",
    };
    this.trades.push(trade);
    rfq.tradeId = trade.tradeId;
    this.close(rfqId, "ACCEPTED", trade);
    return { kind: "accepted", trade, rfq };
  }

  private close(rfqId: string, status: Exclude<Rfq["status"], "OPEN">, trade?: Trade): Rfq | undefined {
    const state = this.rfqs.get(rfqId);
    if (!state) return undefined;
    if (state.rfq.status === "OPEN") {
      state.ticks.forEach(clearTimeout);
      state.ticks.clear();
      clearTimeout(state.expiry);
      state.rfq.status = status;
      this.emit("status", state.rfq, trade);
    }
    return state.rfq;
  }

  private schedule(state: RfqState, bank: BankProfile) {
    const [min, max] = bank.tickMs;
    const t = setTimeout(() => {
      if (state.rfq.status !== "OPEN") return;
      this.publish(state, bank);
      this.schedule(state, bank);
    }, min + Math.random() * (max - min));
    t.unref();
    state.ticks.set(bank.id, t);
  }

  private publish(state: RfqState, bank: BankProfile) {
    const { rfq } = state;
    const mid = market.mid(state.base, state.quote);
    const usdNotional = market.toUsd(rfq.amount, rfq.dealtCurrency as Currency);
    const jitter = (Math.random() - 0.5) * 0.3;
    const spreadBps = Math.max(0.6, bank.spreadBps + bank.sizeBpsPerMillion * (usdNotional / 1e6) + jitter);
    const bankMid = mid * (1 + bank.skewBps / 1e4);
    const half = (bankMid * spreadBps) / 2e4;
    const bid = round(bankMid - half, rfq.decimals);
    const ask = round(bankMid + half, rfq.decimals);
    const history = state.history.get(bank.id) ?? [];
    const now = Date.now();
    const quote: Quote = {
      quoteId: shortId("Q"),
      rfqId: rfq.rfqId,
      bank: bank.id,
      bankName: bank.name,
      seq: (history[history.length - 1]?.seq ?? 0) + 1,
      bid,
      ask,
      mid: round(mid, rfq.decimals + 1),
      price: clientBuysBase(rfq) ? ask : bid,
      spreadBps: Math.round(spreadBps * 100) / 100,
      issuedAt: now,
      validUntil: now + bank.validityMs,
    };
    history.push(quote);
    if (history.length > QUOTE_HISTORY) history.shift();
    state.history.set(bank.id, history);
    this.emit("quote", quote);
  }
}

export const engine = new RfqEngine();
