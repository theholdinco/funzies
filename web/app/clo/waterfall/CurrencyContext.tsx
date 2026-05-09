"use client";

import React, { createContext, useContext, useMemo } from "react";
import { formatAmount } from "./helpers";

/**
 * Deal currency context.
 *
 * Provides the active deal's ISO 4217 currency code (e.g. "EUR", "USD") to
 * descendants. Every formatting site that renders an amount must read from
 * here — hardcoding "€" or "$" violates CLAUDE.md § "Recurring failure
 * modes" principle 1 (don't overfit to one deal) and is enforced by the
 * `ui-hardcodes-currency-symbol` AST rule. Null indicates the resolver
 * could not determine the currency; the UI surfaces a "Set deal currency"
 * banner in that case via `MissingCurrencyBanner`.
 *
 * Usage:
 *   <DealCurrencyProvider currency={resolved.currency}>
 *     ...children, which call `useFormatAmount()` to format values...
 *   </DealCurrencyProvider>
 */
// Sentinel `undefined` distinguishes "no provider in scope" from
// "provider present, currency null". The hook throws on the former — that
// surfaces missing-provider bugs at dev-server startup instead of silently
// rendering "?" symbols. The SwitchWaterfallImpact bug (rendered outside
// the provider) is the failure shape this guards against.
const DealCurrencyContext = createContext<string | null | undefined>(undefined);

export function DealCurrencyProvider({
  currency,
  children,
}: {
  currency: string | null;
  children: React.ReactNode;
}) {
  return (
    <DealCurrencyContext.Provider value={currency}>
      {children}
    </DealCurrencyContext.Provider>
  );
}

/** Returns the active deal's currency, or null if the resolver could not
 *  determine it. THROWS if called outside <DealCurrencyProvider> — that is
 *  always a bug (the caller should either wrap the tree or thread currency
 *  via props). Pass to `formatAmount(val, currency)`. */
export function useDealCurrency(): string | null {
  const value = useContext(DealCurrencyContext);
  if (value === undefined) {
    throw new Error(
      "useDealCurrency() called outside <DealCurrencyProvider>. Wrap the component tree, or thread `currency` via props and call formatAmount(val, currency) directly.",
    );
  }
  return value;
}

/** React-component-friendly wrapper around `formatAmount`. Reads the deal
 *  currency from context; returns a stable closure suitable for use inside
 *  render bodies and dependency arrays. */
export function useFormatAmount(): (val: number) => string {
  const currency = useDealCurrency();
  return useMemo(() => (val: number) => formatAmount(val, currency), [currency]);
}

/** Banner rendered when the resolver could not determine deal currency.
 *  Projection is refused when active collateral exposure exists without
 *  currency metadata; this banner still covers empty/loading and metadata
 *  setup states where amounts may render before a projection is available. */
export function MissingCurrencyBanner() {
  const currency = useDealCurrency();
  if (currency) return null;
  return (
    <div
      style={{
        padding: "0.6rem 0.9rem",
        marginBottom: "0.75rem",
        background: "var(--color-warning-bg, rgba(255, 193, 7, 0.08))",
        border: "1px solid var(--color-warning-border, rgba(255, 193, 7, 0.4))",
        borderRadius: "4px",
        fontSize: "0.72rem",
        lineHeight: 1.45,
      }}
    >
      <strong>Deal currency not set.</strong>{" "}
      Could not determine the currency used for this deal&apos;s reporting and
      projections. Projection is blocked for active collateral until the deal
      currency and loan currencies are populated, so collateral balances can be
      confirmed in the deal currency. Upload trustee collateral data with
      currency columns or set the deal currency in the context editor. Amounts
      may render with a <code>?</code> symbol while that metadata is missing.
    </div>
  );
}
