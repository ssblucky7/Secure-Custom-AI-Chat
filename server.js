/* ============================================================================
 * Secure Custom AI Chat — Server
 * ----------------------------------------------------------------------------
 * Express backend providing:
 *   - Static hosting of the PWA frontend
 *   - Server-side API-key protection (client never talks to providers directly)
 *   - OpenAI-compatible and Anthropic-compatible streaming chat adapters
 *   - Connection testing, model listing, file upload and text extraction
 *   - SSRF protection, request body sanitization, rate limiting and CSP
 * ==========================================================================*/

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ----------------------------------------------------------------------------
 * Environment / configuration
 * --------------------------------------------------------------------------*/
const env = process.env;

const PORT = Number.isInteger(Number(env.PORT)) ? Number(env.PORT) : 3000;
const HOST = env.HOST || '0.0.0.0';
const IS_PROD = env.NODE_ENV === 'production';
const TRUST_PROXY = env.TRUST_PROXY === '1';
const ALLOW_USER_PROVIDERS = env.ALLOW_USER_PROVIDERS === '1';
const ALLOW_PRIVATE_PROVIDER_URLS = env.ALLOW_PRIVATE_PROVIDER_URLS === '1';

const AI_API_URL = String(env.AI_API_URL || '').trim().replace(/\/+$/, '');
const AI_API_KEY = String(env.AI_API_KEY || '').trim();
const AI_DEFAULT_MODEL = String(env.AI_DEFAULT_MODEL || '').trim();
const AI_ALLOWED_MODELS = String(env.AI_ALLOWED_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const AI_MAX_TOKENS_LIMIT = clampInt(env.AI_MAX_TOKENS_LIMIT, 1, 100_000, 8192);


function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ----------------------------------------------------------------------------
 * Static maps
 * --------------------------------------------------------------------------*/

/* ----------------------------------------------------------------------------
 * Small HTTP error helper
 * --------------------------------------------------------------------------*/
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const httpError = (status, message) => new HttpError(status, message);

/* ----------------------------------------------------------------------------
 * Security helpers
 * --------------------------------------------------------------------------*/

/** Deep-strips prototype-pollution keys from untrusted JSON. */
function sanitizeObject(value) {
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = sanitizeObject(child);
    }
    return out;
  }
  return value;
}

/** Redacts every provided secret out of a message (errors, logs). */
function redactSensitive(message, secrets = []) {
  let text = String(message ?? '');
  for (const secret of secrets) {
    if (!secret || typeof secret !== 'string' || secret.length < 4) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), '[REDACTED]');
  }
  return text;
}

/** True when an IP is loopback/private/reserved/link-local (SSRF risk). */
function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (net.isIPv4(ip)) {
    if (parts[0] === 0) return true;                 // "this network"
    if (parts[0] === 10) return true;                // 10.0.0.0/8
    if (parts[0] === 127) return true;               // loopback
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168/16
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
    if (parts[0] >= 224) return true;                // multicast + reserved
    return false;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;            // loopback / unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  if (lower.startsWith('ff')) return true;                       // multicast
  if (lower.startsWith('2001:db8')) return true;                 // documentation
  if (/^64:ff9b:/.test(lower)) return true;                      // NAT64
  if (is4in6MappedPrivate(ip)) return true;
  return false;
}

function is4in6MappedPrivate(ip) {
  // ::ffff:a.b.c.d  and  ::a.b.c.d
  const match = ip.match(/(?:^::ffff:|^::)(\d+\.\d+\.\d+\.\d+)$/);
  if (!match) return false;
  return isPrivateIp(match[1]);
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'lvh.me', 'localtest.me', '127.0.0.1', '::1']);

/** Validates a provider URL against SSRF / HTTPS rules. Returns the URL. */
async function assertSafeProviderUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, 'Provider URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'Provider URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw httpError(400, 'Provider URL must not contain embedded credentials.');
  }
  if (ALLOW_PRIVATE_PROVIDER_URLS) return url;

  if (url.protocol !== 'https:') {
    throw httpError(400, 'Public provider URLs must use HTTPS. For local development set ALLOW_PRIVATE_PROVIDER_URLS=1.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw httpError(400, 'Localhost providers are disabled on this server.');
  }

  let addresses = [];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw httpError(400, 'Could not resolve provider host. Check the URL.');
  }
  if (!addresses.length) throw httpError(400, 'Could not resolve provider host.');

  const privateAddress = addresses.find((entry) => isPrivateIp(entry.address));
  if (privateAddress) {
    throw httpError(400, `Provider host resolves to a private address (${privateAddress.address}), which is blocked for security.`);
  }
  return url;
}

