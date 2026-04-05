import { handle } from 'hono/vercel';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

let thisDir: string;
try {
  thisDir = dirname(fileURLToPath(import.meta.url));
} catch {
  thisDir = process.cwd();
}

function findFile(filename: string): string | null {
  const candidates = [
    join(thisDir, '..', 'src', 'dashboard', filename),
    join(process.cwd(), 'src', 'dashboard', filename),
    join(thisDir, 'src', 'dashboard', filename),
  ];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

const STATIC_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/sales-os': 'sales-os.html',
  '/use-cases': 'use-cases.html',
  '/use-cases-admin': 'use-cases-admin.html',
};

export default async function handler(req: Request) {
  try {
    const url = new URL(req.url);

    // Fast path: static HTML pages
    const filename = STATIC_ROUTES[url.pathname];
    if (filename) {
      const filePath = findFile(filename);
      if (filePath) {
        return new Response(readFileSync(filePath, 'utf-8'), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(`File not found: ${filename}`, { status: 404 });
    }

    // API routes: load full server
    const { default: app } = await import('../src/api/server.ts');
    const h = handle(app);
    return h(req);
  } catch (err: any) {
    return new Response(JSON.stringify({
      error: 'Function error',
      message: err.message,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
