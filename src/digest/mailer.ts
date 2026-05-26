/**
 * Digest Mailer — sends the combined HTML digest via Gmail SMTP
 *
 * Usage:
 *   npm run digest:send              # send today's combined digest
 *   npm run digest:send -- --test    # send to GMAIL_USER only (dry run)
 */

import nodemailer from "nodemailer";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const isTest = args.includes("--test");

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error("✗ Missing GMAIL_USER or GMAIL_APP_PASSWORD in .env");
    process.exit(1);
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const today = new Date().toISOString().split("T")[0];
  const digestDir = join(__dirname, "../../work/enablement/digests");
  const htmlPath = join(digestDir, `email-${today}-combined.html`);
  const dataPath = join(digestDir, `digest-${today}-data.json`);

  let html: string;
  try {
    html = readFileSync(htmlPath, "utf-8");
  } catch {
    console.error(`✗ No digest found at: ${htmlPath}`);
    console.error("  Run 'npm run digest' first to generate today's digest.");
    process.exit(1);
  }

  // Guard: never send an empty digest. If the crawler returned zero nuggets,
  // skip the send so AEs don't get a "0 golden nuggets" email.
  try {
    const data = JSON.parse(readFileSync(dataPath, "utf-8")) as {
      global?: unknown[]; nl?: unknown[]; fi?: unknown[]; de?: unknown[];
      totalScanned?: number;
    };
    const nuggetCount =
      (data.global?.length ?? 0) +
      (data.nl?.length ?? 0) +
      (data.fi?.length ?? 0) +
      (data.de?.length ?? 0);

    if (nuggetCount === 0) {
      console.error("⚠ Skipping send — digest contains 0 golden nuggets.");
      console.error(`   totalScanned: ${data.totalScanned ?? "unknown"}`);
      console.error("   Crawler likely failed or no relevant articles this period.");
      console.error("   Investigate work/enablement/digests/ and crawler logs before next run.");
      process.exit(0);
    }
    console.log(`✓ Pre-flight: ${nuggetCount} golden nuggets — proceeding to send.`);
  } catch (err) {
    console.error(`✗ Could not read digest data at ${dataPath}:`, (err as Error).message);
    console.error("  Aborting send — refusing to ship an unverified digest.");
    process.exit(1);
  }

  const to = isTest ? user : (process.env.DIGEST_TO || "ae-sales@wpseoai.com");
  const cc = "";

  const info = await transport.sendMail({
    from: `"WP SEO AI Sales Intel" <${user}>`,
    to,
    cc: cc || undefined,
    replyTo: user,
    subject: `📡 Sales Intel Digest — ${today}`,
    html,
  });

  console.log(`✅ Sent to: ${to}${cc ? ` (CC: ${cc})` : ""}`);
  console.log(`   Message ID: ${info.messageId}`);
}

main().catch(console.error);