const jsonBodySecretKeys = ['apiKey', 'api_key', 'key', 'authorization', 'x-api-key', 'token'];

/**
 * Reads the API key this request may use so error messages can be redacted.
 * Collects from both the JSON body and query string without logging values.
 */
function collectSecrets(body = {}) {
  const secrets = [];
  if (AI_API_KEY) secrets.push(AI_API_KEY);
  for (const key of jsonBodySecretKeys) {
    const value = body?.[key];
    if (typeof value === 'string' && value) secrets.push(value);
  }
  return [...new Set(secrets)];
}

/* ----------------------------------------------------------------------------
 * Endpoint building (mirrors the frontend preview logic)
 * --------------------------------------------------------------------------*/
function buildChatEndpoint(baseUrl, protocol) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (protocol === 'anthropic') {
    if (/\/messages$/.test(base)) return base;
    if (/\/v1$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function buildModelsEndpoint(baseUrl, protocol) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (protocol === 'anthropic') return null; // Anthropic has no public list endpoint
  if (/\/v1$/.test(base)) return `${base}/models`;
  if (/\/chat\/completions$/.test(base)) return base.replace(/\/chat\/completions$/, '/models');
  return `${base}/v1/models`;
}

/* ----------------------------------------------------------------------------
 * Fetch helper: timeout + no redirects
 * --------------------------------------------------------------------------*/
async function safeFetch(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
  } catch (error) {
    if (error.name === 'AbortError') throw httpError(504, 'The provider request timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readProviderError(response, secrets) {
  const text = await response.text();
  let message = `Provider request failed with status ${response.status}.`;
  try {
    const data = JSON.parse(text);
    const raw = data?.error?.message || data?.error || data?.message || data?.detail;
    if (raw) message = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    if (text && !response.ok && text.length < 500) message = text;
    else if (text && !response.ok) message = 'Provider returned an unexpected response.';
  }
  return redactSensitive(message, secrets);
}

/* ----------------------------------------------------------------------------
 * Provider adapters
 * --------------------------------------------------------------------------*/

function buildOpenAiMessages(messages, systemPrompt) {
  const apiMessages = [];
  if (systemPrompt && systemPrompt.trim()) {
    apiMessages.push({ role: 'system', content: systemPrompt.trim() });
  }
  for (const message of messages || []) {
    if (message && message.role && message.content != null) {
      apiMessages.push({ role: message.role, content: message.content });
    }
  }
  return apiMessages;
}

function buildAnthropicMessages(messages, systemPrompt) {
  const system = [];
  const apiMessages = [];
  for (const message of messages || []) {
    if (!message || !message.role || message.content == null) continue;
    if (message.role === 'system') {
      system.push(String(message.content));
      continue;
    }
    apiMessages.push({ role: message.role, content: String(message.content) });
  }
  if (systemPrompt && systemPrompt.trim()) system.unshift(systemPrompt.trim());
  return { system: system.join('\n\n'), messages: apiMessages };
}

/**
 * Normalizes an upstream SSE stream to a generic OpenAI-style stream:
 *   data: {"delta":"<text>"}\n\n
 * Handles both OpenAI passthrough and Anthropic event mapping.
 */
function normalizeSseStream(upstream, protocol, secrets, send) {
  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    const reader = upstream.getReader();
    let buffer = '';
    let done = false;

    function pump() {
      reader.read().then(({ value, done: readerDone }) => {
        done = readerDone;
        if (value) buffer += decoder.decode(value, { stream: !done });
        if (done) {
          buffer += decoder.decode();
          processChunks(true);
          resolve();
          return;
        }
        processChunks(false);
        pump();
      }).catch((error) => {
        const redacted = redactSensitive(error.message || String(error), secrets);
        send({ error: `Stream interrupted: ${redacted}` });
        resolve();
      });
    }

    function processChunks(isFinal) {
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) handleEvent(event);
      if (isFinal && buffer.trim()) handleEvent(buffer);
    }

    function handleEvent(event) {
      const dataLines = event.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      for (const raw of dataLines) {
        if (!raw || raw === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          continue;
        }
        if (protocol === 'anthropic') {
          if (json.error) {
            send({ error: json.error.message || 'Provider stream error.' });
            continue;
          }
          if (json.type === 'content_block_delta' && json.delta && typeof json.delta.text === 'string') {
            send({ delta: json.delta.text });
          }
          continue;
        }
        // OpenAI-compatible passthrough
        if (json.error) {
          send({ error: json.error.message || 'Provider stream error.' });
          continue;
        }
        const delta = json.choices?.[0]?.delta?.content || json.delta || '';
        if (delta) send({ delta });
      }
    }

    pump();
  });
}

