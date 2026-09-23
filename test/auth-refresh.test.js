"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { Readable } = require("node:stream");
const test = require("node:test");
const { Response } = require("node-fetch");

// Real Homey OAuth2 request parsing, single-flight refresh and retry machinery.
// Only Homey's runtime and HTTP I/O are replaced; no mower/cloud is contacted.
let respond;
const originalLoad = Module._load;
let Client;
try {
  Module._load = function (request, ...args) {
    if (request === "homey") return { env: {
      MAMMOTION_AUTH_FLOW: "signed_oauth2",
      MAMMOTION_OAUTH2_CLIENT_ID: "test-client",
      MAMMOTION_OAUTH2_CLIENT_SECRET: "test-secret",
    } };
    if (request === "node-fetch") return (...input) => respond(...input);
    if (request === "homey-oauth2app") return {
      OAuth2Client: require("homey-oauth2app/lib/OAuth2Client"),
      OAuth2Token: require("homey-oauth2app/lib/OAuth2Token"),
      OAuth2Error: require("homey-oauth2app/lib/OAuth2Error"),
      fetch: (...input) => respond(...input),
    };
    return originalLoad.call(this, request, ...args);
  };
  Client = require("../.homeybuild/lib/MammotionOAuth2Client").default;
} finally { Module._load = originalLoad; }

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const unauthenticated = () => json({ code: 401, msg: "Access to this resource requires authentication" });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function fixture({ api, refresh } = {}) {
  const client = new Client({
    apiUrl: "https://api.example.test", token: Client.TOKEN,
    homey: { manifest: { version: "1.3.8" } },
  });
  const previousToken = new Client.TOKEN({
    access_token: "expired-access", refresh_token: "valid-refresh", token_type: "bearer",
    authorization_code: "existing-code", userInformation: { userAccount: "42", userId: "fixture" },
  });
  client.setToken({ token: previousToken });
  const state = { calls: [], refreshes: 0, saves: 0, logs: [], previousToken };
  client.on("save", () => { state.saves++; });
  client.on("log", (...args) => state.logs.push(args));
  client.on("error", (...args) => state.logs.push(args));
  respond = async (url, opts) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://id.mammotion.com" && parsed.pathname === "/oauth2/token") {
      state.refreshes++;
      assert.equal(parsed.searchParams.get("grant_type"), "refresh_token");
      assert.ok(opts.headers["Ma-Signature"]);
      return refresh ? refresh(parsed, opts, state) : json({ code: 0, data: {
        access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600,
      } });
    }
    assert.equal(parsed.origin, "https://api.example.test", "unexpected external request");
    state.calls.push({ path: parsed.pathname, method: opts.method, body: opts.body, authorization: opts.headers.Authorization });
    return api ? api(parsed, opts, state) : opts.headers.Authorization === "Bearer expired-access"
      ? unauthenticated() : json({ code: 0, data: { online: true } });
  };
  return { client, state };
}

test("HTTP 200 with JSON 401 renews and persists the session, then retries GET once", async () => {
  const { client, state } = fixture();
  assert.deepEqual(await client.get({ path: "/status" }), { code: 0, data: { online: true } });
  assert.equal(state.refreshes, 1);
  assert.equal(state.saves, 1);
  assert.deepEqual(state.calls.map(c => c.authorization), ["Bearer expired-access", "Bearer fresh-access"]);
  assert.equal(client.getToken().refresh_token, "rotated-refresh");
  assert.equal(client.getToken().authorization_code, "existing-code");
  assert.deepEqual(client.getToken().userInformation, state.previousToken.userInformation);
});

test("string JSON 401 retries a rejected POST with exactly the same payload once", async () => {
  const { client, state } = fixture({ api: (_url, opts) => opts.headers.Authorization === "Bearer expired-access"
    ? json({ code: "401" }) : json({ code: 0 }) });
  await client.post({ path: "/rpc", json: { content: "synthetic-command" }, headers: { "Request-Id": "fixture-id" } });
  assert.equal(state.refreshes, 1);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0].body, state.calls[1].body);
  assert.deepEqual(state.calls.map(c => c.method), ["POST", "POST"]);
});

test("ordinary HTTP 401 retains the SDK's existing refresh behavior", async () => {
  const { client, state } = fixture({ api: (_url, opts) => opts.headers.Authorization === "Bearer expired-access"
    ? json({ code: 401 }, 401) : json({ code: 0 }) });
  assert.deepEqual(await client.get({ path: "/status" }), { code: 0 });
  assert.equal(state.refreshes, 1);
  assert.equal(state.calls.length, 2);
});

