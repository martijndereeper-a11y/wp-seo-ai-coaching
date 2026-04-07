/**
 * JSON file storage for use cases.
 * Merges hardcoded seed data with user-added cases from disk.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useCases as seedCases, type UseCase, OBJECTIONS, type Objection } from './data.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const CASES_FILE = join(DATA_DIR, 'use-cases.json');
const PDF_DIR = join(__dirname, '..', '..', 'context', 'sales', 'use-cases');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// ─── In-memory cache to avoid readFileSync on every request ──────────────────
let _casesCache: UseCase[] | null = null;
let _addedCache: UseCase[] | null = null;

/** Invalidate the cache (call after writes) */
export function invalidateCasesCache() {
  _casesCache = null;
  _addedCache = null;
}

/** Load all cases: seed + user-added (cached in memory) */
export function loadAllCases(): UseCase[] {
  if (_casesCache) return _casesCache;
  ensureDataDir();
  if (!existsSync(CASES_FILE)) {
    _casesCache = [...seedCases];
    return _casesCache;
  }
  try {
    const added: UseCase[] = JSON.parse(readFileSync(CASES_FILE, 'utf-8'));
    const ids = new Set(added.map((c) => c.id));
    const fromSeed = seedCases.filter((c) => !ids.has(c.id));
    _casesCache = [...fromSeed, ...added];
    return _casesCache;
  } catch {
    _casesCache = [...seedCases];
    return _casesCache;
  }
}

/** Load only user-added cases (cached) */
function loadAddedCases(): UseCase[] {
  if (_addedCache) return _addedCache;
  ensureDataDir();
  if (!existsSync(CASES_FILE)) return [];
  try {
    _addedCache = JSON.parse(readFileSync(CASES_FILE, 'utf-8'));
    return _addedCache!;
  } catch {
    return [];
  }
}

/** Save a new case (or update existing by id) */
export function saveCase(uc: UseCase): void {
  ensureDataDir();
  const added = loadAddedCases();
  const idx = added.findIndex((c) => c.id === uc.id);
  if (idx >= 0) added[idx] = uc;
  else added.push(uc);
  writeFileSync(CASES_FILE, JSON.stringify(added, null, 2), 'utf-8');
  invalidateCasesCache();
}

/** Delete a user-added case by id */
export function deleteCase(id: string): boolean {
  const added = loadAddedCases();
  const filtered = added.filter((c) => c.id !== id);
  if (filtered.length === added.length) return false;
  ensureDataDir();
  writeFileSync(CASES_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
  invalidateCasesCache();
  return true;
}

/** Generate a URL-safe id from company name */
export function generateId(company: string): string {
  return company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** PDF directory path */
export const pdfDir = PDF_DIR;

/**
 * Analyze PDF text to suggest matching objections.
 * Uses keyword patterns in both English and Dutch.
 */
export function detectObjectionsFromText(text: string): Objection[] {
  const t = text.toLowerCase();
  const matches: Objection[] = [];

  const patterns: Array<{ objection: Objection; keywords: string[] }> = [
    {
      objection: 'Niche market, too specific for online marketing',
      keywords: ['niche', 'specifiek', 'specific', 'te klein', 'small market', 'niche markt', 'specialistisch'],
    },
    {
      objection: 'B2B sector, nobody searches for our services',
      keywords: ['b2b', 'niemand zoekt', 'nobody searches', 'no one searches', 'geen zoekvolume', 'low search volume'],
    },
    {
      objection: 'Our sector is too technical or complex for AI content',
      keywords: ['technisch', 'technical', 'complex', 'ai content', 'expertise', 'specialistisch', 'kennisintensief'],
    },
    {
      objection: 'Trust-sensitive sector where mistakes are not allowed',
      keywords: ['vertrouwen', 'trust', 'medisch', 'medical', 'juridisch', 'legal', 'fouten', 'mistakes', 'compliance', 'regulated'],
    },
    {
      objection: 'We are too small for this kind of approach',
      keywords: ['te klein', 'too small', 'klein bedrijf', 'small business', 'mkb', 'sme', 'kleine onderneming'],
    },
    {
      objection: 'We tried it before and it didn\'t work',
      keywords: ['eerder geprobeerd', 'tried before', 'didn\'t work', 'werkte niet', 'teleurgesteld', 'disappointed', 'bad experience'],
    },
    {
      objection: 'It takes too long before you see results',
      keywords: ['te lang', 'too long', 'duurt lang', 'takes time', 'slow results', 'langzaam', 'geen resultaat', 'no results yet'],
    },
    {
      objection: 'Our customers are not online',
      keywords: ['niet online', 'not online', 'offline', 'klanten zitten niet', 'customers aren\'t online'],
    },
    {
      objection: 'We get everything from word of mouth',
      keywords: ['mond-tot-mond', 'word of mouth', 'referral', 'netwerk', 'network', 'aanbeveling', 'recommendation', 'mond tot mond'],
    },
    {
      objection: 'We already do Google Ads, why also SEO',
      keywords: ['google ads', 'adwords', 'sea', 'advertenties', 'paid search', 'waarom ook seo', 'why also seo', 'already advertis'],
    },
  ];

  for (const { objection, keywords } of patterns) {
    if (keywords.some((kw) => t.includes(kw))) {
      matches.push(objection);
    }
  }

  return matches;
}
