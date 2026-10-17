import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ephemeral test-only certificate; keep production Secure cookies unchanged.
const certDir = mkdtempSync(join(tmpdir(), "mail-cf-tls-"));
let tls;
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  tls = {
    key: readFileSync(join(certDir, "key.pem")),
    cert: readFileSync(join(certDir, "cert.pem")),
  };
} finally {
  rmSync(certDir, { recursive: true, force: true });
}
import worker from "../index.js";
const env = {
  PASSWD: "StrongPassword123",
  DOMAIN: "example.com",
  API_KEY: "test-key",
  RATE_LIMITER: {
    idFromName: (key) => key,
    get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) =>
  String(input).includes("api.resend.com")
    ? new Response(JSON.stringify({ id: "browser-test" }), { status: 200 })
    : originalFetch(input, init);
const server = https.createServer(tls, async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`https://127.0.0.1:8789${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method)
      ? undefined
      : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(8789, "127.0.0.1");
