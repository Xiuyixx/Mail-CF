import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { readFile } from "node:fs/promises";

const password = "StrongPassword123";
const baseEnv = {
  PASSWD: password,
  DOMAIN: "example.com",
  API_KEY: "test-key",
};
const limiter = {
  idFromName: (key) => key,
  get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
};

async function login(
  env = { ...baseEnv, RATE_LIMITER: limiter },
  input = password,
) {
  const response = await worker.fetch(
    new Request("https://example.test/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.test",
      },
      body: JSON.stringify({ password: input }),
    }),
    env,
  );
  return response;
}

function cookie(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("serves both favicon routes without configuration or authentication", async () => {
  const expected = await readFile(
    new URL("./assets/mail-cf-favicon.png", import.meta.url),
  );
  for (const path of ["/favicon.png", "/favicon.ico"]) {
    const response = await worker.fetch(
      new Request(`https://example.test${path}`),
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=86400",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
});

test("login and compose pages link same-origin favicon", async () => {
  const loginPage = await worker.fetch(
    new Request("https://example.test/login"),
    {},
  );
  assert.match(
    await loginPage.text(),
    /<link rel="icon" href="\/favicon\.png"/,
  );
  const loginResponse = await login();
  const home = await worker.fetch(
    new Request("https://example.test/", {
      headers: { Cookie: cookie(loginResponse) },
    }),
    { ...baseEnv, RATE_LIMITER: limiter },
  );
  assert.match(await home.text(), /<link rel="icon" href="\/favicon\.png"/);
});

test("rejects legacy unauthenticated POST /", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/", { method: "POST", body: "{}" }),
    { RATE_LIMITER: limiter },
  );
  assert.equal(response.status, 404);
});

test("strong password login returns cookie and protected home", async () => {
  const response = await login();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  const home = await worker.fetch(
    new Request("https://example.test/", {
      headers: { Cookie: cookie(response) },
    }),
    { ...baseEnv, RATE_LIMITER: limiter },
  );
  assert.equal(home.status, 200);
  assert.match(await home.text(), /fromPrefix/);
});

test("send forwards arbitrary prefix, cc/bcc/reply_to and html", async () => {
  const env = { ...baseEnv, PASSWD: "123", RATE_LIMITER: limiter };
  const loginResponse = await login(env, "123");
  const sessionCookie = cookie(loginResponse);
  const home = await worker.fetch(
    new Request("https://example.test/", {
      headers: { Cookie: sessionCookie },
    }),
    env,
  );
  const html = await home.text();
  const csrf =
    html.match(/const csrf=([^;]+);/) &&
    JSON.parse(html.match(/const csrf=([^;]+);/)[1]);
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("api.resend.com")) {
      upstream = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    const response = await worker.fetch(
      new Request("https://example.test/api/send", {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": "retry-key-123",
        },
        body: JSON.stringify({
          to: "a@example.net",
          cc: "c@example.net",
          bcc: "b@example.net",
          fromPrefix: "billing.eu",
          fromName: "Billing",
          replyTo: "reply@example.net",
          subject: "Hi",
          text: "plain",
          html: "<b>Hi</b>",
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(upstream.from, "Billing <billing.eu@example.com>");
    assert.deepEqual(upstream.cc, ["c@example.net"]);
    assert.deepEqual(upstream.bcc, ["b@example.net"]);
    assert.equal(upstream.reply_to, "reply@example.net");
    assert.equal(upstream.html, "<b>Hi</b>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("wrong password and missing limiter fail closed", async () => {
  assert.equal(
    (await login({ PASSWD: "weak", RATE_LIMITER: limiter })).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://example.test/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        }),
        { PASSWD: password },
      )
    ).status,
    429,
  );
});

test("missing limiter fails closed", async () => {
  assert.equal((await login({ ...baseEnv })).status, 429);
});

for (const value of ["a", "123", "letters", "密码", "x".repeat(300)]) {
  test(`nonempty password accepted (${value.length} characters)`, async () => {
    const env = { ...baseEnv, PASSWD: value, RATE_LIMITER: limiter };
    const response = await login(env, value);
    assert.equal(response.status, 200);
    const home = await worker.fetch(
      new Request("https://example.test/", {
        headers: { Cookie: cookie(response) },
      }),
      env,
    );
    assert.equal(home.status, 200);
    assert.equal((await login(env, value + "wrong")).status, 401);
  });
}

test("empty and missing passwords reject login", async () => {
  for (const value of [undefined, ""]) {
    const env = { ...baseEnv, PASSWD: value, RATE_LIMITER: limiter };
    assert.equal((await login(env, "")).status, 401);
  }
});

for (const [label, variables, expectedFrom, expectedKey, expectedStatus] of [
  [
    "canonical names",
    {
      DOMAIN: "short.example",
      API_KEY: "short-key",
      PREFIX: "support",
      NAME: "Support",
    },
    "Support <support@short.example>",
    "short-key",
    200,
  ],
  [
    "missing required API key",
    { DOMAIN: "example.com", API_KEY: "" },
    null,
    null,
    503,
  ],
  ["missing required domain", { DOMAIN: "", API_KEY: "key" }, null, null, 503],
  [
    "optional defaults",
    { DOMAIN: "example.com", API_KEY: "key" },
    "noreply@example.com",
    "key",
    200,
  ],
  [
    "empty optional values use defaults",
    { DOMAIN: "example.com", API_KEY: "key", PREFIX: "", NAME: "" },
    "noreply@example.com",
    "key",
    200,
  ],
]) {
  test(`configuration: ${label}`, async () => {
    const env = { PASSWD: password, RATE_LIMITER: limiter, ...variables };
    const sessionCookie = cookie(await login(env));
    const home = await worker.fetch(
      new Request("https://example.test/", {
        headers: { Cookie: sessionCookie },
      }),
      env,
    );
    const html = await home.text();
    const csrf = JSON.parse(html.match(/const csrf=([^;]+);/)[1]);
    if (expectedStatus === 200) assert.ok(html.includes(variables.DOMAIN));
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async (url, init) => {
      called = true;
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(
        init.headers.Authorization,
        ["Bearer", expectedKey].join(" "),
      );
      assert.equal(JSON.parse(init.body).from, expectedFrom);
      return new Response(JSON.stringify({ id: "mock-email" }), {
        status: 200,
      });
    };
    try {
      const response = await worker.fetch(
        new Request("https://example.test/api/send", {
          method: "POST",
          headers: {
            Cookie: sessionCookie,
            Origin: "https://example.test",
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": "config-test-123",
          },
          body: JSON.stringify({
            to: "user@example.net",
            subject: "Config test",
            text: "Test",
          }),
        }),
        env,
      );
      assert.equal(response.status, expectedStatus);
      assert.equal(called, expectedStatus === 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("explicit empty display name overrides default and default is escaped", async () => {
  const env = {
    ...baseEnv,
    NAME: 'Support "Team" & Co',
    RATE_LIMITER: limiter,
  };
  const sessionCookie = cookie(await login(env));
  const home = await worker.fetch(
    new Request("https://example.test/", {
      headers: { Cookie: sessionCookie },
    }),
    env,
  );
  const html = await home.text();
  assert.ok(html.includes('value="Support &quot;Team&quot; &amp; Co"'));
  const csrf = JSON.parse(html.match(/const csrf=([^;]+);/)[1]);
  const originalFetch = globalThis.fetch;
  try {
    for (const fromName of ["", "   ", "Custom"]) {
      let payload;
      globalThis.fetch = async (_url, init) => {
        payload = JSON.parse(init.body);
        return Response.json({ id: "mock" });
      };
      const response = await worker.fetch(
        new Request("https://example.test/api/send", {
          method: "POST",
          headers: {
            Cookie: sessionCookie,
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": "name-test-123",
          },
          body: JSON.stringify({
            to: "a@example.net",
            subject: "Test",
            text: "Body",
            fromName,
          }),
        }),
        env,
      );
      assert.equal(response.status, 200);
      assert.equal(
        payload.from,
        fromName === "Custom"
          ? "Custom <noreply@example.com>"
          : "noreply@example.com",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [label, vars, expected] of [
  ["missing", {}, "未配置，请检查 DOMAIN"],
  [
    "empty overrides legacy",
    { DOMAIN: "", MAIL_DOMAIN: "legacy.example" },
    "未配置，请检查 DOMAIN",
  ],
  ["whitespace", { DOMAIN: "   " }, "未配置，请检查 DOMAIN"],
  ["canonical", { DOMAIN: "mail.example" }, "mail.example"],
  [
    "legacy ignored",
    { MAIL_DOMAIN: "legacy.example" },
    "未配置，请检查 DOMAIN",
  ],
]) {
  test(`sender domain display: ${label}`, async () => {
    const env = { PASSWD: password, RATE_LIMITER: limiter, ...vars };
    const sessionCookie = cookie(await login(env));
    const response = await worker.fetch(
      new Request("https://example.test/", {
        headers: { Cookie: sessionCookie },
      }),
      env,
    );
    const html = await response.text();
    assert.match(
      html,
      new RegExp("发件域名：<span[^>]*>" + expected + "</span>"),
    );
  });
}

test("old password variable is ignored", async () => {
  assert.equal(
    (await login({ Passwd: password, RATE_LIMITER: limiter })).status,
    401,
  );
});

test("recipient and attachment boundaries and request body errors", async () => {
  const env = { ...baseEnv, RATE_LIMITER: limiter };
  const sessionCookie = cookie(await login(env));
  const home = await worker.fetch(
    new Request("https://example.test/", {
      headers: { Cookie: sessionCookie },
    }),
    env,
  );
  const csrf = JSON.parse((await home.text()).match(/const csrf=([^;]+);/)[1]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ id: "mock" });
  };
  const send = (body, extra = {}) =>
    worker.fetch(
      new Request("https://example.test/api/send", {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": "boundary-test",
          ...extra,
        },
        body,
      }),
      env,
    );
  const base = { to: "a@example.net", subject: "Test", text: "Body" };
  try {
    const addresses = Array.from({ length: 50 }, (_, i) => `u${i}@example.net`);
    for (const [changes, status] of [
      [
        {
          to: addresses.slice(0, 20),
          cc: addresses.slice(20, 40),
          bcc: addresses.slice(40),
        },
        200,
      ],
      [{ to: addresses, cc: "extra@example.net" }, 400],
      [{ cc: "A@example.net" }, 400],
      [
        {
          attachments: Array.from({ length: 10 }, (_, i) => ({
            filename: `${i}.txt`,
            content: "YQ==",
          })),
        },
        200,
      ],
      [
        {
          attachments: Array.from({ length: 11 }, (_, i) => ({
            filename: `${i}.txt`,
            content: "YQ==",
          })),
        },
        413,
      ],
    ]) {
      const before = calls;
      assert.equal(
        (await send(JSON.stringify({ ...base, ...changes }))).status,
        status,
      );
      assert.equal(calls - before, status === 200 ? 1 : 0);
    }
    assert.equal((await send("{")).status, 400);
    assert.equal(
      (await send("{}", { "Content-Length": String(35 * 1024 * 1024 + 1) }))
        .status,
      413,
    );
    assert.equal((await send(" ".repeat(35 * 1024 * 1024 + 1))).status, 413);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
