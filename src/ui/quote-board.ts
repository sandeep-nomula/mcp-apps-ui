import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { clientBuysBase, type AcceptResult, type BlotterView, type Quote, type Rfq, type RfqView, type Trade } from "../shared/types";
import { PriceFeed, type FeedMode } from "./price-feed";

const SPARK_POINTS = 40;

// ---------------------------------------------------------------- helpers

const root = document.getElementById("root")!;
const toastEl = document.getElementById("toast")!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...children);
  return el;
}

const fmtAmount = (n: number, ccy?: string) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + (ccy ? ` ${ccy}` : "");

/** Splits 0.75213 into big figure "0.75", pips "21" and fractional pip "3". */
function priceParts(price: number, decimals: number) {
  const s = price.toFixed(decimals);
  return { big: s.slice(0, -3), pips: s.slice(-3, -1), frac: s.slice(-1) };
}

let toastTimer: number | undefined;
function toast(message: string, kind: "info" | "error" = "info") {
  toastEl.textContent = message;
  toastEl.className = `show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.className = ""), 3200);
}

function structured<T>(result: { structuredContent?: unknown; isError?: boolean; content?: unknown }): T | undefined {
  if (result.isError) {
    const text = (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
    throw new Error(text ?? "Tool call failed");
  }
  return result.structuredContent as T | undefined;
}

// ---------------------------------------------------------------- MCP App

const app = new App({ name: "FX Quote Board", version: "1.0.0" }, {}, { autoResize: true });

function applyHostContext(ctx: Partial<McpUiHostContext> | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

let board: QuoteBoard | undefined;

app.ontoolinput = ({ arguments: args }) => {
  // Arguments arrive before the result: show what is being priced right away.
  const a = args as { pair?: string; side?: string; amount?: number; dealtCurrency?: string } | undefined;
  if (a?.pair && a.side && a.amount) {
    root.querySelector(".title .muted")!.textContent =
      `Requesting ${a.side} ${fmtAmount(a.amount, a.dealtCurrency ?? a.pair.slice(0, 3).toUpperCase())} ${a.pair.toUpperCase()}…`;
  }
};

app.ontoolresult = (result) => {
  const view = result.structuredContent as unknown as RfqView | BlotterView | undefined;
  if (result.isError || !view) {
    const text = result.content?.find((c) => c.type === "text");
    renderError(text && "text" in text ? text.text : "The quote request failed.");
    return;
  }
  board?.destroy();
  board = undefined;
  if (view.kind === "rfq") board = new QuoteBoard(view);
  else renderBlotter(view.trades);
};

app.ontoolcancelled = () => renderError("The quote request was cancelled.");
app.onhostcontextchanged = applyHostContext;
app.onteardown = async () => {
  board?.destroy();
  return {};
};

await app.connect();
applyHostContext(app.getHostContext());

// ---------------------------------------------------------------- views

function renderError(message: string) {
  root.replaceChildren(h("div", { class: "empty" }, message));
}

function renderBlotter(trades: Trade[]) {
  if (!trades.length) {
    root.replaceChildren(h("div", { class: "empty" }, "No trades accepted yet. Ask Claude for a quote to get started."));
    return;
  }
  const head = h(
    "tr",
    {},
    ...["Trade", "Time", "Bank", "Pair", "Side", "Amount", "Rate", "Contra", "Value date"].map((t) => h("th", {}, t)),
  );
  const rows = trades.map((t) =>
    h(
      "tr",
      {},
      h("td", { class: "mono" }, t.tradeId),
      h("td", {}, new Date(t.executedAt).toLocaleTimeString()),
      h("td", {}, t.bankName),
      h("td", {}, t.pair),
      h("td", {}, h("span", { class: `side ${t.side}` }, t.side)),
      h("td", { class: "num" }, fmtAmount(t.amount, t.dealtCurrency)),
      h("td", { class: "num" }, t.rate.toFixed(t.decimals)),
      h("td", { class: "num" }, fmtAmount(t.contraAmount, t.contraCurrency)),
      h("td", {}, t.valueDate),
    ),
  );
  root.replaceChildren(
    h(
      "section",
      { class: "board" },
      h("header", { class: "board-head" }, h("div", { class: "title" }, h("span", { class: "pair-badge" }, "Trade blotter"), h("span", { class: "muted" }, `${trades.length} accepted`))),
      h("div", { class: "blotter-wrap" }, h("table", { class: "blotter" }, h("thead", {}, head), h("tbody", {}, ...rows))),
    ),
  );
}

/** Posts the trade confirmation into the chat as the user, so Claude responds to it. */
async function postToChat(t: Trade, button: HTMLButtonElement): Promise<boolean> {
  button.disabled = true;
  button.textContent = "Posting to chat…";
  try {
    const { isError } = await app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text:
            `I accepted ${t.bankName}'s price in the FX quote board. Trade ${t.tradeId} is booked: ` +
            `${t.side} ${fmtAmount(t.amount, t.dealtCurrency)} ${t.pair} @ ${t.rate.toFixed(t.decimals)}, ` +
            `contra ${fmtAmount(t.contraAmount, t.contraCurrency)}, value date ${t.valueDate}. Please confirm the trade details.`,
        },
      ],
    });
    if (isError) throw new Error("Claude couldn't take the message right now");
    button.textContent = "✓ Posted to chat";
    return true;
  } catch (e) {
    button.disabled = false;
    button.textContent = "Post confirmation to chat";
    toast((e as Error).message, "error");
    return false;
  }
}

