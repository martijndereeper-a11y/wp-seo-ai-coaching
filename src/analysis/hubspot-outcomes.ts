/**
 * Loads the HubSpot all-deals CSV and resolves per-recording outcomes
 * by HubSpot deal ID (= recordings.crm_deal_id).
 *
 * Single source of truth for ae_call_analysis.outcome.
 * Replaces the legacy channel-name + deal-name regex inference.
 *
 * CSV path is read from HUBSPOT_DEALS_CSV (env) or defaults to
 * `data/all-deals 129.csv`. Refresh by replacing the file and re-running analyze.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export type Outcome = 'won' | 'lost' | 'open' | 'unknown';

export type HubspotDeal = {
  dealId: string;
  dealName: string | null;
  dealStage: string | null;
  isClosedWon: boolean;
  amount: number | null;
  closeDate: string | null;
  country: string | null;
  dealOwner: string | null;
  closedLostReason: string | null;
};

export type OutcomeResolution = {
  outcome: Outcome;
  deal: HubspotDeal | null;
};

const DEFAULT_CSV = 'data/all-deals 129.csv';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cell += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function classifyStage(stage: string | null, isClosedWon: boolean): Outcome {
  if (isClosedWon) return 'won';
  const s = (stage || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('lost') || s === 'churn') return 'lost';
  if (s.includes('won')) return 'won';
  return 'open';
}

let _cache: { byId: Map<string, HubspotDeal>; loadedFrom: string } | null = null;

function resolvePath(): string {
  const fromEnv = process.env.HUBSPOT_DEALS_CSV;
  const candidate = fromEnv && fromEnv.trim() ? fromEnv.trim() : DEFAULT_CSV;
  return isAbsolute(candidate) ? candidate : join(process.cwd(), candidate);
}

/** Load and memoize the deals map. Returns empty map if CSV missing. */
export function loadHubspotDeals(): Map<string, HubspotDeal> {
  if (_cache) return _cache.byId;

  const path = resolvePath();
  if (!existsSync(path)) {
    console.warn(`[hubspot-outcomes] CSV not found at ${path} — outcomes will be 'unknown'. Set HUBSPOT_DEALS_CSV env var or place export at ${DEFAULT_CSV}.`);
    _cache = { byId: new Map(), loadedFrom: path };
    return _cache.byId;
  }

  const text = readFileSync(path, 'utf-8');
  const rows = parseCsv(text);
  const header = rows[0];
  const idx = (name: string) => header.indexOf(name);
  const ID = idx('Record ID');
  const STAGE = idx('Deal Stage');
  const WON = idx('Is Closed Won');
  const NAME = idx('Deal Name');
  const COUNTRY = idx('Country');
  const AMOUNT = idx('Amount');
  const CLOSE_DATE = idx('Close Date');
  const OWNER = idx('Deal owner');
  const REASON = idx('Closed Lost Reason (new)');
  if (ID < 0) throw new Error(`HubSpot CSV at ${path} missing 'Record ID' column`);

  const byId = new Map<string, HubspotDeal>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[ID]) continue;
    const amountRaw = r[AMOUNT]?.trim();
    const closeDateRaw = r[CLOSE_DATE]?.trim();
    byId.set(r[ID].trim(), {
      dealId: r[ID].trim(),
      dealName: r[NAME]?.trim() || null,
      dealStage: r[STAGE]?.trim() || null,
      isClosedWon: (r[WON] || '').toLowerCase() === 'true',
      amount: amountRaw ? Number(amountRaw.replace(/,/g, '')) || null : null,
      closeDate: closeDateRaw && /^\d{4}-\d{2}-\d{2}/.test(closeDateRaw) ? closeDateRaw : null,
      country: r[COUNTRY]?.trim() || null,
      dealOwner: r[OWNER]?.trim() || null,
      closedLostReason: r[REASON]?.trim() || null,
    });
  }

  _cache = { byId, loadedFrom: path };
  console.log(`[hubspot-outcomes] Loaded ${byId.size} deals from ${path}`);
  return byId;
}

/** Resolve outcome for a recording by its HubSpot deal id. */
export function resolveOutcome(crmDealId: string | null | undefined): OutcomeResolution {
  if (!crmDealId) return { outcome: 'unknown', deal: null };
  const map = loadHubspotDeals();
  const deal = map.get(crmDealId) ?? null;
  if (!deal) return { outcome: 'unknown', deal: null };
  return { outcome: classifyStage(deal.dealStage, deal.isClosedWon), deal };
}
