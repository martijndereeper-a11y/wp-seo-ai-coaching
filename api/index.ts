export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

let handler: any;

try {
  const { handle } = await import('hono/vercel');
  const { default: app } = await import('../src/api/server.ts');
  handler = handle(app);
} catch (err: any) {
  // If the app fails to load, return the error as a response
  handler = (req: Request) => {
    return new Response(JSON.stringify({
      error: 'Function failed to initialize',
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 5),
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  };
}

export default handler;