interface CardRefs {
  card: HTMLElement;
  price: HTMLElement;
  arrow: HTMLElement;
  bidAsk: HTMLElement;
  spread: HTMLElement;
  age: HTMLElement;
  validity: HTMLElement;
  bar: HTMLElement;
  spark: SVGPathElement;
  accept: HTMLButtonElement;
}

class QuoteBoard {
  private rfq: Rfq;
  private quotes = new Map<string, Quote>();
  private history = new Map<string, number[]>();
  private cards = new Map<string, CardRefs>();
  private feed?: PriceFeed;
  private clockSkew = 0;
  private raf = 0;
  private accepting = false;
  private statusEl!: HTMLElement;
  private timerEl!: HTMLElement;
  private feedEl!: HTMLElement;
  private bestEl!: HTMLElement;
  private actionsEl!: HTMLElement;

  constructor(private view: RfqView) {
    this.rfq = view.rfq;
    this.clockSkew = view.serverTime - Date.now();
    this.render();
    view.quotes.forEach((q) => this.applyQuote(q));
    this.updateBest();
    if (view.trade) {
      this.showTrade(view.trade);
      return;
    }
    if (this.rfq.status === "OPEN") this.startFeed();
    else this.setStatus(this.rfq);
    this.loop();
  }

  destroy() {
    this.feed?.stop();
    cancelAnimationFrame(this.raf);
  }

  private now() {
    return Date.now() + this.clockSkew;
  }

  private startFeed() {
    this.feed = new PriceFeed(
      this.rfq.rfqId,
      this.view.stream.wsUrl,
      async (rfqId) => structured<RfqView>(await app.callServerTool({ name: "get_rfq_quotes", arguments: { rfqId } })),
      {
        onSnapshot: (rfq, quotes, serverTime) => {
          this.clockSkew = serverTime - Date.now();
          this.rfq = rfq;
          quotes.forEach((q) => this.applyQuote(q));
          this.updateBest();
        },
        onQuote: (q) => {
          this.applyQuote(q);
          this.updateBest();
        },
        onStatus: (rfq, trade) => {
          if (trade) this.showTrade(trade);
          else this.setStatus(rfq);
        },
        onMode: (mode) => this.setFeedMode(mode),
        onLost: () => {
          this.setStatus({ ...this.rfq, status: "EXPIRED" });
          this.feedEl.lastElementChild!.textContent = "This RFQ is no longer available on the server";
        },
      },
    );
    this.feed.start();
  }

  // ---- layout

