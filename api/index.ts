import { handle } from 'hono/vercel';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

export default async function handler(req: Request) {
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
