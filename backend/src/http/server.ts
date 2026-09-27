/**
 * HTTP server: security middleware, API, SEO routes, static SPA.
 *
 * Order matters — helmet, CORS and rate limiting run before any route handler,
 * and static file serving is registered last so it cannot shadow the API.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Db } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { registerApiRoutes } from './routes.js';

export async function buildServer(db: Db): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 256 * 1024,
    disableRequestLogging: true,
  });

  await app.register(helmet, {
    // The API serves JSON and a same-origin SPA; a strict CSP with no inline
    // script is enforced. `unsafe-inline` is required for styles only.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        // BYOK AI calls go straight from the browser to the user's provider
        // (OpenRouter, OpenAI, local Ollama, custom endpoints…). The user
        // explicitly configures these URLs in the UI, so remote + local fetch
        // targets must be allowed. Scripts/styles stay locked to 'self'.
        connectSrc: ["'self'", 'https:', 'http:', 'ws:', 'wss:'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin requests and tools without an Origin header are allowed.
      if (!origin) return cb(null, true);
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      if (!config.isProduction && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return cb(null, true);
      return cb(new Error('origin not allowed'), false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // The admin ingest endpoints get their own, much tighter budget.
    keyGenerator: (req) => req.ip,
    addHeadersOnExceeding: { 'x-ratelimit-limit': true },
  });

  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as Error & { statusCode?: number; code?: string };
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      logger.error('request failed', { method: req.method, url: req.url, error: err.message });
      return reply.code(status).send({ error: 'internal_error', message: 'Something went wrong on our side.' });
    }
    return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: 'Unknown API endpoint.' });
    }
    return reply.code(404).type('text/html; charset=utf-8').send(spaFallback());
  });

  // API responses are live data (deadlines, statuses). Never let a browser or
  // intermediary serve a stale copy: without this, phones happily show
  // yesterday's countdowns from the HTTP cache.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    }
  });

  await registerApiRoutes(app, { db, enableIngestRoutes: Boolean(config.adminToken) });

  // ---- static SPA (registered last) ---------------------------------------
  const indexHtml = join(config.frontendDist, 'index.html');
  if (existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: config.frontendDist,
      prefix: '/',
      index: ['index.html'],
      // Hashed asset filenames can be cached hard; the shell must not be.
      setHeaders: (res, path) => {
        if (path.includes(`${'/assets/'}`) && /\.[0-9a-f]{8,}\./.test(path)) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        } else if (path.endsWith('.html')) {
          res.setHeader('cache-control', 'no-cache');
        }
      },
    });

    // Client-side routes fall through to the SPA shell, but indexable routes get
    // server-rendered metadata so crawlers do not have to run JavaScript.
    app.get('/hackathons/:city', async (req, reply) => {
      const { city } = req.params as { city: string };
      return sendSeoOrShell(app, reply, `/seo/hackathons/${encodeURIComponent(city)}`);
    });
    app.get('/hackathon/:slug', async (req, reply) => {
      const { slug } = req.params as { slug: string };
      return sendSeoOrShell(app, reply, `/seo/hackathon/${encodeURIComponent(slug)}`);
    });

    // Pure client-side routes: serve the SPA shell so deep links and refreshes
    // work. Every new frontend route must be added here or it 404s.
    for (const path of ['/saved', '/health', '/admin']) {
      app.get(path, async (_req, reply) => sendShell(reply));
    }
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send(
        '<h1>Hackathon Finder API</h1><p>The frontend bundle has not been built. Run <code>npm run build</code>, or use <code>/api/health</code>.</p>',
      ),
    );
  }

  return app;
}

/** Serve the built SPA shell for client-only routes. */
async function sendShell(reply: { type: (t: string) => { send: (b: string) => unknown } }) {
  const html = await readSpaIndex();
  if (html) return reply.type('text/html; charset=utf-8').send(html);
  return reply.type('text/html; charset=utf-8').send(spaFallback());
}

async function sendSeoOrShell(app: FastifyInstance, reply: { type: (t: string) => { send: (b: string) => unknown }; code: (c: number) => typeof reply }, seoPath: string) {  try {
    const res = await app.inject({ method: 'GET', url: seoPath });
    if (res.statusCode === 200 && res.body.includes('<title>')) {
      return reply.type('text/html; charset=utf-8').send(res.body);
    }
  } catch {
    // fall through to the SPA shell
  }
  return reply.type('text/html; charset=utf-8').send(spaFallback());
}

function spaFallback(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Hackathon Finder</title>
<meta name="description" content="Find hackathons in your city with verified registration deadlines.">
</head><body><p>Page not found. <a href="/">Return to search</a>.</p></body></html>`;
}

export async function readSpaIndex(): Promise<string | null> {
  const path = join(config.frontendDist, 'index.html');
  if (!existsSync(path)) return null;
  return readFile(path, 'utf8');
}
