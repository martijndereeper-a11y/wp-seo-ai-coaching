/**
 * Notion Sync — pushes digest golden nuggets to the Market Insights Pack page
 *
 * Reads the structured JSON from the crawler, then appends a clean
 * digest section to the Notion page with clickable article links.
 *
 * Usage:
 *   npx tsx src/digest/notion-sync.ts                  # sync today's digest
 *   npx tsx src/digest/notion-sync.ts --date 2026-04-03  # sync specific date
 */

import { Client } from "@notionhq/client";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DigestArticle {
  title: string;
  url: string;
  summary: string;
  date: string;
  source: string;
  language: string;
  ae_hook: string;
  use_in: string;
  relevance_score: number;
}

interface DigestData {
  date: string;
  totalScanned: number;
  totalSources: number;
  global: DigestArticle[];
  nl: DigestArticle[];
  fi: DigestArticle[];
  de: DigestArticle[];
}

type RichText = {
  type: "text";
  text: { content: string; link: { url: string } | null };
  annotations?: Partial<{
    bold: boolean;
    italic: boolean;
    color: string;
  }>;
};

type BlockRequest =
  | { type: "paragraph"; paragraph: { rich_text: RichText[] } }
  | { type: "bulleted_list_item"; bulleted_list_item: { rich_text: RichText[] } };

function articleToBlock(a: DigestArticle): BlockRequest {
  return {
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [
        {
          type: "text",
          text: { content: `${a.relevance_score}/10 ${a.use_in.toUpperCase()} `, link: null },
          annotations: { bold: true },
        },
        {
          type: "text",
          text: { content: a.title, link: { url: a.url } },
        },
        {
          type: "text",
          text: { content: ` — ${a.source}, ${a.date}`, link: null },
        },
      ],
    },
  };
}

function sectionHeader(label: string): BlockRequest {
  return {
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: label, link: null },
          annotations: { bold: true },
        },
      ],
    },
  };
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  const pageId = process.env.NOTION_MARKET_INSIGHTS_PAGE_ID;

  if (!token || !pageId) {
    console.error("✗ Missing NOTION_TOKEN or NOTION_MARKET_INSIGHTS_PAGE_ID in .env");
    process.exit(1);
  }

  // Determine date
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf("--date");
  const targetDate = dateIdx !== -1 ? args[dateIdx + 1] : new Date().toISOString().split("T")[0];

  // Load digest data
  const digestDir = join(__dirname, "../../work/enablement/digests");
  const dataPath = join(digestDir, `digest-${targetDate}-data.json`);

  let data: DigestData;
  try {
    data = JSON.parse(readFileSync(dataPath, "utf-8"));
  } catch {
    console.error(`✗ No digest data found at: ${dataPath}`);
    console.error("  Run 'npm run digest' first.");
    process.exit(1);
  }

  const totalNuggets = data.global.length + data.nl.length + data.fi.length + data.de.length;
  console.log(`📋 Syncing ${totalNuggets} articles to Notion...`);

  const notion = new Client({ auth: token });

  // Build blocks
  const blocks: BlockRequest[] = [];

  // Header
  blocks.push({
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: `📡 Digest — ${data.date}  |  ${totalNuggets} golden nuggets from ${data.totalSources} sources`, link: null },
          annotations: { bold: true },
        },
      ],
    },
  });

  // Global
  if (data.global.length > 0) {
    blocks.push(sectionHeader("🌐 GLOBAL (English)"));
    data.global.forEach(a => blocks.push(articleToBlock(a)));
  }

  // NL
  if (data.nl.length > 0) {
    blocks.push(sectionHeader("🇳🇱 NETHERLANDS (Dutch)"));
    data.nl.forEach(a => blocks.push(articleToBlock(a)));
  }

  // FI
  if (data.fi.length > 0) {
    blocks.push(sectionHeader("🇫🇮 FINLAND (Finnish)"));
    data.fi.forEach(a => blocks.push(articleToBlock(a)));
  }

  // DE
  if (data.de.length > 0) {
    blocks.push(sectionHeader("🇩🇪 GERMANY (German)"));
    data.de.forEach(a => blocks.push(articleToBlock(a)));
  }

  // Notion API allows max 100 blocks per request — batch if needed
  const batchSize = 100;
  for (let i = 0; i < blocks.length; i += batchSize) {
    const batch = blocks.slice(i, i + batchSize);
    await notion.blocks.children.append({
      block_id: pageId,
      children: batch as any,
    });
  }

  console.log(`✅ Synced to Notion: ${totalNuggets} articles in ${data.global.length > 0 ? "Global" : ""}${data.nl.length > 0 ? " + NL" : ""}${data.fi.length > 0 ? " + FI" : ""}${data.de.length > 0 ? " + DE" : ""}`);
}

main().catch(console.error);