test("a second JSON rejection stops instead of entering a refresh/retry loop", async () => {
  const { client, state } = fixture({ api: () => unauthenticated() });
  await assert.rejects(client.get({ path: "/status" }), /still rejected after token refresh/);
  assert.equal(state.refreshes, 1);
  assert.equal(state.calls.length, 2);
});

test("HTTP 401 followed by JSON 401 cannot trigger a second refresh", async () => {
  const { client, state } = fixture({ api: (_url, opts) => opts.headers.Authorization === "Bearer expired-access"
    ? json({ code: 401 }, 401) : unauthenticated() });
  await assert.rejects(client.get({ path: "/status" }), /still rejected after token refresh/);
  assert.equal(state.refreshes, 1);
  assert.equal(state.calls.length, 2);
});

test("concurrent expired responses share one refresh", async () => {
  const gate = deferred();
  const { client, state } = fixture({ refresh: () => gate.promise });
  const requests = [client.get({ path: "/one" }), client.get({ path: "/two" })];
  await flush();
  assert.equal(state.refreshes, 1);
  gate.resolve(json({ code: 0, data: { access_token: "fresh-access", refresh_token: "rotated-refresh" } }));
  await Promise.all(requests);
  assert.equal(state.refreshes, 1);
  assert.equal(state.saves, 1);
  assert.equal(state.calls.length, 4);
});

test("late rejection of an old token reuses the already-refreshed session", async () => {
  const gate = deferred();
  const { client, state } = fixture({ api: (url, opts) => {
    if (opts.headers.Authorization !== "Bearer expired-access") return json({ code: 0 });
    return url.pathname === "/late" ? gate.promise : unauthenticated();
  } });
  const first = client.get({ path: "/first" });
  const late = client.get({ path: "/late" });
  await first;
  gate.resolve(unauthenticated());
  await late;
  assert.equal(state.refreshes, 1);
  assert.equal(state.calls.length, 4);
});

test("failed refresh propagates without replaying a command or discarding the old token", async () => {
  const { client, state } = fixture({ refresh: () => json({ code: 401, msg: "Refresh token revoked" }) });
  await assert.rejects(client.post({ path: "/rpc", json: { fixture: true } }), /Refresh token revoked/);
  assert.equal(state.refreshes, 1);
  assert.equal(state.calls.length, 1);
  assert.equal(state.saves, 0);
  assert.equal(client.getToken(), state.previousToken);
});

test("missing replacement refresh token preserves the existing credential", async () => {
  const { client, state } = fixture({ refresh: () => json({ code: 0, data: { access_token: "fresh-access" } }) });
  await client.get({ path: "/status" });
  assert.equal(client.getToken().refresh_token, "valid-refresh");
  assert.equal(state.saves, 1);
});

test("invalid refresh response cannot replace the persisted session", async () => {
  const { client, state } = fixture({ refresh: () => json({ code: 0, data: {} }) });
  await assert.rejects(client.get({ path: "/status" }), /did not return an access token/);
  assert.equal(client.getToken(), state.previousToken);
  assert.equal(state.saves, 0);
  assert.equal(state.calls.length, 1);
});

test("success, mower rejection, offline, gateway timeout and unrelated nested 401 are not retried", async () => {
  for (const body of [{ code: 0 }, { code: 200 }, { code: 1 }, { code: 50103 }, { code: 20056 }, { code: 429 }, { code: 0, data: { code: 401 } }]) {
    const { client, state } = fixture({ api: () => json(body) });
    assert.deepEqual(await client.post({ path: "/rpc", json: { fixture: true } }), body);
    assert.equal(state.refreshes, 0);
    assert.equal(state.calls.length, 1);
  }
});

test("network failure and HTTP rate limit do not refresh or replay the request", async () => {
  for (const api of [() => { throw new Error("Network timeout"); }, () => json({}, 429)]) {
    const { client, state } = fixture({ api });
    await assert.rejects(client.post({ path: "/rpc", json: {} }), /Network timeout|Rate Limited/);
    assert.equal(state.refreshes, 0);
    assert.equal(state.calls.length, 1);
  }
});

test("large streamed JSON is consumed once without clone backpressure or lost content", { timeout: 2000 }, async () => {
  const body = { code: 0, data: "x".repeat(200_000) };
  const text = JSON.stringify(body);
  const { client, state } = fixture({ api: () => new Response(Readable.from((async function* () {
    for (let i = 0; i < text.length; i += 4096) yield Buffer.from(text.slice(i, i + 4096));
  })()), { headers: { "Content-Type": "application/json" } }) });
  assert.deepEqual(await client.get({ path: "/status" }), body);
  assert.equal(state.refreshes, 0);
});
