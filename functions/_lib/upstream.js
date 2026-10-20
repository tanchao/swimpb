// USA Swimming sign-in and Data Hub proxy for Cloudflare Pages.
//
// There is no server-side session. Each browser sends its own X-Bff-Session,
// and a sign-in returns the cookie only in that response. Do not add a KV key,
// a global, or SWIMPB_USER / SWIMPB_PASS here — serve.py may keep one session
// for a single local user, and this file must not.

const UPSTREAM = "https://data.usaswimming.org";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

export const API_PREFIXES = [
  "/api/times/swims/",
  "/api/meet/swims/",
  "/api/person/swims/",
  "/api/common/swims/",
];

const MAX_LOGIN_BODY = 8 * 1024;
const MAX_PROXY_BODY = 1024 * 1024;
const SESSION_RE = /^[A-Za-z0-9_\-~.%+=/]{20,}$/;

export function isProxiedPath(pathname) {
  return API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function text(status, message) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, ent) => {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    const code = ent.startsWith("#x") ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of raw.matchAll(re)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[match[1]] = decodeEntities(value);
  }
  return attrs;
}

function attr(attrs, name) {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(attrs)) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
}

/** @returns {{action:string, method:string, inputs:Record<string, string>}[]} */
export function parseForms(html) {
  const forms = [];
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = parseAttrs(match[1]);
    const inputs = {};
    for (const input of match[2].matchAll(/<input\b([^>]*)\/?>/gi)) {
      const fields = parseAttrs(input[1]);
      const name = attr(fields, "name");
      const type = (attr(fields, "type") || "").toLowerCase();
      if (!name || type === "submit") continue;
      inputs[name] = attr(fields, "value") || "";
    }
    forms.push({
      action: attr(attrs, "action") || "",
      method: (attr(attrs, "method") || "get").toLowerCase(),
      inputs,
    });
  }
  return forms;
}

export function validationErrors(html) {
  const start = html.search(/class="[^"]*validation-summary-errors/);
  if (start < 0) return [];
  const slice = html.slice(start, start + 4000);
  const errors = [];
  for (const match of slice.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = decodeEntities(match[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (text) errors.push(text);
  }
  return errors;
}

function defaultPath(pathname) {
  if (!pathname.startsWith("/")) return "/";
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash);
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

export function parseSetCookie(raw, requestUrl) {
  const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
  const eq = parts[0]?.indexOf("=") ?? -1;
  if (eq <= 0) return null;
  const name = parts[0].slice(0, eq).trim();
  const value = parts[0].slice(eq + 1).trim();
  if (!name || /[\r\n;]/.test(name) || /[\r\n;]/.test(value)) return null;

  const request = new URL(requestUrl);
  let domain = request.hostname.toLowerCase();
  let hostOnly = true;
  let path = "";
  let secure = false;
  let maxAge = null;
  for (const part of parts.slice(1)) {
    const i = part.indexOf("=");
    const key = (i === -1 ? part : part.slice(0, i)).trim().toLowerCase();
    const attrValue = i === -1 ? "" : part.slice(i + 1).trim();
    if (key === "domain" && attrValue) {
      domain = attrValue.replace(/^\./, "").toLowerCase();
      hostOnly = false;
    } else if (key === "path") {
      path = attrValue;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "max-age") {
      maxAge = attrValue;
    }
  }
  const host = request.hostname.toLowerCase();
  if (!hostOnly && host !== domain && !host.endsWith(`.${domain}`)) return null;
  if (!path.startsWith("/")) path = defaultPath(request.pathname);
  return { name, value, domain, hostOnly, path, secure, maxAge };
}

export class CookieJar {
  constructor() {
    this.cookies = [];
  }

  absorb(url, headers) {
    const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const raw of list) this.store(url, raw);
  }

  store(url, raw) {
    const parsed = parseSetCookie(raw, url);
    if (!parsed) return;
    this.cookies = this.cookies.filter(
      (cookie) =>
        !(cookie.name === parsed.name && cookie.domain === parsed.domain && cookie.path === parsed.path),
    );
    if (parsed.maxAge === "0" || parsed.maxAge === "-1") return;
    this.cookies.push(parsed);
  }

  headerFor(url) {
    const target = new URL(url);
    const pairs = [];
    for (const cookie of this.cookies) {
      if (cookie.secure && target.protocol !== "https:") continue;
      const host = target.hostname.toLowerCase();
      const hostOk = cookie.hostOnly
        ? host === cookie.domain
        : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
      if (!hostOk || !pathMatches(target.pathname, cookie.path)) continue;
      pairs.push(`${cookie.name}=${cookie.value}`);
    }
    return pairs.join("; ");
  }

  get(name) {
    for (let i = this.cookies.length - 1; i >= 0; i--) {
      if (this.cookies[i].name === name && this.cookies[i].value) return this.cookies[i].value;
    }
    return null;
  }
}

