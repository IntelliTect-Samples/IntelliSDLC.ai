#!/usr/bin/env node
/**
 * detect-auth.js - HAR auth classifier for the web-api-discovery agent.
 *
 * Reads a HAR file and prints a single-line JSON object describing the
 * authentication style observed in the captured traffic:
 *
 *   { authModel, evidence: [{url, signal}, ...], idpName? }
 *
 * Supported authModel values (source of truth: ../csharp/manifest.json):
 *   cookie | cookie+csrf | bearer | sso-google | sso-microsoft |
 *   sso-facebook | oauth2-pkce | unknown
 *
 * Heuristic priority (first match wins):
 *   1. oauth2-pkce  - code_challenge_method=S256 or code_verifier + Bearer
 *   2. sso-google   - accounts.google.com redirect + Bearer
 *   3. sso-microsoft- login.microsoftonline.com redirect + Bearer
 *   4. sso-facebook - facebook.com/v*\/dialog/oauth redirect + Bearer
 *   5. bearer       - Authorization: Bearer <jwt-shaped>
 *   6. cookie+csrf  - Set-Cookie + CSRF request header
 *   7. cookie       - Set-Cookie alone
 *   8. unknown      - none of the above (evidence still listed)
 *
 * Exit codes: 0 on success; 1 on read/parse error; 2 on usage error.
 *
 * Usage: node detect-auth.js <path-to-har> [--source-label=<label>]
 *
 * When --source-label is given (e.g. "mobile-android"), every entry in the
 * emitted evidence[] array gains a `source` field. This lets the agent
 * distinguish auth signals captured from mobile-app traffic (issue #44)
 * from those captured from the website. When the flag is absent, the
 * evidence shape is unchanged (backwards compatible with PR #41).
 */
'use strict';

const fs = require('fs');

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const CSRF_HEADER_NAMES = new Set([
  'x-csrf-token', 'x-xsrf-token', 'csrf-token', 'x-requested-with',
]);

// Akamai bot-management cookie names (issue #66). When any of these appear in
// either the HAR's request `Cookie` header or response `Set-Cookie` header, the
// target almost certainly fronts traffic with Akamai Bot Manager, which means
// a session-replay-only wrapper may hit a non-200 anti-bot challenge response.
// We surface the cookie names so downstream tooling (the README emitter) can
// warn the consumer; we do NOT attempt to implement a bypass.
const AKAMAI_BOT_COOKIE_NAMES = ['_abck', 'bm_sz', 'bm_sv', 'ak_bmsc'];
const AKAMAI_BOT_COOKIE_SET = new Set(AKAMAI_BOT_COOKIE_NAMES);

const SSO_HOSTS = [
  { authModel: 'sso-google',    idpName: 'Google',    label: 'Google',    test: (u) => /(^|\.)accounts\.google\.com$/i.test(u.hostname) },
  { authModel: 'sso-microsoft', idpName: 'Microsoft', label: 'Microsoft', test: (u) => /(^|\.)login\.microsoftonline\.com$/i.test(u.hostname) },
  { authModel: 'sso-facebook',  idpName: 'Facebook',  label: 'Facebook',  test: (u) => /(^|\.)facebook\.com$/i.test(u.hostname) && /\/v[\w.]+\/dialog\/oauth/i.test(u.pathname) },
];

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return undefined;
  const lower = String(name).toLowerCase();
  for (const h of headers) {
    if (h && typeof h.name === 'string' && h.name.toLowerCase() === lower) {
      return h.value;
    }
  }
  return undefined;
}