async function handleChatRequest(req, res) {
  const body = sanitizeObject(req.body || {});
  const secrets = collectSecrets(body);

  const protocol = body.protocol === 'anthropic' ? 'anthropic' : 'openai';

  // Resolve provider configuration
  let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  let apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (ALLOW_USER_PROVIDERS) {
    if (!baseUrl) baseUrl = AI_API_URL;
    if (!apiKey) apiKey = AI_API_KEY;
  } else {
    baseUrl = AI_API_URL;
    apiKey = AI_API_KEY;
  }

  if (!baseUrl) {
    throw httpError(400, 'The server has no default provider configured. Ask the administrator to set AI_API_URL.');
  }

  const model = String(body.model || AI_DEFAULT_MODEL || '').trim();
  if (!model) throw httpError(400, 'A model is required.');

  await assertSafeProviderUrl(baseUrl);
  const endpoint = buildChatEndpoint(baseUrl, protocol);
  const secretsForRedaction = collectSecrets({ apiKey });

  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : '';
  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7;
  const maxTokens = clampInt(body.maxTokens, 1, AI_MAX_TOKENS_LIMIT, 2048);

  let upstream;
  if (protocol === 'anthropic') {
    const { system, messages } = buildAnthropicMessages(body.messages, systemPrompt);
    if (!messages.length) throw httpError(400, 'No user messages provided.');
    const payload = {
      model,
      max_tokens: maxTokens,
      stream: true,
      messages,
      temperature
    };
    if (system) payload.system = system;
    upstream = await safeFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(payload)
    });
  } else {
    const apiMessages = buildOpenAiMessages(body.messages, systemPrompt);
    if (!apiMessages.length) throw httpError(400, 'No user messages provided.');
    const payload = {
      model,
      messages: apiMessages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: false }
    };
    upstream = await safeFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
  }

  if (!upstream.ok) {
    const message = await readProviderError(upstream, secretsForRedaction);
    res.status(upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 400).json({ error: message });
    return;
  }

  if (!upstream.body) {
    // Non-streaming fallback for JSON responses
    const data = await upstream.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.content?.[0]?.text ?? '';
    res.json({ choices: [{ message: { role: 'assistant', content: String(content) } }] });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  });
  res.write('retry: 1000\n\n');

  const send = (payload) => {
    if (payload.error) {
      res.write(`data: ${JSON.stringify({ error: payload.error })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ delta: payload.delta })}\n\n`);
  };

  await normalizeSseStream(upstream.body, protocol, secretsForRedaction, send);
  res.write('data: [DONE]\n\n');
  res.end();
}

/* ----------------------------------------------------------------------------
 * Express app
 * --------------------------------------------------------------------------*/
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
}));

app.use(express.json({ limit: '2mb', strict: true }));


/* ---- Rate limiting ---- */
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});

const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many chat requests. Please slow down.' }
});


/* ---- Cache headers ---- */
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  next();
});

/* ---- Static assets ---- */
app.use('/service-worker.js', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use('/site.webmanifest', (_req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  etag: true,
  maxAge: IS_PROD ? '1h' : 0
}));

/* ----------------------------------------------------------------------------
 * API routes
 * --------------------------------------------------------------------------*/

app.get('/api/config', (_req, res) => {
  res.json({
    configured: Boolean(AI_API_URL || ALLOW_USER_PROVIDERS),
    defaultProviderUrl: AI_API_URL,
    defaultModel: AI_DEFAULT_MODEL,
    allowedModels: AI_ALLOWED_MODELS,
    maxTokensLimit: AI_MAX_TOKENS_LIMIT,
    allowsUserProviders: ALLOW_USER_PROVIDERS,
    supportsAttachments: false,
    supportsVoice: false
  });
});

app.post('/api/chat', chatLimiter, async (req, res, next) => {
  try {
    await handleChatRequest(req, res);
  } catch (error) {
    next(error);
  }
});