async function fetchFollowing(url, init, jar, fetchImpl) {
  let current = url;
  let method = (init.method || "GET").toUpperCase();
  let body = init.body;
  const baseHeaders = new Headers(init.headers || {});
  let firstHop = true;

  for (let hop = 0; hop < 10; hop++) {
    const headers = new Headers(baseHeaders);
    if (method === "GET" || method === "HEAD") {
      headers.delete("Content-Type");
      headers.delete("Content-Length");
      body = undefined;
    }
    // The OIDC callback is a cross-site form post, so the first hop keeps the
    // caller's Origin and Referer. Redirects must not carry them to a new host.
    if (!firstHop) {
      headers.delete("Origin");
      headers.delete("Referer");
    }
    firstHop = false;
    const cookie = jar.headerFor(current);
    if (cookie) headers.set("Cookie", cookie);
    else headers.delete("Cookie");

    const response = await fetchImpl(current, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    jar.absorb(current, response.headers);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location) return { url: current, status: response.status, headers: response.headers, text: "" };
      if (response.status !== 307 && response.status !== 308) method = "GET";
      current = new URL(location, current).href;
      continue;
    }

    return {
      url: current,
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  }
  throw new Error("Too many redirects.");
}

export async function usasLogin(username, password, fetchImpl = fetch) {
  const name = (username || "").trim();
  if (!name || !password) return { token: null, error: "Username and password are required." };

  const jar = new CookieJar();
  let page;
  try {
    page = await fetchFollowing(
      `${UPSTREAM}/bff/login`,
      {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": USER_AGENT,
        },
      },
      jar,
      fetchImpl,
    );
  } catch (err) {
    return { token: null, error: `Could not reach USA Swimming login page: ${err.message}` };
  }

  const forms = parseForms(page.text);
  const loginForm = forms.find((form) => Object.hasOwn(form.inputs, "ReturnUrl")) || forms[0];
  if (!loginForm) return { token: null, error: "Unexpected login page structure from USA Swimming." };

  const fields = {
    ...loginForm.inputs,
    Username: name,
    Password: password,
    loginButton: "login",
  };
  let posted;
  try {
    posted = await fetchFollowing(
      new URL(loginForm.action || "/Login", page.url).href,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://login.usaswimming.org",
          Referer: page.url,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams(fields).toString(),
      },
      jar,
      fetchImpl,
    );
  } catch (err) {
    return { token: null, error: `Login submission failed: ${err.message}` };
  }

  if (jar.get("bff_auth_session")) return { token: jar.get("bff_auth_session"), error: null };

  const errors = validationErrors(posted.text);
  if (errors.length) return { token: null, error: errors.join(" ") };

  const oidcForm = parseForms(posted.text).find(
    (form) => form.action.includes("signin-oidc") || Object.hasOwn(form.inputs, "code") || Object.hasOwn(form.inputs, "id_token"),
  );
  if (!oidcForm) return { token: null, error: "USA Swimming rejected the sign-in (check your username/password)." };

  try {
    await fetchFollowing(
      new URL(oidcForm.action, posted.url).href,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://login.usaswimming.org",
          Referer: posted.url,
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams(oidcForm.inputs).toString(),
      },
      jar,
      fetchImpl,
    );
  } catch {
    // The cookie can already be in the jar when the callback itself fails.
  }

  const token = jar.get("bff_auth_session");
  if (token) return { token, error: null };
  return { token: null, error: "USA Swimming sign-in completed without issuing a session cookie." };
}