function findBearerJwt(entry) {
  const auth = headerValue(entry.request && entry.request.headers, 'Authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return null;
  // Accept any opaque bearer token; JWT shape is preferred but not required
  // (some APIs hand out non-JWT opaque tokens). JWT_RE is exposed for callers
  // that want to assert the stronger shape.
  return m[1];
}

function findCsrfHeader(entry) {
  const hs = entry.request && entry.request.headers;
  if (!Array.isArray(hs)) return null;
  for (const h of hs) {
    if (h && typeof h.name === 'string' && CSRF_HEADER_NAMES.has(h.name.toLowerCase())) {
      return h.name;
    }
  }
  return null;
}

function findSetCookie(entry) {
  return headerValue(entry.response && entry.response.headers, 'Set-Cookie') || null;
}

/**
 * Scan a HAR for Akamai bot-management cookie names. Inspects both:
 *   - request `Cookie` header values (cookies the client already holds)
 *   - response `Set-Cookie` header values (cookies the server is issuing)
 * Returns a sorted, de-duplicated array of cookie names that were observed.
 * The cookie *value* is irrelevant -- only the *name* signals Akamai.
 */
function detectAntiBotCookies(har) {
  const entries = (har && har.log && Array.isArray(har.log.entries)) ? har.log.entries : [];
  const found = new Set();
  for (const entry of entries) {
    const reqHeaders = entry.request && entry.request.headers;
    if (Array.isArray(reqHeaders)) {
      for (const h of reqHeaders) {
        if (!h || typeof h.name !== 'string' || typeof h.value !== 'string') continue;
        if (h.name.toLowerCase() !== 'cookie') continue;
        for (const pair of h.value.split(';')) {
          const eq = pair.indexOf('=');
          const name = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
          if (AKAMAI_BOT_COOKIE_SET.has(name)) found.add(name);
        }
      }
    }
    const respHeaders = entry.response && entry.response.headers;
    if (Array.isArray(respHeaders)) {
      for (const h of respHeaders) {
        if (!h || typeof h.name !== 'string' || typeof h.value !== 'string') continue;
        if (h.name.toLowerCase() !== 'set-cookie') continue;
        // A Set-Cookie header value is "name=value; attr=...; attr". The cookie
        // name is everything up to the first '='. (HAR may also concatenate
        // multiple Set-Cookie headers; we accept either as separate entries.)
        const eq = h.value.indexOf('=');
        const name = (eq >= 0 ? h.value.slice(0, eq) : h.value).trim();
        if (AKAMAI_BOT_COOKIE_SET.has(name)) found.add(name);
      }
    }
  }
  // Preserve canonical ordering for deterministic output.
  return AKAMAI_BOT_COOKIE_NAMES.filter((n) => found.has(n));
}

function tryUrl(u) {
  try { return new URL(u); } catch { return null; }
}

function findPkceMarker(entry) {
  const url = entry.request && entry.request.url;
  if (typeof url === 'string' && /(\?|&)code_challenge_method=S256(&|$)/i.test(url)) {
    return 'code_challenge_method=S256 in request URL';
  }
  const body = entry.request && entry.request.postData && entry.request.postData.text;
  if (typeof body === 'string' && /(?:^|&|")code_verifier(?:=|"\s*:)/i.test(body)) {
    return 'code_verifier in request body';
  }
  return null;
}

function findSsoRedirect(entry) {
  const url = entry.request && entry.request.url;
  const parsed = typeof url === 'string' ? tryUrl(url) : null;
  if (!parsed) return null;
  for (const sso of SSO_HOSTS) {
    if (sso.test(parsed)) return sso;
  }
  return null;
}

/**
 * Classify a parsed HAR object.
 * @param {object} har - HAR file content (already JSON.parsed).
 * @returns {{authModel: string, evidence: Array<{url:string,signal:string}>, idpName?: string}}
 */
function classifyAuth(har) {
  const entries = (har && har.log && Array.isArray(har.log.entries)) ? har.log.entries : [];
  const evidence = [];

  let bearerEntry = null;
  let pkceEntry = null;
  let ssoEntry = null;
  let ssoMatch = null;
  let setCookieEntry = null;
  let csrfEntry = null;

  for (const e of entries) {
    const url = (e.request && e.request.url) || '';

    const pkce = findPkceMarker(e);
    if (pkce && !pkceEntry) {
      pkceEntry = { url, signal: pkce };
    }

    const sso = findSsoRedirect(e);
    if (sso && !ssoEntry) {
      ssoEntry = { url, signal: `redirect through ${sso.label} IdP host` };
      ssoMatch = sso;
    }

    const bearer = findBearerJwt(e);
    if (bearer && !bearerEntry) {
      bearerEntry = { url, signal: 'Authorization: Bearer <token>' };
    }

    const setCookie = findSetCookie(e);
    if (setCookie && !setCookieEntry) {
      setCookieEntry = { url, signal: 'Set-Cookie response header' };
    }

    const csrf = findCsrfHeader(e);
    if (csrf && !csrfEntry) {
      csrfEntry = { url, signal: `${csrf} request header` };
    }
  }

  // Priority 1: oauth2-pkce
  if (pkceEntry && bearerEntry) {
    evidence.push(pkceEntry, bearerEntry);
    return { authModel: 'oauth2-pkce', evidence };
  }

  // Priority 2-4: SSO
  if (ssoEntry && ssoMatch && bearerEntry) {
    evidence.push(ssoEntry, bearerEntry);
    return { authModel: ssoMatch.authModel, evidence, idpName: ssoMatch.idpName };
  }

  // Priority 5: plain bearer
  if (bearerEntry) {
    evidence.push(bearerEntry);
    return { authModel: 'bearer', evidence };
  }

  // Priority 6: cookie + csrf
  if (setCookieEntry && csrfEntry) {
    evidence.push(setCookieEntry, csrfEntry);
    return { authModel: 'cookie+csrf', evidence };
  }

  // Priority 7: cookie only
  if (setCookieEntry) {
    evidence.push(setCookieEntry);
    return { authModel: 'cookie', evidence };
  }

  // Priority 8: unknown - record what we did look at
  if (entries.length === 0) {
    evidence.push({ url: '', signal: 'HAR contained no entries' });
  } else {
    for (const e of entries) {
      const url = (e.request && e.request.url) || '';
      evidence.push({ url, signal: 'no auth-related signal detected' });
    }
  }
  return { authModel: 'unknown', evidence };
}

/**
 * Classify a HAR for auth AND surface any Akamai bot-management cookies as a
 * separate `antiBotCookies` field. The field is only included when at least
 * one Akamai cookie was detected; benign APIs get a clean result object.
 */
function classifyAuthWithAntiBot(har) {
  const result = classifyAuth(har);
  const antiBot = detectAntiBotCookies(har);
  if (antiBot.length > 0) {
    result.antiBotCookies = antiBot;
  }
  return result;
}

function main(argv) {
  if (argv.length < 1) {
    process.stderr.write('usage: detect-auth.js <path-to-har> [--source-label=<label>]\n');
    process.exit(2);
  }
  let harPath = null;
  let sourceLabel = null;
  for (const a of argv) {
    if (a.startsWith('--source-label=')) {
      sourceLabel = a.slice('--source-label='.length);
    } else if (a.startsWith('--')) {
      process.stderr.write(`error: unknown flag ${a}\n`);
      process.exit(2);
    } else if (harPath === null) {
      harPath = a;
    }
  }
  if (harPath === null) {
    process.stderr.write('usage: detect-auth.js <path-to-har> [--source-label=<label>]\n');
    process.exit(2);
  }
  let raw;
  try {
    raw = fs.readFileSync(harPath, 'utf8');
  } catch (err) {
    process.stderr.write(`error: cannot read ${harPath}: ${err.message}\n`);
    process.exit(1);
  }
  let har;
  try {
    har = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`error: ${harPath} is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }
  const result = classifyAuth(har);
  const antiBot = detectAntiBotCookies(har);
  if (antiBot.length > 0) {
    result.antiBotCookies = antiBot;
  }
  if (sourceLabel !== null) {
    for (const e of result.evidence) {
      e.source = sourceLabel;
    }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

module.exports = { classifyAuth, classifyAuthWithAntiBot, detectAntiBotCookies, AKAMAI_BOT_COOKIE_NAMES, JWT_RE };

if (require.main === module) {
  main(process.argv.slice(2));
}

