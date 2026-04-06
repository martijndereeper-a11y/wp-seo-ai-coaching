import nodemailer from "nodemailer";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const today = new Date().toISOString().split("T")[0];

async function main() {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const digestDir = join(__dirname, "../../work/enablement/digests");
  const recipients = "martijn.dereeper@wpseoai.com, stijn.kat@wpseoai.com";

  const editions = [
    { file: `email-${today}-en-nl.html`, label: "EN + NL" },
  ];

  for (const ed of editions) {
    const htmlPath = join(digestDir, ed.file);
    const html = readFileSync(htmlPath, "utf-8");

    const info = await transport.sendMail({
      from: `"WP SEO AI Sales Intel" <${process.env.GMAIL_USER}>`,
      to: recipients,
      subject: `📡 Weekly Sales Intel Digest — ${ed.label} — ${today}`,
      html,
    });

    console.log(`✅ ${ed.label} sent! Message ID: ${info.messageId}`);
  }
}

main().catch(console.error);
