import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = {
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
  '/pipeline': 'pipeline.html',
};

// Cache the Hono handler
let _honoHandler: ((req: VercelRequest, res: VercelResponse) => Promise<void>) | null = null;

async function getHonoHandler() {
  if (!_honoHandler) {
    const { handle } = await import('hono/vercel');
    const { default: app } = await import('../src/api/server.ts');
    _honoHandler = handle(app) as any;
  }
  return _honoHandler;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const pathname = req.url?.split('?')[0] || '/';

    // Fast path: static HTML pages
    const filename = STATIC_ROUTES[pathname];
    if (filename) {
      const filePath = findFile(filename);
      if (filePath) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(readFileSync(filePath, 'utf-8'));
      }
      return res.status(404).send(`File not found: ${filename}`);
    }

    // API routes: load full Hono server
    const h = await getHonoHandler();
    return h(req, res);
  } catch (err: any) {
    return res.status(500).json({
      error: 'Function error',
      message: err.message,
    });
  }
}
