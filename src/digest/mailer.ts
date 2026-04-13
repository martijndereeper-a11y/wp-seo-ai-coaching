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

  let html: string;
  try {
    html = readFileSync(htmlPath, "utf-8");
  } catch {
    console.error(`✗ No digest found at: ${htmlPath}`);
    console.error("  Run 'npm run digest' first to generate today's digest.");
    process.exit(1);
  }

  // Testing phase: send only to Martijn until pitch-alignment filter is validated
  const to = isTest ? user : (process.env.DIGEST_TO || "martijn.dereeper@wpseoai.com");
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