function readClientSession(header) {
  if (header == null || header.trim() === "") return { token: null, invalid: false };
  const token = header.trim();
  if (!SESSION_RE.test(token)) return { token: null, invalid: true };
  return { token, invalid: false };
}

function rotatedSession(headers, requestUrl) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const raw of list) {
    const parsed = parseSetCookie(raw, requestUrl);
    if (parsed?.name === "bff_auth_session" && parsed.value) return parsed.value;
  }
  return null;
}

async function handleLogin(request, fetchImpl) {
  if (request.method !== "POST") return text(405, "Method Not Allowed");
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_LOGIN_BODY) return json(413, { ok: false, error: "Sign-in request is too large." });
  const raw = await request.text();
  if (raw.length > MAX_LOGIN_BODY) return json(413, { ok: false, error: "Sign-in request is too large." });

  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body." });
  }
  if (!data || typeof data !== "object") return json(400, { ok: false, error: "Invalid JSON body." });

  const username = typeof data.username === "string" ? data.username : "";
  const password = typeof data.password === "string" ? data.password : "";
  const result = await usasLogin(username, password, fetchImpl);
  if (result.token) return json(200, { ok: true, bffSession: result.token });
  return json(401, { ok: false, error: result.error || "Sign-in failed." });
}

function handleLogout(request) {
  if (request.method !== "POST") return text(405, "Method Not Allowed");
  return json(200, { ok: true });
}

async function handleProxy(request, fetchImpl) {
  if (request.method !== "GET" && request.method !== "POST") return text(405, "Method Not Allowed");
  const incoming = new URL(request.url);
  if (incoming.pathname.includes("..")) return text(400, "Invalid path.");

  const session = readClientSession(request.headers.get("X-Bff-Session"));
  if (session.invalid) return text(400, "Invalid session.");

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_PROXY_BODY) return text(413, "Request is too large.");
  const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > MAX_PROXY_BODY) return text(413, "Request is too large.");

  const deviceId = request.headers.get("Device-Id");
  const contentType = request.headers.get("Content-Type");
  let token = session.token;
  let method = request.method;
  let payload = body;
  let latestRotated = null;
  let current = new URL(incoming.pathname + incoming.search, UPSTREAM);
  if (current.origin !== UPSTREAM) return text(400, "Invalid path.");

  for (let hop = 0; hop < 5; hop++) {
    const headers = new Headers();
    headers.set("Accept", "application/json, */*");
    headers.set("User-Agent", USER_AGENT);
    headers.set("X-CSRF", "1");
    if (deviceId && !/[\r\n]/.test(deviceId)) headers.set("Device-Id", deviceId);
    if (method === "POST" && contentType && !/[\r\n]/.test(contentType)) headers.set("Content-Type", contentType);
    if (token) headers.set("Cookie", `bff_auth_session=${token}`);

    let response;
    try {
      response = await fetchImpl(current, {
        method,
        headers,
        body: method === "GET" ? undefined : payload,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return text(502, `Upstream request failed: ${err.message}`);
    }

    const rotated = rotatedSession(response.headers, current);
    if (rotated) {
      token = rotated;
      latestRotated = rotated;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location) return text(502, "Upstream redirect had no destination.");
      const next = new URL(location, current);
      if (next.origin !== UPSTREAM) return text(502, "Upstream redirect left USA Swimming.");
      if (response.status !== 307 && response.status !== 308) method = "GET";
      current = next;
      continue;
    }

    const outHeaders = new Headers();
    outHeaders.set("Content-Type", response.headers.get("Content-Type") || "application/json");
    outHeaders.set("Cache-Control", "no-store");
    if (latestRotated) outHeaders.set("X-Bff-Session", latestRotated);
    return new Response(await response.arrayBuffer(), { status: response.status, headers: outHeaders });
  }
  return text(502, "Upstream request failed: Too many redirects.");
}

export async function handleApi(request, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login") return handleLogin(request, fetchImpl);
  if (url.pathname === "/api/auth/logout") return handleLogout(request);
  if (isProxiedPath(url.pathname)) return handleProxy(request, fetchImpl);
  return text(404, "Not Found");
}