  private render() {
    const r = this.rfq;
    this.statusEl = h("span", { class: `status ${r.status}` }, h("span", { class: "dot" }), h("span", {}, "LIVE"));
    this.timerEl = h("span", { class: "muted mono" });
    this.feedEl = h("span", { class: "feed" }, h("span", { class: "dot" }), h("span", {}, "Connecting…"));
    this.bestEl = h("span", {});
    this.actionsEl = h("div", { class: "actions" });

    const cards = r.banks.map((bank) => {
      const price = h("span", { class: "price" });
      const arrow = h("span", { class: "arrow" });
      const bidAsk = h("span", { class: "mono" });
      const spread = h("span", { class: "mono" });
      const age = h("span", {});
      const bar = h("span", {});
      const validity = h("div", { class: "validity" }, bar);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "spark");
      svg.setAttribute("viewBox", `0 0 ${SPARK_POINTS - 1} 30`);
      svg.setAttribute("preserveAspectRatio", "none");
      const spark = document.createElementNS("http://www.w3.org/2000/svg", "path");
      spark.setAttribute("vector-effect", "non-scaling-stroke");
      svg.append(spark);
      const accept = h("button", { class: `accept ${r.side}`, disabled: "" }, `${r.side === "BUY" ? "Buy" : "Sell"}`);
      accept.addEventListener("click", () => this.accept(bank.id));
      const dot = h("span", { class: "bank-dot" });
      dot.style.background = bank.color;

      const card = h(
        "article",
        { class: "card stale", "data-bank": bank.id },
        h("div", { class: "card-head" }, h("span", { class: "bank" }, dot, bank.name), h("span", { class: "best-tag" }, "BEST")),
        h("div", { class: "price-row" }, price, arrow),
        svg,
        h("div", { class: "meta" }, h("span", {}, "Bid / Ask ", bidAsk), h("span", {}, spread, " bp")),
        validity,
        h("div", { class: "meta" }, age),
        accept,
      );
      this.cards.set(bank.id, { card, price, arrow, bidAsk, spread, age, validity, bar, spark, accept });
      return card;
    });

    const cancel = h("button", { class: "btn" }, "Cancel RFQ");
    cancel.addEventListener("click", () => this.cancel());
    this.actionsEl.append(cancel);

