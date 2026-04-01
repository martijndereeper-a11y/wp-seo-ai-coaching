import { handle } from 'hono/vercel';
import app from '../src/api/server.ts';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

export default handle(app);
