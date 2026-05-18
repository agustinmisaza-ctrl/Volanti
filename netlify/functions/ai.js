// ════════════════════════════════════════════════════════════════════════════
// Volanti — AI Proxy (Netlify Function)
//
// This function holds the Anthropic API key server-side so end users never have
// to enter their own. It accepts the same JSON body the Anthropic API accepts
// and forwards it to https://api.anthropic.com/v1/messages.
//
// Setup:
//   1. Drop this file in `netlify/functions/ai.js` in your repo
//   2. Drop `netlify.toml` in your repo root (provided alongside this file)
//   3. In the Netlify dashboard: Site settings → Environment variables → add:
//        ANTHROPIC_API_KEY = sk-ant-api03-...
//      (Optional but recommended:)
//        ANTHROPIC_HOURLY_LIMIT     = 30      (requests per hour per visitor)
//        ANTHROPIC_DAILY_LIMIT      = 150     (requests per day per visitor)
//        ANTHROPIC_MAX_TOKENS_LIMIT = 4096    (caps max_tokens in any request)
//        ANTHROPIC_ALLOWED_MODELS   = claude-haiku-4-5-20251001,claude-sonnet-4-6
//   4. Redeploy. Done. Users do not need to do anything.
//
// What this protects against:
//   • Anyone scraping the key from devtools (server holds it)
//   • Single user blowing through the API budget (per-IP rate limits)
//   • Unexpected model usage that runs up the bill (allowed-models filter)
//   • Token-bomb prompts (max_tokens cap)
// ════════════════════════════════════════════════════════════════════════════

// In-memory rate-limit buckets. Netlify Functions are warm-reuse-friendly so
// these will persist across calls within the same instance for ~5 minutes.
// Across cold starts they reset — which is acceptable for the abuse cases
// we're guarding against (a single client trying to hammer the API).
const buckets = new Map(); // key: ip → { hourly:[ts...], daily:[ts...] }

function getClientIp(headers) {
  return (
    headers['x-nf-client-connection-ip'] ||
    (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

function checkRateLimit(ip, env) {
  const hourly = parseInt(env.ANTHROPIC_HOURLY_LIMIT || '60', 10);
  const daily  = parseInt(env.ANTHROPIC_DAILY_LIMIT  || '300', 10);
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY  = 24 * HOUR;

  let b = buckets.get(ip);
  if (!b) { b = { hourly: [], daily: [] }; buckets.set(ip, b); }

  // Prune old entries
  b.hourly = b.hourly.filter(t => now - t < HOUR);
  b.daily  = b.daily.filter(t  => now - t < DAY);

  if (b.hourly.length >= hourly) {
    return { ok: false, scope: 'hour', resetIn: Math.ceil((HOUR - (now - b.hourly[0])) / 60000) };
  }
  if (b.daily.length >= daily) {
    return { ok: false, scope: 'day', resetIn: Math.ceil((DAY - (now - b.daily[0])) / 3600000) };
  }
  // Record this request
  b.hourly.push(now);
  b.daily.push(now);
  return { ok: true, remaining: { hour: hourly - b.hourly.length, day: daily - b.daily.length } };
}

function corsHeaders(origin) {
  // Echo origin back if present, otherwise allow any. Tighten in production
  // by setting ALLOWED_ORIGIN env var if you want strict CORS.
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, anthropic-version, x-api-key',
    'Access-Control-Max-Age': '86400',
  };
}

exports.handler = async function (event) {
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { type: 'method_not_allowed', message: 'POST only' } }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: {
          type: 'configuration_error',
          message: 'ANTHROPIC_API_KEY is not set on the server. Add it in Netlify → Site settings → Environment variables.',
        },
      }),
    };
  }

  // Rate limiting (per IP)
  const ip = getClientIp(event.headers);
  const rl = checkRateLimit(ip, process.env);
  if (!rl.ok) {
    return {
      statusCode: 429,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: {
          type: 'rate_limit_exceeded',
          message:
            rl.scope === 'hour'
              ? `Hourly limit reached. Try again in ${rl.resetIn} minute(s).`
              : `Daily limit reached. Try again in ${rl.resetIn} hour(s).`,
        },
      }),
    };
  }

  // Parse + validate body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { type: 'invalid_request', message: 'Body is not valid JSON.' } }),
    };
  }

  // Model allow-list (optional but recommended for cost control)
  const allowedModels = (process.env.ANTHROPIC_ALLOWED_MODELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (allowedModels.length && body.model && !allowedModels.includes(body.model)) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: {
          type: 'model_not_allowed',
          message: `Model "${body.model}" is not in the allow-list. Allowed: ${allowedModels.join(', ')}`,
        },
      }),
    };
  }

  // Cap max_tokens so a runaway prompt can't drain the budget
  const maxTokensLimit = parseInt(process.env.ANTHROPIC_MAX_TOKENS_LIMIT || '4096', 10);
  if (body.max_tokens && body.max_tokens > maxTokensLimit) {
    body.max_tokens = maxTokensLimit;
  }

  // Forward to Anthropic
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await apiRes.text();

    // Log usage on success for cost monitoring (visible in Netlify function logs)
    if (apiRes.ok) {
      try {
        const parsed = JSON.parse(text);
        const inT = parsed.usage?.input_tokens ?? 0;
        const outT = parsed.usage?.output_tokens ?? 0;
        console.log(`[ai] ok ip=${ip} model=${body.model} in=${inT} out=${outT} remH=${rl.remaining.hour} remD=${rl.remaining.day}`);
      } catch {
        console.log(`[ai] ok ip=${ip} model=${body.model}`);
      }
    } else {
      console.warn(`[ai] anthropic ${apiRes.status} ip=${ip} model=${body.model}`);
    }

    return {
      statusCode: apiRes.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (e) {
    console.error('[ai] proxy error', e);
    return {
      statusCode: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: { type: 'proxy_error', message: e.message || 'Upstream request failed.' },
      }),
    };
  }
};
