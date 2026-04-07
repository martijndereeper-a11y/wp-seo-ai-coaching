/**
 * Use Case Finder — Standalone server
 * Run: npx tsx src/use-cases/server.ts
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBJECTIONS, OBJECTIONS_NL, painPatterns as seedPainPatterns } from './data.ts';
import { loadAllCases, saveCase, deleteCase, generateId, pdfDir, detectObjectionsFromText } from './storage.ts';
import type { UseCase, Objection } from './data.ts';
import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new Hono();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wpseoai2026';

app.use('*', cors());

// Login endpoint — validates password, returns token (must be before middleware)
app.post('/api/admin/login', async (c) => {
  const { password } = await c.req.json() as { password: string };
  if (password === ADMIN_PASSWORD) {
    return c.json({ ok: true, token: ADMIN_PASSWORD });
  }
  return c.json({ error: 'Wrong password' }, 401);
});

// Admin auth: check Bearer token on /api/admin/* routes (except login above)
app.use('/api/admin/*', async (c, next) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (token !== ADMIN_PASSWORD) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

/** Rebuild derived lists from current cases (cached until cases change) */
let _derivedCache: ReturnType<typeof buildDerived> | null = null;
let _derivedCaseCount = -1;

function buildDerived() {
  const cases = loadAllCases();
  const painPatterns = [...new Set(cases.map((c) => c.painPattern))];
  const industries = [...new Set(cases.map((c) => c.industry))];
  const objectionCounts = OBJECTIONS.map((obj) => ({
    objection: obj,
    count: cases.filter((c) => c.objections.includes(obj)).length,
  }));
  return { cases, painPatterns, industries, objectionCounts };
}

function getDerived() {
  const cases = loadAllCases();
  if (_derivedCache && _derivedCaseCount === cases.length) return _derivedCache;
  _derivedCache = buildDerived();
  _derivedCaseCount = cases.length;
  return _derivedCache;
}

// ─── Public API ──────────────────────────────────────────────────────────────

app.get('/api/use-cases', (c) => {
  const { cases, painPatterns, industries, objectionCounts } = getDerived();
  return c.json({ cases, painPatterns, industries, objections: OBJECTIONS, objectionCounts });
});

app.get('/api/use-cases/search', (c) => {
  const q = (c.req.query('q') || '').toLowerCase().trim();
  const cases = loadAllCases();
  if (!q) return c.json({ results: cases });

  const terms = q.split(/\s+/);

  const scored = cases.map((uc) => {
    const nlTerms = uc.objections.map((o) => OBJECTIONS_NL[o] || '');
    const searchable = [
      uc.company, uc.industry, uc.painPattern, uc.headline,
      uc.outcome, uc.result, uc.summary, uc.businessType, uc.marketPosition,
      ...uc.keywords, ...uc.objections, ...nlTerms, ...(uc.countries || []),
    ].join(' ').toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (searchable.includes(term)) score += 1;
      if (uc.keywords.some((k) => k.includes(term))) score += 1;
      if (uc.company.toLowerCase().includes(term)) score += 2;
      if (uc.industry.toLowerCase().includes(term)) score += 2;
      if (uc.businessType.toLowerCase() === term) score += 2;
      if (uc.objections.some((o) => o.toLowerCase().includes(term))) score += 1;
    }
    return { ...uc, score };
  });

  const results = scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  return c.json({ results });
});

app.get('/api/use-cases/by-objection', (c) => {
  const obj = c.req.query('objection') || '';
  const results = loadAllCases().filter((uc) => uc.objections.includes(obj as Objection));
  return c.json({ results });
});

// ─── Admin API ───────────────────────────────────────────────────────────────