app.post('/api/test', apiLimiter, async (req, res, next) => {
  try {
    const body = sanitizeObject(req.body || {});
    const secrets = collectSecrets(body);
    const protocol = body.protocol === 'anthropic' ? 'anthropic' : 'openai';

    let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
    let apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (ALLOW_USER_PROVIDERS) {
      if (!baseUrl) baseUrl = AI_API_URL;
      if (!apiKey) apiKey = AI_API_KEY;
    } else {
      baseUrl = AI_API_URL;
      apiKey = AI_API_KEY;
    }
    if (!baseUrl) throw httpError(400, 'No provider URL configured.');

    const model = String(body.model || AI_DEFAULT_MODEL || '').trim();
    if (!model) throw httpError(400, 'A model is required to test the connection.');

    await assertSafeProviderUrl(baseUrl);
    const redactionSecrets = collectSecrets({ apiKey });

    if (protocol === 'anthropic') {
      const endpoint = buildChatEndpoint(baseUrl, 'anthropic');
      const upstream = await safeFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
      });
      if (!upstream.ok) {
        const message = await readProviderError(upstream, redactionSecrets);
        throw httpError(upstream.status >= 500 ? 502 : 400, message);
      }
      await upstream.text();
      res.json({ ok: true });
      return;
    }

    // OpenAI-compatible: prefer GET /models, fall back to a 1-token completion
    const modelsEndpoint = buildModelsEndpoint(baseUrl, 'openai');
    let ok = false;
    if (modelsEndpoint) {
      const upstream = await safeFetch(modelsEndpoint, {
        headers: { authorization: `Bearer ${apiKey}` }
      });
      if (upstream.ok) {
        await upstream.text();
        ok = true;
      }
    }
    if (!ok) {
      const endpoint = buildChatEndpoint(baseUrl, 'openai');
      const upstream = await safeFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false })
      });
      if (!upstream.ok) {
        const message = await readProviderError(upstream, redactionSecrets);
        throw httpError(upstream.status >= 500 ? 502 : 400, message);
      }
      await upstream.text();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/models', apiLimiter, async (req, res, next) => {
  try {
    const body = sanitizeObject(req.body || {});
    const secrets = collectSecrets(body);
    const protocol = body.protocol === 'anthropic' ? 'anthropic' : 'openai';

    let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
    let apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (ALLOW_USER_PROVIDERS) {
      if (!baseUrl) baseUrl = AI_API_URL;
      if (!apiKey) apiKey = AI_API_KEY;
    } else {
      baseUrl = AI_API_URL;
      apiKey = AI_API_KEY;
    }
    if (!baseUrl) throw httpError(400, 'No provider URL configured.');

    await assertSafeProviderUrl(baseUrl);

    const merged = new Set(AI_ALLOWED_MODELS);
    if (AI_DEFAULT_MODEL) merged.add(AI_DEFAULT_MODEL);

    const modelsEndpoint = buildModelsEndpoint(baseUrl, protocol);
    if (modelsEndpoint) {
      const upstream = await safeFetch(modelsEndpoint, {
        headers: { authorization: `Bearer ${apiKey}` }
      });
      if (upstream.ok) {
        const data = await upstream.json();
        if (Array.isArray(data?.data)) {
          for (const item of data.data) {
            const id = item?.id || item?.model;
            if (typeof id === 'string' && id.trim()) merged.add(id.trim());
          }
        }
      }
      // Non-OK is tolerated: we still return server-configured models
    }

    const models = [...merged].sort((a, b) => a.localeCompare(b)).slice(0, 500);
    res.json({ models, note: modelsEndpoint ? null : 'Anthropic does not expose a model list; using configured models.' });
  } catch (error) {
    next(error);
  }
});

/* ---- Chat app route (/app → aichat.html) ---- */
app.get('/app', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'aichat.html'));
});

/* ---- Clean URL routes for SEO pages (/features → /features.html) ---- */
const SEO_PAGES = ['about', 'features', 'faq', 'security', 'providers', 'privacy', 'terms', 'changelog', 'docs'];
for (const page of SEO_PAGES) {
  app.get(`/${page}`, (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, `${page}.html`));
  });
}

/* ---- 404 + error handling ---- */
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  const secrets = collectSecrets({});
  const status = error instanceof HttpError ? error.status : 500;
  const safeMessage = redactSensitive(error.message || 'Internal server error.', secrets);
  if (status >= 500) console.error(`[server] ${status}: ${safeMessage}`);
  res.status(status).json({ error: safeMessage });
});

/* ----------------------------------------------------------------------------
 * Start
 * --------------------------------------------------------------------------*/
const server = app.listen(PORT, HOST, () => {
  console.log(`Secure Custom AI Chat running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`User-provided providers: ${ALLOW_USER_PROVIDERS ? 'enabled' : 'disabled'}`);
  console.log(`Provider configured: ${AI_API_URL ? 'yes (' + redactSensitive(AI_API_URL, []) + ')' : 'no'}`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app };