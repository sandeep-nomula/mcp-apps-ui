// Simulated FX market: a random-walk mid for each currency (in USD terms)
// from which any cross rate is derived.

export const CURRENCIES = ["USD", "GBP", "EUR", "JPY", "CHF", "AUD", "CAD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** USD value of one unit of each currency at start-up. */
const SEED_USD_VALUE: Record<Currency, number> = {
  USD: 1,
  GBP: 1.3312,
  EUR: 1.1624,
  JPY: 1 / 151.84,
  CHF: 1 / 0.7962,
  AUD: 0.6548,
  CAD: 1 / 1.3921,
};

/** Per-tick volatility (fraction of price) for each currency vs USD. */
const VOL: Record<Currency, number> = {
  USD: 0,
  GBP: 0.000045,
  EUR: 0.00004,
  JPY: 0.00005,
  CHF: 0.00004,
  AUD: 0.00006,
  CAD: 0.000035,
};

export function isCurrency(c: string): c is Currency {
  return (CURRENCIES as readonly string[]).includes(c);
}

/** JPY-quoted pairs are shown to 3 decimals, everything else to 5. */
export function decimalsFor(base: string, quote: string): number {
  return base === "JPY" || quote === "JPY" ? 3 : 5;
}

export function parsePair(input: string): { base: Currency; quote: Currency } {
  const cleaned = input.toUpperCase().replace(/[^A-Z]/g, "");
  if (cleaned.length !== 6) throw new Error(`Unrecognised currency pair "${input}". Use e.g. USD/GBP.`);
  const base = cleaned.slice(0, 3);
  const quote = cleaned.slice(3);
  if (!isCurrency(base) || !isCurrency(quote)) {
    throw new Error(`Unsupported currency in "${input}". Supported: ${CURRENCIES.join(", ")}.`);
  }
  if (base === quote) throw new Error("Base and quote currency must differ.");
  return { base, quote };
}

class Market {
  private usdValue: Record<Currency, number> = { ...SEED_USD_VALUE };
  private timer?: NodeJS.Timeout;

  start(intervalMs = 200) {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), intervalMs);
    this.timer.unref();
  }

  private step() {
    for (const c of CURRENCIES) {
      if (c === "USD") continue;
      // Gaussian-ish shock with a weak pull back towards the seed level.
      const shock = (Math.random() + Math.random() + Math.random() - 1.5) * 2 * VOL[c];
      const drift = (SEED_USD_VALUE[c] / this.usdValue[c] - 1) * 0.002;
      this.usdValue[c] *= 1 + shock + drift;
    }
  }

  mid(base: Currency, quote: Currency): number {
    return this.usdValue[base] / this.usdValue[quote];
  }

  /** Approximate USD equivalent of an amount, used to size spreads. */
  toUsd(amount: number, ccy: Currency): number {
    return amount * this.usdValue[ccy];
  }
}

export const market = new Market();