// Analyze uploaded PDF — extract case details + objections via Claude
app.post('/api/admin/analyze-pdf', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('pdf') as File | null;
    if (!file) return c.json({ error: 'No PDF file provided' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());

    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse(new Uint8Array(buffer));
    await parser.load();
    const textResult = await parser.getText();
    const text = (textResult.pages || []).map((p: any) => p.text).join('\n').slice(0, 6000);

    // Keyword-based objection detection (free, instant)
    const suggestedObjections = detectObjectionsFromText(text);

    // Claude-based structured extraction
    let extracted: Record<string, any> = {};
    try {
      const anthropic = new Anthropic();
      const objList = OBJECTIONS.map((o, i) => `${i + 1}. ${o}`).join('\n');

      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Extract structured data from this success case PDF text. Return ONLY valid JSON, no markdown.

PDF text:
${text}

Return this exact JSON structure:
{
  "company": "company name",
  "industry": "industry in 2-4 words, e.g. Healthcare / Medical Staffing",
  "headline": "one-line headline describing the case",
  "outcome": "short outcome phrase, e.g. +253% organic traffic",
  "result": "1-2 sentence concrete result with numbers",
  "summary": "2-3 sentence context about the company, challenge, and what was achieved",
  "businessType": "B2B or B2C or Mix",
  "marketPosition": "Niche or Mainstream",
  "trustSensitive": true/false,
  "countries": ["country name(s) where this company operates"],
  "keywords": ["5-8 lowercase search keywords for finding this case"],
  "painPattern": "best matching pattern from: No time / capacity for SEO, Underperforming agency / high SEO cost, AI / LLM search opportunity, Relied on single channel, Lack of control / visibility, Going international / scaling, Efficiency gap, Limited marketing capacity, Other"
}`,
        }],
      });

      const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
      extracted = JSON.parse(responseText);
    } catch (aiErr: any) {
      console.error('AI extraction failed:', aiErr.message);
      extracted = { _error: aiErr.message };
    }

    return c.json({
      suggestedObjections,
      extracted,
      preview: text.slice(0, 500).trim(),
      pageCount: (textResult.pages || []).length,
    });
  } catch (err: any) {
    return c.json({ error: 'Failed to parse PDF: ' + err.message }, 500);
  }
});

// Save new case + PDF
app.post('/api/admin/cases', async (c) => {
  try {
    const formData = await c.req.formData();

    const company = (formData.get('company') as string || '').trim();
    if (!company) return c.json({ error: 'Company name is required' }, 400);

    const pdf = formData.get('pdf') as File | null;
    if (!pdf) return c.json({ error: 'PDF file is required' }, 400);

    // Save PDF to disk
    const pdfFileName = pdf.name;
    const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
    writeFileSync(join(pdfDir, pdfFileName), pdfBuffer);

    // Parse objections (comma-separated string)
    const objectionsRaw = (formData.get('objections') as string || '');
    const objections = objectionsRaw
      ? objectionsRaw.split('|||').filter((o) => OBJECTIONS.includes(o as Objection)) as Objection[]
      : [];

    // Parse keywords
    const keywordsRaw = (formData.get('keywords') as string || '');
    const keywords = keywordsRaw ? keywordsRaw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean) : [];

    // Parse countries
    const countriesRaw = (formData.get('countries') as string || '');
    const countries = countriesRaw ? countriesRaw.split(',').map((c) => c.trim()).filter(Boolean) : [];

    const useCase: UseCase = {
      id: generateId(company),
      company,
      industry: (formData.get('industry') as string || 'General').trim(),
      painPattern: (formData.get('painPattern') as string || 'Other').trim(),
      headline: (formData.get('headline') as string || '').trim(),
      outcome: (formData.get('outcome') as string || '').trim(),
      result: (formData.get('result') as string || '').trim(),
      summary: (formData.get('summary') as string || '').trim(),
      businessType: (formData.get('businessType') as string || 'B2B') as UseCase['businessType'],
      marketPosition: (formData.get('marketPosition') as string || 'Mainstream') as UseCase['marketPosition'],
      trustSensitive: formData.get('trustSensitive') === 'true',
      objections,
      countries,
      keywords,
      pdfFile: pdfFileName,
    };

    saveCase(useCase);
    return c.json({ ok: true, id: useCase.id, case: useCase });
  } catch (err: any) {
    return c.json({ error: 'Failed to save case: ' + err.message }, 500);
  }
});

// List user-added cases (for admin overview)
app.get('/api/admin/cases', (c) => {
  const cases = loadAllCases();
  return c.json({ cases });
});

// Delete a case
app.delete('/api/admin/cases/:id', (c) => {
  const id = c.req.param('id');
  const ok = deleteCase(id);
  if (!ok) return c.json({ error: 'Case not found or is a seed case' }, 404);
  return c.json({ ok: true });
});

// ─── Serve PDFs ──────────────────────────────────────────────────────────────

app.get('/use-cases/pdf/:filename', (c) => {
  const filename = decodeURIComponent(c.req.param('filename'));
  const filePath = join(pdfDir, filename);
  if (!existsSync(filePath)) return c.json({ error: 'PDF not found' }, 404);
  const pdf = readFileSync(filePath);
  const mode = c.req.query('download') === '1' ? 'attachment' : 'inline';
  return new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${mode}; filename="${filename}"`,
    },
  });
});

// ─── Frontend ────────────────────────────────────────────────────────────────

app.get('/', (c) => {
  const html = readFileSync(join(__dirname, '..', 'dashboard', 'use-cases.html'), 'utf-8');
  return c.html(html);
});

app.get('/admin', (c) => {
  const html = readFileSync(join(__dirname, '..', 'dashboard', 'use-cases-admin.html'), 'utf-8');
  return c.html(html);
});

// ─── Start ───────────────────────────────────────────────────────────────────

const isVercel = process.env.VERCEL === '1' || !!process.env.VERCEL_ENV;
if (!isVercel) {
const port = parseInt(process.env.PORT || '3001');
console.log(`Use Case Finder running at http://localhost:${port}`);
console.log(`Admin panel at http://localhost:${port}/admin`);
serve({ fetch: app.fetch, port });
}

// ─── Export for Vercel ───────────────────────────────────────────────────────

export default app;
