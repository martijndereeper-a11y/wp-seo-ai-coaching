/**
 * Weekly Sales Intel Digest — Crawler & Digest Generator
 *
 * Crawls configured sources, filters for relevance to WP SEO AI,
 * and generates three regional AE digest editions (EN+NL, EN+FI, EN+DE).
 *
 * Quality gates:
 * - Only articles published within the last 7 days
 * - Relevance threshold 8/10 — only golden nuggets
 * - Pitch-alignment filter: every article must map to one of 5 SMB script moments
 * - All talk tracks in the edition's native language
 * - Only authoritative, vetted sources (see context/sales/media-outlets.md)
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ──────────────────────────────────────────────────────────────────

const SOURCES_PATH = join(__dirname, "sources.json");
const OUTPUT_DIR = join(__dirname, "../../work/enablement/digests");
const RELEVANCE_THRESHOLD = 8; // Only golden nuggets
const MAX_AGE_DAYS = 14; // Bi-weekly digest — 2 week window
const MAX_ARTICLES_PER_SECTION = 5; // Don't overload AEs — top 5 per section

interface Source {
  name: string;
  url: string;
  type: string;
  language: string;
}

interface Sources {
  global_en: Source[];
  nl: Source[];
  fi: Source[];
  de: Source[];
}

interface Article {
  title: string;
  url: string;
  summary: string;
  date: string; // ISO date or "unknown"
  source: string;
  language: string;
}

interface DigestArticle extends Article {
  ae_hook: string;
  use_in: string;
  relevance_score: number;
  pitch_moment: string;
}

// ── HTTP fetch via curl (avoids Anthropic SDK fetch conflict) ────────────────

function fetchHtml(url: string): string {
  try {
    const html = execSync(
      `curl -sL --max-time 30 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" "${url}"`,
      { maxBuffer: 1024 * 1024 * 5, encoding: "utf-8" }
    );
    return html;
  } catch {
    return "";
  }
}

/** Strip scripts, styles, nav, footer, ads — keep only article-relevant HTML */
function stripNoise(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s{2,}/g, " ");
}

