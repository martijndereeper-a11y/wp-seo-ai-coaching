import { handle } from 'hono/vercel';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

const __dirname = dirname(fileURLToPath(import.meta.url));

// Serve static HTML files directly without loading the full server
function tryServeStatic(req: Request): Response | null {
  const url = new URL(req.url);
  const path = url.pathname;

  const staticRoutes: Record<string, string> = {
    '/': 'index.html',
    '/sales-os': 'sales-os.html',
    '/use-cases': 'use-cases.html',
    '/use-cases-admin': 'use-cases-admin.html',
  };

  const filename = staticRoutes[path];
  if (!filename) return null;

  const paths = [
    join(__dirname, '..', 'src', 'dashboard', filename),
    join(process.cwd(), 'src', 'dashboard', filename),
    join(__dirname, 'src', 'dashboard', filename),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return new Response(readFileSync(p, 'utf-8'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
  }
  return null;
}

export default async function handler(req: Request) {
  // Fast path: serve static HTML without loading the full server
  const staticResponse = tryServeStatic(req);
  if (staticResponse) return staticResponse;

  // API routes: lazy-load the full server
  try {
    const { default: app } = await import('../src/api/server.ts');
    const h = handle(app);
    return h(req);
  } catch (err: any) {
    return new Response(JSON.stringify({
      error: 'Function init failed',
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 10),
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