    root.replaceChildren(
      h(
        "section",
        { class: "board" },
        h(
          "header",
          { class: "board-head" },
          h(
            "div",
            { class: "title" },
            h("span", { class: "pair-badge" }, r.pair),
            h("span", { class: `side ${r.side}` }, r.side),
            h("span", { class: "notional" }, fmtAmount(r.amount, r.dealtCurrency)),
          ),
          h("div", { class: "title" }, this.timerEl, this.statusEl),
        ),
        h("div", { class: "cards" }, ...cards),
        h("footer", { class: "board-foot" }, h("div", {}, this.feedEl, " · ", this.bestEl), this.actionsEl),
      ),
    );
  }

  // ---- live updates

  private applyQuote(q: Quote) {
    const refs = this.cards.get(q.bank);
    if (!refs || this.rfq.status !== "OPEN") return;
    const prev = this.quotes.get(q.bank);
    this.quotes.set(q.bank, q);

    const { big, pips, frac } = priceParts(q.price, this.rfq.decimals);
    refs.price.replaceChildren(h("span", { class: "big" }, big), h("span", { class: "pips" }, pips), h("span", { class: "frac" }, frac));
    refs.bidAsk.textContent = `${q.bid.toFixed(this.rfq.decimals)} / ${q.ask.toFixed(this.rfq.decimals)}`;
    refs.spread.textContent = q.spreadBps.toFixed(2);
    refs.accept.textContent = `${this.rfq.side === "BUY" ? "Buy" : "Sell"} @ ${q.price.toFixed(this.rfq.decimals)}`;

    if (prev && prev.price !== q.price) {
      const dir = q.price > prev.price ? "up" : "down";
      refs.arrow.textContent = dir === "up" ? "▲" : "▼";
      refs.arrow.className = `arrow ${dir}`;
      refs.price.classList.remove("up", "down");
      void refs.price.offsetWidth; // restart the flash
      refs.price.classList.add(dir);
      window.setTimeout(() => refs.price.classList.remove(dir), 450);
    }

    const hist = this.history.get(q.bank) ?? [];
    hist.push(q.price);
    if (hist.length > SPARK_POINTS) hist.shift();
    this.history.set(q.bank, hist);
    this.drawSpark(refs.spark, hist);
  }

  private drawSpark(path: SVGPathElement, values: number[]) {
    if (values.length < 2) return path.setAttribute("d", "");
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const offset = SPARK_POINTS - values.length;
    path.setAttribute(
      "d",
      values.map((v, i) => `${i ? "L" : "M"}${(offset + i).toFixed(1)},${(27 - ((v - min) / range) * 24).toFixed(2)}`).join(""),
    );
  }

  private liveQuotes() {
    const now = this.now();
    return [...this.quotes.values()].filter((q) => q.validUntil > now);
  }

  private bestQuote(): Quote | undefined {
    // Client pays the ask → lowest price is best; client hits the bid → highest.
    const lowerIsBetter = clientBuysBase(this.rfq);
    const better = (a: Quote, b: Quote) => (lowerIsBetter ? a.price < b.price : a.price > b.price);
    return this.liveQuotes().reduce<Quote | undefined>((best, q) => (!best || better(q, best) ? q : best), undefined);
  }

  private updateBest() {
    const best = this.bestQuote();
    this.cards.forEach((refs, bank) => refs.card.classList.toggle("best", best?.bank === bank));
    if (best) {
      const contra =
        this.rfq.dealtCurrency === this.rfq.base ? this.rfq.amount * best.price : this.rfq.amount / best.price;
      this.bestEl.textContent = `Best ${best.bankName} ${best.price.toFixed(this.rfq.decimals)} ≈ ${fmtAmount(Math.round(contra * 100) / 100, this.rfq.contraCurrency)}`;
    }
  }

  /** Per-frame: validity bars, quote ages, RFQ countdown. */
  private loop = () => {
    const now = this.now();
    let bestChanged = false;
    this.cards.forEach((refs, bank) => {
      const q = this.quotes.get(bank);
      if (!q) return;
      const total = q.validUntil - q.issuedAt;
      const left = Math.max(0, q.validUntil - now);
      const live = left > 0 && this.rfq.status === "OPEN";
      refs.bar.style.transform = `scaleX(${left / total})`;
      refs.validity.className = `validity${left === 0 ? " dead" : left < total * 0.35 ? " warn" : ""}`;
      refs.age.textContent = live ? `Valid ${(left / 1000).toFixed(1)}s · #${q.seq}` : "Quote expired - waiting for refresh";
      if (refs.card.classList.contains("stale") === live) bestChanged = true;
      refs.card.classList.toggle("stale", !live);
      refs.accept.disabled = !live || this.accepting;
    });
    if (bestChanged) this.updateBest();
    if (this.rfq.status === "OPEN") {
      const secs = Math.max(0, Math.ceil((this.rfq.expiresAt - now) / 1000));
      this.timerEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private setFeedMode(mode: FeedMode) {
    if (this.rfq.status !== "OPEN" && mode === "off") return;
    this.feedEl.className = `feed ${mode}`;
    this.feedEl.lastElementChild!.textContent =
      mode === "ws" ? "Streaming via WebSocket" : mode === "poll" ? "Streaming via MCP (polling)" : "Disconnected";
  }

  private setStatus(rfq: Rfq) {
    this.rfq = rfq;
    this.statusEl.className = `status ${rfq.status}`;
    this.statusEl.lastElementChild!.textContent = rfq.status === "OPEN" ? "LIVE" : rfq.status;
    if (rfq.status === "OPEN") return;
    this.timerEl.textContent = "";
    this.feedEl.className = "feed off";
    this.feedEl.lastElementChild!.textContent = rfq.status === "EXPIRED" ? "RFQ expired" : "RFQ cancelled";
    this.cards.forEach((refs) => {
      refs.card.classList.add("stale");
      refs.card.classList.remove("best");
      refs.accept.disabled = true;
    });
    const requote = h("button", { class: "btn primary" }, "Request new prices");
    requote.addEventListener("click", () => this.requote(requote));
    this.actionsEl.replaceChildren(requote);
  }

  // ---- user actions

  private async accept(bankId: string) {
    const q = this.quotes.get(bankId);
    const refs = this.cards.get(bankId);
    if (!q || !refs || this.accepting) return;
    if (q.validUntil <= this.now()) return toast(`${q.bankName}'s price just expired - try again.`, "error");

    this.accepting = true;
    refs.card.classList.add("chosen");
    refs.accept.replaceChildren(h("span", { class: "spinner" }), "Booking…");
    try {
      const result = structured<AcceptResult>(
        await app.callServerTool({ name: "accept_quote", arguments: { rfqId: q.rfqId, quoteId: q.quoteId } }),
      );
      if (result?.kind === "accepted") {
        this.feed?.stop();
        const share = this.showTrade(result.trade);
        void this.tellClaude(result.trade, share);
        return;
      }
      toast(result?.message ?? "Quote rejected", "error");
      if (result?.rfq && result.rfq.status !== "OPEN") this.setStatus(result.rfq);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      this.accepting = false;
      refs.card.classList.remove("chosen");
      if (this.quotes.get(bankId)) refs.accept.textContent = `${this.rfq.side === "BUY" ? "Buy" : "Sell"} @ ${this.quotes.get(bankId)!.price.toFixed(this.rfq.decimals)}`;
    }
  }

  private async cancel() {
    try {
      const view = structured<RfqView>(await app.callServerTool({ name: "cancel_rfq", arguments: { rfqId: this.rfq.rfqId } }));
      this.feed?.stop();
      if (view) this.setStatus(view.rfq);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  private async requote(button: HTMLButtonElement) {
    button.disabled = true;
    const r = this.rfq;
    try {
      const view = structured<RfqView>(
        await app.callServerTool({
          name: "request_fx_quotes",
          arguments: { pair: r.pair, side: r.side, amount: r.amount, dealtCurrency: r.dealtCurrency, banks: r.banks.map((b) => b.id) },
        }),
      );
      if (!view) throw new Error("No quotes returned");
      this.destroy();
      board = new QuoteBoard(view);
    } catch (e) {
      button.disabled = false;
      toast((e as Error).message, "error");
    }
  }

  /**
   * Tells Claude about a trade the user just booked: posts the confirmation into the chat so
   * Claude replies right away, or falls back to a silent model-context update if the host
   * can't post messages (the button then lets the user retry).
   */
  private async tellClaude(t: Trade, share: HTMLButtonElement) {
    if (app.getHostCapabilities()?.message && (await postToChat(t, share))) return;
    const summary =
      `The user accepted ${t.bankName}'s price in the FX quote board. Trade ${t.tradeId} booked: ` +
      `${t.side} ${fmtAmount(t.amount, t.dealtCurrency)} ${t.pair} @ ${t.rate.toFixed(t.decimals)}, ` +
      `contra ${fmtAmount(t.contraAmount, t.contraCurrency)}, value date ${t.valueDate}.`;
    try {
      if (app.getHostCapabilities()?.updateModelContext) {
        await app.updateModelContext({ content: [{ type: "text", text: summary }], structuredContent: { trade: t } });
      }
    } catch {
      /* host may not support model context updates */
    }
  }

  /** Renders the trade ticket; returns its "post to chat" button. */
  private showTrade(t: Trade): HTMLButtonElement {
    cancelAnimationFrame(this.raf);
    this.rfq = { ...this.rfq, status: "ACCEPTED", tradeId: t.tradeId };
    const field = (label: string, value: Node | string, cls = "") =>
      h("div", { class: "field" }, h("label", {}, label), h("div", cls ? { class: cls } : {}, value));

    const share = h("button", { class: "btn" }, "Post confirmation to chat");
    share.addEventListener("click", () => void postToChat(t, share));
    const again = h("button", { class: "btn primary" }, "New quote, same terms");
    again.addEventListener("click", () => this.requote(again));

    root.replaceChildren(
      h(
        "section",
        { class: "ticket" },
        h(
          "div",
          { class: "ticket-head" },
          h("div", { class: "check" }, "✓"),
          h(
            "div",
            {},
            h("h2", {}, `Trade booked with ${t.bankName}`),
            h("p", {}, `${t.side} ${fmtAmount(t.amount, t.dealtCurrency)} ${t.pair} · ${new Date(t.executedAt).toLocaleString()}`),
          ),
        ),
        h(
          "div",
          { class: "ticket-body" },
          field("Trade ID", t.tradeId, "mono"),
          field("Rate", t.rate.toFixed(t.decimals), "rate"),
          field(t.side === "BUY" ? "You buy" : "You sell", fmtAmount(t.amount, t.dealtCurrency)),
          field(t.side === "BUY" ? "You pay" : "You receive", fmtAmount(t.contraAmount, t.contraCurrency)),
          field("Counterparty", t.bankName),
          field("Value date", t.valueDate),
          field("RFQ", t.rfqId, "mono"),
          field("Status", t.status),
        ),
        h("div", { class: "ticket-foot" }, h("span", {}, `Quote ${t.quoteId}`), h("div", { class: "actions" }, share, again)),
      ),
    );    return share;
  }
}
