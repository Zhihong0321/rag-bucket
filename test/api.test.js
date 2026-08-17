import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server;
let base;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "rag-bucket-"));
  process.env.DATA_DIR = dataDir;
  process.env.RAG_BUCKET_API_KEYS = "test-key";
  // Railway may provide a bare public hostname; the service must normalize it.
  process.env.PUBLIC_BASE_URL = "rag-b.up-railway.app";
  process.env.PORT = "0";
  const module = await import(`../src/server.js?test=${Date.now()}`);
  server = module.default;
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

function auth() { return { authorization: "Bearer test-key" }; }

test("publishes a group and a Markdown document to the AI entrypoint", async () => {
  const create = await fetch(`${base}/v1/groups`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ company: "Acme", readme: "# Guide\n\nRead `pricing.md` for prices." }) });
  assert.equal(create.status, 201);

  const upload = await fetch(`${base}/v1/groups/acme/documents/pricing.md?description=Official+prices`, { method: "PUT", headers: auth(), body: "# Prices\n\nStarter costs $10." });
  assert.equal(upload.status, 200);

  const entry = await fetch(`${base}/r/acme`);
  assert.equal(entry.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(await entry.text(), /pricing\.md/);

  const document = await fetch(`${base}/r/acme/docs/pricing.md`);
  assert.match(await document.text(), /Starter costs \$10/);

  const pageUpload = await fetch(`${base}/v1/groups/acme/pages/index.html`, { method: "PUT", headers: auth(), body: "<!doctype html><title>Acme</title><h1>Welcome</h1>" });
  assert.equal(pageUpload.status, 200);

  const page = await fetch(`${base}/r/acme/site`);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await page.text(), /Welcome/);
});

test("does not expose the publishing API without a bearer key", async () => {
  const response = await fetch(`${base}/v1/groups/acme`);
  assert.equal(response.status, 401);
});

test("exposes API documentation as HTML, Markdown, and OpenAPI", async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");

  const docs = await fetch(`${base}/docs`);
  assert.equal(docs.headers.get("content-type"), "text/html; charset=utf-8");

  const markdown = await fetch(`${base}/api.md`);
  assert.match(markdown.headers.get("content-type"), /text\/markdown/);
  assert.match(await markdown.text(), /Create a group/);

  const openapi = await (await fetch(`${base}/openapi.json`)).json();
  assert.equal(openapi.openapi, "3.1.0");
  assert.ok(openapi.paths["/v1/groups"]);
});
