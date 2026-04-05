import { handle } from 'hono/vercel';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

function findFile(filename: string): string | null {
  const candidates = [
    join(process.cwd(), 'src', 'dashboard', filename),
    join(process.cwd(), '..', 'src', 'dashboard', filename),
    join(__dirname, '..', 'src', 'dashboard', filename),
    join(__dirname, 'src', 'dashboard', filename),
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
    // Debug: return what we tried
    return new Response(`File ${filename} not found. cwd=${process.cwd()}, __dirname=${__dirname}`, { status: 404 });
  }

  // API routes: load full server
  try {
    const { default: app } = await import('../src/api/server.ts');
    const h = handle(app);
    return h(req);
  } catch (err: any) {
    return new Response(JSON.stringify({
      error: 'Function init failed',
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 5),
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