/** Check if a date string is within the configured max age */
function isWithinWindow(dateStr: string): boolean {
  if (!dateStr || dateStr === "unknown") return false;
  try {
    const articleDate = new Date(dateStr);
    const now = new Date();
    const cutoff = new Date(now.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    return articleDate >= cutoff && articleDate <= now;
  } catch {
    return false;
  }
}

// ── API Client with retry ───────────────────────────────────────────────────

const client = new Anthropic();

/** Wrapper that retries on rate limit errors with exponential backoff */
async function callClaude(params: Parameters<typeof client.messages.create>[0], retries = 3): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.error?.error?.type === "rate_limit_error";
      if (isRateLimit && attempt < retries) {
        const wait = Math.pow(2, attempt + 1) * 15; // 30s, 60s, 120s
        console.log(`    ⏳ Rate limited, waiting ${wait}s before retry ${attempt + 1}/${retries}...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      } else {
        throw err;
      }
    }
  }
  throw new Error("Max retries exceeded");
}

// ── Crawler ─────────────────────────────────────────────────────────────────

const today = new Date().toISOString().split("T")[0];
const cutoffDate = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

async function crawlSource(source: Source): Promise<Article[]> {
  console.log(`  Crawling: ${source.name} (${source.url})`);

  try {
    const html = fetchHtml(source.url);
    if (!html || html.length < 500) {
      console.error(`  ✗ Empty or too short response from ${source.name}`);
      return [];
    }
    const cleanHtml = stripNoise(html);
    const trimmedHtml = cleanHtml.substring(0, 60000);

    const response = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3000,
      messages: [{
        role: "user",
        content: `Here is the HTML from ${source.url} (${source.name}).
Today's date is ${today}.

${trimmedHtml}

Extract ONLY articles published within the last ${MAX_AGE_DAYS} days (since ${cutoffDate}). Look for dates in the HTML — publication dates, timestamps, date metadata.

For each recent article return:
- title: exact article title as it appears
- url: full URL (resolve relative links against ${source.url})
- summary: 1-2 sentence description of the article topic
- date: publication date in YYYY-MM-DD format. If you cannot determine the exact date but the article appears recent (e.g., it's in the "latest" section), use "recent". If it's clearly older than 7 days, EXCLUDE it.

CRITICAL: Do NOT include articles that are clearly older than ${MAX_AGE_DAYS} days. When in doubt about the date, include it with date "recent" — we'll filter later.

Return ONLY a valid JSON array, no markdown fences, no explanation:
[{"title": "...", "url": "...", "summary": "...", "date": "YYYY-MM-DD"}]

If no recent articles found, return: []`
      }]
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const raw: Array<{ title: string; url: string; summary: string; date: string }> = JSON.parse(jsonMatch[0]);

    // Filter: keep articles with valid recent dates OR marked as "recent"
    const articles = raw.filter(a =>
      a.date === "recent" || isWithinWindow(a.date)
    );

    console.log(`  ✓ ${source.name}: ${articles.length} recent articles (${raw.length - articles.length} filtered as too old)`);
    return articles.map(a => ({
      ...a,
      source: source.name,
      language: source.language
    }));
  } catch (err) {
    console.error(`  ✗ Failed to crawl ${source.name}:`, (err as Error).message);
    return [];
  }
}

// ── Relevance Filter & AE Hook Generator ────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  en: "English", nl: "Dutch", fi: "Finnish", de: "German"
};

async function filterAndEnrich(articles: Article[], talkTrackLanguage: string): Promise<DigestArticle[]> {
  if (articles.length === 0) return [];

  const talkTrackLang = LANG_NAMES[talkTrackLanguage] || "English";

  console.log(`  ⚙ Scoring ${articles.length} articles → talk tracks in ${talkTrackLang}...`);

  const articleList = articles.map((a, i) =>
    `[${i}] "${a.title}" — ${a.summary} (source: ${a.source}, published: ${a.date})`
  ).join("\n");

  const response = await callClaude({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: `You are a strict Sales Intel gatekeeper for WP SEO AI.

## WHAT WP SEO AI ACTUALLY SELLS — memorize this before scoring anything

WP SEO AI is a MANAGED SERVICE (not a tool, not a platform you log into). We do SEO content for SMB business owners. Here is exactly what we do:

1. We RESEARCH what questions their target audience types into Google and ChatGPT
2. We CREATE traffic-generating blog content at scale using AI (not thought leadership — traffic-generating content that answers search queries)
3. We PUBLISH it automatically into the customer's WordPress sitemap (hidden from visitors, visible to Google and AI search engines)
4. We MEASURE via Google Search Console — if an article gets zero traction after 3 months, we auto-remove it
5. We NOTIFY the customer when an article starts ranking — they review it, improve it, approve it, and we move it to their live blog
6. We build TOPIC CLUSTERS: supporting blog articles that link back to the customer's money-making pillar pages, boosting those pages in Google and AI search
7. The customer does NOT need to learn any tool or hire anyone — our team operates everything

KEY STATS from our pitch:
- 96.55% of ALL content worldwide gets zero visitors — 9 out of 10 hours spent on content are wasted
- Making one article takes 3-4 hours (research → write → optimize → publish → measure → iterate)
- You need 10+ articles/month because 9/10 fail — that's 30+ hours/month for maybe 1 winner
- Our cost per article is so low that targeting long-tail queries (7-8 word searches, low individual volume but high buying intent) becomes economically viable for the first time
- Long-tail searches doubled between 2022-2025
- Topic clusters compound: supporting content boosts pillar pages AND ranks in ChatGPT/AI Overviews
- First mover advantage in AI search: like Google in 1999, nobody owns this space yet
- We are the trawl net (scale, low cost, keep winners, discard losers) vs the fishing rod (manual, expensive, hope one article works)

Our AEs sell to SMB BUSINESS OWNERS in a single-call close. NOT enterprise, NOT CMOs, NOT marketers.

## Articles to evaluate:
${articleList}

## THE FILTER — would Noy (our CRO) approve this article?

For EACH article, answer these three questions. ALL THREE must be YES or the article is killed:

1. **Does this article's topic directly connect to something WP SEO AI does?** (content creation, SEO visibility, AI search visibility, content ROI, content waste, managed vs DIY, topic clusters, blog-driven lead generation)
2. **Can an AE read this article and naturally transition into our pitch within 2 sentences?** Not "this is vaguely related to search" — can they literally say "and that's exactly why we do X" where X is something from our pitch above?
3. **Would a Dutch/Finnish/German SMB business owner care about this?** Not a CMO, not a marketer, not a developer — a business owner who wants more customers from online.

If ANY answer is NO → score 0, kill it.

## AUTOMATIC KILL — these topics NEVER pass regardless of quality:
- Paid advertising / SEA / PPC / Google Ads (we don't sell this)
- Social media strategy / LinkedIn / Instagram (not what we do)
- E-commerce / webshop optimization (wrong ICP)
- Multilingual / international content strategy (not our pitch)
- Marketing metrics / analytics philosophy (we don't sell analytics)
- Technical SEO / site speed / Core Web Vitals (we explicitly say we skip this in our pitch)
- Backlink strategies (we explicitly skip this in our pitch)
- Enterprise / B2B marketing strategy at CMO level (wrong audience)
- Generic "AI is changing everything" articles without a specific connection to content/visibility
- Tool reviews or "how to use X tool" (we are anti-tool — we do it for you)
- Brand building / brand authority concepts (too abstract, doesn't connect to our pitch)

## Pitch moments — each surviving article must map to exactly one:
| Label | What it reinforces |
|---|---|
| content-waste | Data proving most content fails (96.55% stat, wasted hours/budget, content ROI problems) |
| time-sink | Evidence that creating good SEO content manually is slow, expensive, or unsustainable |
| scale-beats-manual | Why publishing at volume with low cost per article beats manual approaches (trawl net vs fishing rod) |
| first-mover-ai | Specific evidence that businesses showing up in ChatGPT/AI Overviews/Perplexity are winning customers RIGHT NOW — not "AI is coming" but "AI is here and your competitors are already in it" |
| managed-service | Why doing it yourself or hiring doesn't work — you need someone to run the whole loop for you |

## Scoring — be BRUTAL:
- 9-10 = Article is practically written for our pitch. An AE reads it and immediately knows which slide to reference.
- 8 = Strong connection, clear path to pitch. Business owner would find this directly relevant.
- 7 or below = Interesting but the AE would have to stretch to connect it. KILL IT.
- It is BETTER to return an empty list than to include a weak article. An off-pitch article is worse than no article — it sends AEs off-script.

## For each survivor (8+), write:
- ae_hook: 2-3 sentences. Talk track that steers DIRECTLY into our pitch. Must reference something specific from our pitch (e.g., the 96.55% stat, the sitemap approach, the trawl net, the first mover window). Include one question. No jargon.
- use_in: "pre-call" | "discovery" | "nurture" | "objection-handler"
- pitch_moment: "content-waste" | "time-sink" | "scale-beats-manual" | "first-mover-ai" | "managed-service"

LANGUAGE: Write ALL ae_hook values in ${talkTrackLang}. Native, fluent, idiomatic — as spoken in a real sales call. Do NOT translate from English.

Return ONLY valid JSON, no markdown fences:
[{"index": 0, "relevance_score": 9, "ae_hook": "...", "use_in": "discovery", "pitch_moment": "first-mover-ai"}]

If nothing scores 8+, return: []
RETURNING AN EMPTY LIST IS FINE. Do not force articles through.`
    }]
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  let scored: Array<{ index: number; relevance_score: number; ae_hook: string; use_in: string; pitch_moment: string }>;
  try {
    scored = JSON.parse(jsonMatch[0]);
  } catch {
    console.error("    ⚠ Failed to parse enrichment JSON, skipping batch");
    return [];
  }

  return scored
    .filter(s => s.relevance_score >= RELEVANCE_THRESHOLD)
    .map(s => ({
      ...articles[s.index],
      ae_hook: s.ae_hook,
      use_in: s.use_in,
      relevance_score: s.relevance_score,
      pitch_moment: s.pitch_moment || "first-mover-ai"
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, MAX_ARTICLES_PER_SECTION);
}

// ── Digest Formatter (Markdown) ─────────────────────────────────────────────

function formatDigest(
  edition: string,
  enArticles: DigestArticle[],
  localArticles: DigestArticle[],
  localLanguage: string
): string {
  const langLabel: Record<string, string> = {
    nl: "🇳🇱 Nederlands",
    fi: "🇫🇮 Suomi",
    de: "🇩🇪 Deutschland"
  };

  const pitchMomentLabel: Record<string, string> = {
    "content-waste": "→ 96.55% gets zero traffic",
    "time-sink": "→ 3-4 hours per article",
    "scale-beats-manual": "→ Trawl net vs fishing rod",
    "first-mover-ai": "→ First mover in AI search",
    "managed-service": "→ We do it for you"
  };

  const formatArticle = (a: DigestArticle, i: number) => `
### ${i + 1}. ${a.title}
**Source:** ${a.source} | **Score:** ${"★".repeat(Math.round(a.relevance_score / 2))} (${a.relevance_score}/10) | **Published:** ${a.date}
**Pitch moment:** ${pitchMomentLabel[a.pitch_moment] || a.pitch_moment}
**Link:** ${a.url}

> ${a.summary}

**🎯 ${a.use_in.toUpperCase()}:** ${a.ae_hook}
`;

  const allArticles = [...enArticles, ...localArticles];

  return `# 📡 WP SEO AI — Weekly Sales Intel Digest
**Edition:** ${edition} | **Week of:** ${today}

---

## 🌍 Global (English) — Top Picks

${enArticles.length > 0
    ? enArticles.map((a, i) => formatArticle(a, i)).join("\n---\n")
    : "_No golden nuggets from English sources this week._"}

---

## ${langLabel[localLanguage] || localLanguage} — Local Market Intel

${localArticles.length > 0
    ? localArticles.map((a, i) => formatArticle(a, i)).join("\n---\n")
    : `_No golden nuggets from ${localLanguage.toUpperCase()} sources this week._`}

---
_Generated by WP SEO AI Sales Intel Engine | ${allArticles.length} golden nuggets from ${today}_
`;
}

// ── HTML Email Formatter (Single Combined Digest) ───────────────────────────

interface MarketSection {
  label: string;
  articles: DigestArticle[];
}

function formatCombinedEmailHtml(
  enArticles: DigestArticle[],
  markets: MarketSection[],
  totalScanned: number,
  totalSources: number
): string {
  const tagColor: Record<string, string> = {
    "pre-call": "#B748FF",
    "discovery": "#6B21A8",
    "nurture": "#059669",
    "objection-handler": "#DC2626"
  };

  const pitchMomentHtml: Record<string, string> = {
    "content-waste": "96.55% gets zero traffic",
    "time-sink": "3-4 hours per article",
    "scale-beats-manual": "Trawl net vs fishing rod",
    "first-mover-ai": "First mover in AI search",
    "managed-service": "We do it for you"
  };

  function renderArticle(a: DigestArticle, isFirst: boolean) {
    const bg = isFirst ? "background:#faf6ff;border-left:4px solid #B748FF;" : "border:1px solid #f0e8f8;";
    const stars = "&#9733;".repeat(Math.round(a.relevance_score / 2)) + "&#9734;".repeat(5 - Math.round(a.relevance_score / 2));
    const pitchLabel = pitchMomentHtml[a.pitch_moment] || a.pitch_moment;
    return `
    <tr>
      <td style="padding:${isFirst ? "20" : "16"}px 40px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;${bg}">
          <tr><td style="padding:20px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td>
                <span style="background:${tagColor[a.use_in] || "#B748FF"};color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;text-transform:uppercase;">${a.use_in}</span>
                <span style="background:#f0e8f8;color:#6B21A8;font-size:10px;font-weight:600;padding:3px 10px;border-radius:12px;margin-left:6px;">&#8594; ${pitchLabel}</span>
                <span style="color:#999;font-size:12px;margin-left:8px;">${a.source} &middot; ${a.date}</span>
                <span style="float:right;color:#B748FF;font-size:13px;font-weight:700;">${stars}</span>
              </td></tr>
              <tr><td style="padding-top:10px;">
                <a href="${a.url}" style="font-size:17px;font-weight:700;color:#1a1a1a;text-decoration:none;line-height:1.3;">${a.title} &rarr;</a>
              </td></tr>
              <tr><td style="padding-top:8px;">
                <p style="font-size:13px;color:#666;line-height:1.5;margin:0;font-style:italic;">${a.summary}</p>
              </td></tr>
              <tr><td style="padding-top:12px;border-top:1px dashed #e0d4f0;">
                <p style="font-size:13px;color:#333;line-height:1.5;margin:12px 0 0;">
                  <strong style="color:#B748FF;">&#127919; Talk Track:</strong> ${a.ae_hook}
                </p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </td>
    </tr>`;
  }

  function renderSection(label: string, articles: DigestArticle[]) {
    return `
  <tr><td style="padding:0 40px 8px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:13px;font-weight:700;color:#B748FF;text-transform:uppercase;letter-spacing:1.5px;padding-bottom:8px;border-bottom:2px solid #B748FF;">${label}</td>
    </tr></table>
  </td></tr>

  ${articles.length > 0
    ? articles.map((a, i) => renderArticle(a, i === 0)).join("\n")
    : `<tr><td style="padding:20px 40px;"><p style="font-size:14px;color:#999;font-style:italic;">No golden nuggets from these sources this period.</p></td></tr>`
  }

  <tr><td style="padding:28px 0 0;"></td></tr>`;
  }

  const totalRelevant = enArticles.length + markets.reduce((sum, m) => sum + m.articles.length, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f0f8;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0f8;padding:24px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(183,72,255,0.08);">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#B748FF 0%,#8B1FD4 100%);padding:32px 40px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <span style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">WP SEO AI</span><br>
        <span style="font-size:14px;color:rgba(255,255,255,0.85);letter-spacing:1px;text-transform:uppercase;">Sales Intel Digest</span>
      </td>
      <td align="right" style="vertical-align:top;">
        <span style="color:#ffffff;font-size:18px;display:inline-block;">&#127468;&#127463; &#127475;&#127473; &#127467;&#127470; &#127465;&#127466;</span><br>
        <span style="color:rgba(255,255,255,0.7);font-size:12px;display:inline-block;margin-top:6px;">Week of ${today}</span>
      </td>
    </tr></table>
  </td></tr>

  <!-- Intro -->
  <tr><td style="padding:28px 40px 12px;">
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0;">Hey team — here are this period's golden nuggets on AI Search, SEO shifts, and market signals across all our markets. Each article is pitch-aligned and comes with a ready-to-use talk track for your calls.</p>
  </td></tr>

  <!-- Stats Bar -->
  <tr><td style="padding:12px 40px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf6ff;border-radius:8px;border:1px solid #ede4f7;">
      <tr>
        <td align="center" style="padding:14px 0;"><span style="font-size:22px;font-weight:700;color:#B748FF;">${totalScanned}</span><br><span style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Scanned</span></td>
        <td align="center" style="padding:14px 0;border-left:1px solid #ede4f7;border-right:1px solid #ede4f7;"><span style="font-size:22px;font-weight:700;color:#B748FF;">${totalRelevant}</span><br><span style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Golden Nuggets</span></td>
        <td align="center" style="padding:14px 0;"><span style="font-size:22px;font-weight:700;color:#B748FF;">${totalSources}</span><br><span style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Sources</span></td>
      </tr>
    </table>
  </td></tr>

  <!-- Global Section -->
  ${renderSection("&#127758; Global (English)", enArticles)}

  <!-- Market Sections -->
  ${markets.map(m => renderSection(m.label, m.articles)).join("\n")}

  <!-- Tag Legend -->
  <tr><td style="padding:0 40px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:8px;">
      <tr><td style="padding:20px 24px 12px;"><span style="font-size:13px;font-weight:700;color:#B748FF;text-transform:uppercase;letter-spacing:1px;">How to use these tags</span></td></tr>
      <tr><td style="padding:0 24px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;"><span style="background:#B748FF;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;">PRE-CALL</span><span style="color:#ccc;font-size:12px;margin-left:10px;">Use in your prep before a meeting</span></td></tr>
          <tr><td style="padding:6px 0;"><span style="background:#6B21A8;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;">DISCOVERY</span><span style="color:#ccc;font-size:12px;margin-left:10px;">Conversation starter: "Did you see that...?"</span></td></tr>
          <tr><td style="padding:6px 0;"><span style="background:#059669;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;">NURTURE</span><span style="color:#ccc;font-size:12px;margin-left:10px;">Forward to prospects with a personal note</span></td></tr>
          <tr><td style="padding:6px 0;"><span style="background:#DC2626;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;">OBJECTION-HANDLER</span><span style="color:#ccc;font-size:12px;margin-left:10px;">Third-party validation when prospects push back</span></td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#faf6ff;padding:24px 40px;border-top:1px solid #ede4f7;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><span style="font-size:14px;font-weight:700;color:#B748FF;">WP SEO AI</span><span style="font-size:12px;color:#999;margin-left:8px;">Sales Intel Engine</span></td>
      <td align="right"><span style="font-size:11px;color:#aaa;">Auto-generated from ${totalSources} authoritative sources across 4 markets</span></td>
    </tr></table>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("🚀 WP SEO AI — Weekly Sales Intel Digest Generator\n");
  console.log("=".repeat(55));
  console.log(`Quality: threshold ${RELEVANCE_THRESHOLD}/10 | Max age: ${MAX_AGE_DAYS} days | Date: ${today}`);

  const sources: Sources = JSON.parse(readFileSync(SOURCES_PATH, "utf-8"));

  // Step 1: Crawl all sources
  console.log("\n📡 Phase 1: Crawling sources...\n");

  const allSources = [
    ...sources.global_en,
    ...sources.nl,
    ...sources.fi,
    ...sources.de
  ];

  // Crawl one at a time to respect 5 req/min rate limit
  const allArticles: Article[] = [];
  for (const source of allSources) {
    const articles = await crawlSource(source);
    allArticles.push(...articles);
    // 15s gap between sources to stay under rate limit
    await new Promise(resolve => setTimeout(resolve, 15000));
  }

  console.log(`\n✓ Crawled ${allSources.length} sources → ${allArticles.length} recent articles`);

  // Step 2: Split by language
  const enArticles = allArticles.filter(a => a.language === "en");
  const nlArticles = allArticles.filter(a => a.language === "nl");
  const fiArticles = allArticles.filter(a => a.language === "fi");
  const deArticles = allArticles.filter(a => a.language === "de");

  console.log(`  EN: ${enArticles.length} | NL: ${nlArticles.length} | FI: ${fiArticles.length} | DE: ${deArticles.length}`);

  // Step 3: Filter and enrich — EN articles get enriched PER EDITION LANGUAGE
  // so all talk tracks in the NL edition are in Dutch, FI edition in Finnish, etc.
  console.log("\n⚙ Phase 2: Filtering for golden nuggets & generating native talk tracks...\n");

  // Enrich sequentially to respect rate limits (5 req/min)
  // EN articles: English talk tracks (shared across all editions)
  console.log("  → EN global articles (English talk tracks)...");
  const enrichedEN = await filterAndEnrich(enArticles, "en");
  await new Promise(r => setTimeout(r, 15000));

  // Local articles: native language talk tracks
  console.log("  → NL local articles (Dutch talk tracks)...");
  const enrichedNL = await filterAndEnrich(nlArticles, "nl");
  await new Promise(r => setTimeout(r, 15000));

  console.log("  → FI local articles (Finnish talk tracks)...");
  const enrichedFI = await filterAndEnrich(fiArticles, "fi");
  await new Promise(r => setTimeout(r, 15000));

  console.log("  → DE local articles (German talk tracks)...");
  const enrichedDE = await filterAndEnrich(deArticles, "de");

  const totalNuggets = enrichedEN.length + enrichedNL.length + enrichedFI.length + enrichedDE.length;
  console.log(`\n✓ Golden nuggets: ${enrichedEN.length} global + ${enrichedNL.length} NL + ${enrichedFI.length} FI + ${enrichedDE.length} DE = ${totalNuggets} total`);

  // Step 4: Generate single combined digest
  console.log("\n📝 Phase 3: Generating combined digest...\n");

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const totalScanned = allArticles.length;
  const totalSources = allSources.length;

  const markets: MarketSection[] = [
    { label: "&#127475;&#127473; Netherlands", articles: enrichedNL },
    { label: "&#127467;&#127470; Finland", articles: enrichedFI },
    { label: "&#127465;&#127466; Germany", articles: enrichedDE },
  ];

  // Combined HTML email
  const html = formatCombinedEmailHtml(enrichedEN, markets, totalScanned, totalSources);
  writeFileSync(join(OUTPUT_DIR, `email-${today}-combined.html`), html, "utf-8");
  console.log(`  ✓ Combined email → email-${today}-combined.html`);

  // Also save markdown for reference
  const mdParts = [
    formatDigest("Global", enrichedEN, [], "en"),
    enrichedNL.length > 0 ? formatDigest("NL", [], enrichedNL, "nl") : "",
    enrichedFI.length > 0 ? formatDigest("FI", [], enrichedFI, "fi") : "",
    enrichedDE.length > 0 ? formatDigest("DE", [], enrichedDE, "de") : "",
  ].filter(Boolean).join("\n\n---\n\n");
  writeFileSync(join(OUTPUT_DIR, `digest-${today}-combined.md`), mdParts, "utf-8");
  console.log(`  ✓ Combined markdown → digest-${today}-combined.md`);

  // Save structured JSON for Notion sync
  const digestData = {
    date: today,
    totalScanned,
    totalSources,
    global: enrichedEN,
    nl: enrichedNL,
    fi: enrichedFI,
    de: enrichedDE,
  };
  writeFileSync(join(OUTPUT_DIR, `digest-${today}-data.json`), JSON.stringify(digestData, null, 2), "utf-8");
  console.log(`  ✓ Structured data → digest-${today}-data.json`);

  console.log(`\n${"=".repeat(55)}`);
  console.log(`✅ Done! ${totalNuggets} golden nuggets from ${totalSources} sources`);
  console.log(`   Digest saved to: work/enablement/digests/`);
}

run().catch(console.error);
