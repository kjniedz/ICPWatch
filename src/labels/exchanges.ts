// Exchange attribution adapter. THIRD PARTY by nature: no exchange proves ownership of an ICP account on chain, so
// everything that comes out of this file is confidence "inferred" and is rendered differently from verified labels.
//
// Rule for adding a seed: a public page that a reader can open and that names the account, written by the exchange
// itself or by DFINITY. A screenshot, a forum guess, or another explorer's label without its own citation is not enough;
// those go through the review queue (/labels/submit) and become "community" labels if a reviewer accepts the evidence.
//
// State on 2026-09-21: the seed list is EMPTY on purpose. What was checked and why nothing qualified:
//   ledger-api.internetcomputer.org  /accounts and /v2/accounts return account_identifier, balance, transaction_count,
//                                    updated_at, suspicious, percentage, value_usd. There is no name field.
//   ic-api.internetcomputer.org      The OpenAPI document (161 paths) has no account naming endpoint. /api/v4/user-icp-accounts
//                                    is a signed-in user's private address book and answers AUTHENTICATION_DISABLED.
//   dashboard.internetcomputer.org   The account page and its JavaScript bundles contain no exchange names.
// So the ICP dashboard does not publish exchange names today. If it ever does, implement `fetchDashboardNames` below and
// the collector will pick the names up as inferred labels with the endpoint as their source.
import { isValidAccountId } from "../lib/account";
import { cleanText, normalizeId, type LabelRow } from "./store";

export interface ExchangeSeed {
  /** ICP account identifier (64 hex, CRC checked) or a principal. */
  id: string;
  /** Exchange name plus the wallet role when the source states it, e.g. "Binance hot wallet". */
  name: string;
  /** Public page that names this account. Required. */
  source_url: string;
  /** Who published it, e.g. "Binance proof of reserves". */
  source_name: string;
  checked_on: string;
}

/** See the header: empty until a citable public source exists. */
export const EXCHANGE_SEEDS: ExchangeSeed[] = [];

export function isValidSeed(s: ExchangeSeed): boolean {
  const id = normalizeId(s.id);
  if (!id || (/^[0-9a-f]{64}$/.test(id) && !isValidAccountId(id))) return false;
  return /^https:\/\/[^\s]+$/.test(s.source_url) && cleanText(s.name).length >= 3 && cleanText(s.source_name).length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(s.checked_on);
}

export function exchangeLabels(seeds: ExchangeSeed[] = EXCHANGE_SEEDS): LabelRow[] {
  return seeds.filter(isValidSeed).map((s) => ({
    id: normalizeId(s.id)!, name: cleanText(s.name), category: "exchange" as const, confidence: "inferred" as const,
    source: cleanText(`Third party attribution: ${s.source_name} (${s.source_url}), checked ${s.checked_on}. Not provable on chain`, 300),
    token_id: null, url: s.source_url, owner: null, origin: "seed" as const,
  }));
}

/**
 * Hook for a future dashboard endpoint that returns account names. Returns nothing today because no such endpoint
 * exists (see the header). Kept so the collector's call site and the "third party" labeling are already in place.
 */
export async function fetchDashboardNames(): Promise<ExchangeSeed[]> {
  return [];
}
