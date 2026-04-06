/**
 * Scheduled Digest Runner — crawls all sources, generates combined digest, sends email
 * Designed to be run by cron every other Monday at 07:30
 */

import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "../..");

function run(cmd: string) {
  console.log(`\n→ ${cmd}\n`);
  execSync(cmd, { cwd: projectRoot, stdio: "inherit", timeout: 15 * 60 * 1000 });
}

async function main() {
  const start = Date.now();
  console.log("🚀 WP SEO AI — Scheduled Digest Run");
  console.log(`   ${new Date().toISOString()}\n`);
  console.log("=".repeat(50));

  // Step 1: Generate digest (crawl + filter + generate HTML/MD/JSON)
  run("npx tsx src/digest/crawler.ts");

  // Step 2: Send email
  run("npx tsx src/digest/mailer.ts");

  // Step 3: Sync to Notion
  run("npx tsx src/digest/notion-sync.ts");

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`✅ Scheduled run complete in ${elapsed}s`);
}

main().catch(err => {
  console.error("✗ Scheduled run failed:", err.message);
  process.exit(1);
});
