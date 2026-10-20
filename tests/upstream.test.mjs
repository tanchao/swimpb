// Run: node tests/upstream.test.mjs
//
// The Pages Function must not keep a session of its own. These checks use a
// scripted fetch and synthetic cookies — never a live USA Swimming login.

import assert from "node:assert/strict";
import { CookieJar, handleApi, parseForms, usasLogin } from "../functions/_lib/upstream.js";

let pass = 0;
const fails = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fails.push(`${name}: ${err.message}`);
  }
}

const TOKEN_A = "CfDJ8SyntheticSessionA0123456789_abcdef-GHIJKL";
const TOKEN_B = "CfDJ8SyntheticSessionB0123456789_abcdef-GHIJKL";
const LOGIN_HTML = `
  <form method="post" action="/Login">
    <input type="hidden" name="ReturnUrl" value="/connect/authorize/callback?client_id=DataHub&amp;scope=openid" />
    <input type="text" name="Username" value="" />
    <input type="password" name="Password" />
    <input name="__RequestVerificationToken" type="hidden" value="anti-form" />
    <button type="submit" name="loginButton" value="login">LOGIN</button>
  </form>
  <form method="post" action="/Login">
    <input name="Email" type="hidden" value="" />
  </form>`;
const OIDC_HTML = `
  <form method="post" action="https://data.usaswimming.org/signin-oidc">
    <input type="hidden" name="code" value="auth-code" />
    <input type="hidden" name="state" value="state-1" />
  </form>`;

function response(status, body, { location, cookies = [], type = "text/html; charset=utf-8" } = {}) {
  const headers = new Headers({ "Content-Type": type });
  if (location) headers.set("Location", location);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

await check("parses the ReturnUrl form and decodes entities", async () => {
  const forms = parseForms(LOGIN_HTML);
  assert.equal(forms.length, 2);
  assert.equal(
    forms[0].inputs.ReturnUrl,
    "/connect/authorize/callback?client_id=DataHub&scope=openid",
  );
  assert.equal(forms[0].inputs.__RequestVerificationToken, "anti-form");
  assert.equal(Object.hasOwn(forms[0].inputs, "loginButton"), false);
});

await check("sends the nonce cookie only back to signin-oidc", async () => {
  const jar = new CookieJar();
  jar.store(
    "https://data.usaswimming.org/bff/login",
    ".AspNetCore.OpenIdConnect.Nonce.abc=N; path=/signin-oidc; secure; httponly",
  );
  jar.store(
    "https://login.usaswimming.org/Login",
    ".AspNetCore.Antiforgery.token=ANTI; path=/; secure; httponly",
  );
  assert.equal(jar.headerFor("https://data.usaswimming.org/bff/login"), "");
  assert.equal(
    jar.headerFor("https://login.usaswimming.org/connect/authorize"),
    ".AspNetCore.Antiforgery.token=ANTI",
  );
  assert.equal(
    jar.headerFor("https://login.usaswimming.org/Login"),
    ".AspNetCore.Antiforgery.token=ANTI",
  );
  assert.equal(
    jar.headerFor("https://data.usaswimming.org/signin-oidc"),
    ".AspNetCore.OpenIdConnect.Nonce.abc=N",
  );
});

await check("sign-in posts the password once and returns only that browser's cookie", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    if (url === "https://data.usaswimming.org/bff/login") {
      return response(302, "", {
        location: "https://login.usaswimming.org/connect/authorize?x=1",
        cookies: [".AspNetCore.OpenIdConnect.Nonce.abc=N; path=/signin-oidc; secure; httponly"],
      });
    }
    if (url === "https://login.usaswimming.org/connect/authorize?x=1") {
      return response(302, "", { location: "https://login.usaswimming.org/Login?ReturnUrl=%2Fcallback" });
    }
    if (url.startsWith("https://login.usaswimming.org/Login")) {
      if (init.method === "GET") {
        return response(200, LOGIN_HTML, {
          cookies: [".AspNetCore.Antiforgery.token=ANTI; path=/; secure; httponly"],
        });
      }
      return response(200, OIDC_HTML);
    }
    if (url === "https://data.usaswimming.org/signin-oidc") {
      return response(200, "", {
        cookies: [`bff_auth_session=${TOKEN_A}; path=/; secure; httponly`],
      });
    }
    throw new Error(`unexpected fetch ${init.method} ${url}`);
  };

  const result = await usasLogin("swimmer", "pool-secret", fetchImpl);
  assert.equal(result.error, null);
  assert.equal(result.token, TOKEN_A);

  const posted = calls.find((call) => call.method === "POST" && call.url.startsWith("https://login.usaswimming.org/Login"));
  const fields = new URLSearchParams(posted.body);
  assert.equal(fields.get("Username"), "swimmer");
  assert.equal(fields.get("Password"), "pool-secret");
  assert.equal(fields.get("loginButton"), "login");
  assert.equal(fields.get("__RequestVerificationToken"), "anti-form");
  assert.equal(fields.get("ReturnUrl"), "/connect/authorize/callback?client_id=DataHub&scope=openid");
  assert.match(posted.headers.get("Cookie"), /Antiforgery\.token=ANTI/);
  assert.doesNotMatch(posted.headers.get("Cookie") || "", /Nonce/);

  const oidc = calls.find((call) => call.url === "https://data.usaswimming.org/signin-oidc");
  assert.match(oidc.headers.get("Cookie"), /Nonce\.abc=N/);
  assert.doesNotMatch(oidc.headers.get("Cookie"), /Antiforgery/);
  assert.equal(oidc.headers.get("Origin"), "https://login.usaswimming.org");
  assert.equal(calls.filter((call) => String(call.body || "").includes("pool-secret")).length, 1);
});

