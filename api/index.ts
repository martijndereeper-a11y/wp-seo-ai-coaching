import { Hono } from 'hono';
import { handle } from 'hono/vercel';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

// Lazy import the full app to debug startup issues
const app = new Hono();

app.all('*', async (c) => {
  try {
    const { default: fullApp } = await import('../src/api/server.ts');
    return fullApp.fetch(c.req.raw, c.env);
  } catch (err: any) {
    return c.json({
      error: 'App failed to load',
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 8),
    }, 500);
  }
});

export default handle(app);