await check("a rejected sign-in returns the page error and stops", async () => {
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") posts++;
    if (url === "https://data.usaswimming.org/bff/login") {
      return response(302, "", { location: "https://login.usaswimming.org/Login" });
    }
    if (init.method === "GET") return response(200, LOGIN_HTML);
    return response(200, `<div class="validation-summary-errors"><ul><li>Invalid username or password</li></ul></div>`);
  };
  const result = await usasLogin("swimmer", "nope", fetchImpl);
  assert.equal(result.token, null);
  assert.equal(result.error, "Invalid username or password");
  assert.equal(posts, 1);
});

await check("two browsers do not share a session", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.get("Cookie"));
    return response(200, JSON.stringify({ ok: true }), { type: "application/json", cookies: [] });
  };
  const call = (token) =>
    handleApi(
      new Request("https://swim.tanchao.xyz/api/times/swims/TimesSearch/GetMember/abc", {
        headers: token ? { "X-Bff-Session": token, "Device-Id": "device-1" } : { "Device-Id": "device-1" },
      }),
      fetchImpl,
    );

  const first = await call(TOKEN_A);
  const second = await call(TOKEN_B);
  const anon = await call("");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(anon.status, 200);
  assert.deepEqual(seen, [
    `bff_auth_session=${TOKEN_A}`,
    `bff_auth_session=${TOKEN_B}`,
    null,
  ]);
});

await check("login does not leave a session for the next caller", async () => {
  const fetchImpl = async (url, init) => {
    if (url === "https://data.usaswimming.org/bff/login") {
      return response(302, "", { location: "https://login.usaswimming.org/Login" });
    }
    if (url.startsWith("https://login.usaswimming.org/Login") && init.method === "GET") {
      return response(200, LOGIN_HTML);
    }
    if (init.method === "POST" && String(url).startsWith("https://login.usaswimming.org/Login")) {
      return response(200, OIDC_HTML);
    }
    if (url === "https://data.usaswimming.org/signin-oidc") {
      return response(200, "", { cookies: [`bff_auth_session=${TOKEN_A}; path=/; secure; httponly`] });
    }
    return response(200, "[]", { type: "application/json" });
  };

  const login = await handleApi(
    new Request("https://swim.tanchao.xyz/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "swimmer", password: "pool-secret" }),
    }),
    fetchImpl,
  );
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.bffSession, TOKEN_A);
  assert.equal(loginBody.password, undefined);

  let cookie = "unset";
  const after = await handleApi(
    new Request("https://swim.tanchao.xyz/api/times/swims/SearchFilter/GetLscs"),
    async (_url, init) => {
      cookie = init.headers.get("Cookie");
      return response(200, "[]", { type: "application/json" });
    },
  );
  assert.equal(after.status, 200);
  assert.equal(cookie, null);
});

await check("a rotated upstream cookie is returned only on that response", async () => {
  const rotated = await handleApi(
    new Request("https://swim.tanchao.xyz/api/times/swims/TimesSearch/GetMember/abc", {
      headers: { "X-Bff-Session": TOKEN_A },
    }),
    async () =>
      response(200, "{}", {
        type: "application/json",
        cookies: [`bff_auth_session=${TOKEN_B}; path=/; secure; httponly`],
      }),
  );
  assert.equal(rotated.headers.get("X-Bff-Session"), TOKEN_B);

  let cookie = "unset";
  await handleApi(
    new Request("https://swim.tanchao.xyz/api/times/swims/TimesSearch/GetMember/abc", {
      headers: { "X-Bff-Session": TOKEN_A },
    }),
    async (_url, init) => {
      cookie = init.headers.get("Cookie");
      return response(200, "{}", { type: "application/json" });
    },
  );
  assert.equal(cookie, `bff_auth_session=${TOKEN_A}`);
});

await check("an injected session header is refused before any upstream call", async () => {
  let called = 0;
  const res = await handleApi(
    new Request("https://swim.tanchao.xyz/api/times/swims/TimesSearch/GetMember/abc", {
      headers: { "X-Bff-Session": `${TOKEN_A}; other=1` },
    }),
    async () => {
      called++;
      return response(200, "{}");
    },
  );
  assert.equal(res.status, 400);
  assert.equal(called, 0);
});

await check("paths outside the Data Hub prefixes are not forwarded", async () => {
  let called = 0;
  const res = await handleApi(
    new Request("https://swim.tanchao.xyz/api/auth/../../bff/login"),
    async () => {
      called++;
      return response(200, "{}");
    },
  );
  assert.equal(res.status, 404);
  assert.equal(called, 0);
});

await check("logout has nothing to clear", async () => {
  const res = await handleApi(
    new Request("https://swim.tanchao.xyz/api/auth/logout", { method: "POST" }),
    async () => {
      throw new Error("logout must not call upstream");
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const failure of fails) console.log(`  FAIL  ${failure}`);
process.exit(fails.length ? 1 : 0);
