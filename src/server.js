import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
function normalizePublicBaseUrl(value) {
  const candidate = String(value || `http://localhost:${PORT}`).trim().replace(/\/$/, "");
  const absolute = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  try { return new URL(absolute).origin; }
  catch { throw new Error("PUBLIC_BASE_URL must be a valid hostname or http(s) URL."); }
}

const PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_README_BYTES = 512 * 1024;
const API_KEYS = (process.env.RAG_BUCKET_API_KEYS || (process.env.NODE_ENV === "production" ? "" : "local-development-key"))
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === "production" && API_KEYS.length === 0) {
  throw new Error("RAG_BUCKET_API_KEYS is required in production.");
}

const GROUPS_DIR = join(DATA_DIR, "groups");
const MIME = {
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
};

function apiError(status, message, code = "request_error") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function slugify(value, field = "name") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length < 2 || slug.length > 80) throw apiError(400, `${field} must produce a 2-80 character URL-safe slug.`);
  return slug;
}

function documentName(value) {
  const name = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.md$/i.test(name) || name.toLowerCase() === "readme.md") {
    throw apiError(400, "filename must be a descriptive .md filename (README.md is reserved).");
  }
  return name;
}

function groupDir(slug) {
  const target = resolve(GROUPS_DIR, slug);
  if (!target.startsWith(`${GROUPS_DIR}${sep}`)) throw apiError(400, "Invalid group identifier.");
  return target;
}

function docPath(slug, filename) {
  const target = resolve(groupDir(slug), "docs", filename);
  const allowed = `${resolve(groupDir(slug), "docs")}${sep}`;
  if (!target.startsWith(allowed)) throw apiError(400, "Invalid document filename.");
  return target;
}

async function exists(path) {
  try { await readFile(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw apiError(404, "Group not found.", "not_found"); throw error; }
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": MIME.json, "cache-control": "no-store" });
  res.end(JSON.stringify(value, null, 2));
}

function markdown(res, status, body, cacheControl = "public, max-age=300") {
  res.writeHead(status, {
    "content-type": MIME.markdown,
    "content-disposition": "inline",
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "x-robots-tag": "all",
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { "content-type": MIME.html, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" });
  res.end(body);
}

/*
function apiMarkdown() {
  return `# RAG Bucket API\n\nBase URL: \`${PUBLIC_BASE_URL}\`\n\nRAG Bucket stores Markdown knowledge by company group. Write endpoints require \`Authorization: Bearer <RAG_BUCKET_API_KEY>\`. Public read routes need no authentication and are intended for ChatGPT and other AI web fetchers.\n\n## Public retrieval\n\n| Method | Path | Description |\n| --- | --- | --- |\n| GET | \`/r/:group\` | AI entrypoint: reading guide and source-document links. Start here. |\n| GET | \`/r/:group/README.md\` | The group retrieval guide. |\n| GET | \`/r/:group/docs/:filename\` | A source Markdown document. |\n| GET | \`/r/:group/index.json\` | Machine-readable group and document catalogue. |\n| GET | \`/r/:group/llms.txt\` | AI-friendly alias for the entrypoint. |\n| GET | \`/llms.txt\` | Service-level AI discovery file. |\n| GET | \`/robots.txt\` | Crawler policy allowing OpenAI/ChatGPT access. |\n\n## Publishing API\n\n### Create a group\n\n\`POST /v1/groups\`\n\n\`Content-Type: application/json\`\n\n\`\`\`json\n{\n  "company": "Acme Inc",\n  "slug": "acme",\n  "description": "Product and support knowledge",\n  "readme": "# Acme retrieval guide\\n\\n- Pricing: read \\`pricing-and-plans.md\\`."\n}\n\`\`\`\n\n\`slug\` is optional and is generated from \`company\` when omitted. The group README is the retrieval policy that tells an AI which documents to use.\n\n### Upload or replace a document\n\n\`PUT /v1/groups/:group/documents/:filename?description=...\`\n\nSend the raw Markdown body. The filename must be a descriptive \`.md\` file; \`README.md\` is reserved. Maximum size: 5 MB.\n\n\`\`\`bash\ncurl --upload-file ./pricing-and-plans.md \\\n  -X PUT "${PUBLIC_BASE_URL}/v1/groups/acme/documents/pricing-and-plans.md?description=Current%20pricing" \\\n  -H "Authorization: Bearer $RAG_BUCKET_API_KEY" \\\n  -H "Content-Type: text/markdown"\n\`\`\`\n\n### Update a group guide\n\n\`PUT /v1/groups/:group/README.md\`\n\nSend the complete raw Markdown guide. Maximum size: 512 KB.\n\n### Inspect a group\n\n\`GET /v1/groups/:group\`\n\nReturns group metadata plus its document catalogue.\n\n### Delete a document\n\n\`DELETE /v1/groups/:group/documents/:filename\`\n\n## Status and errors\n\n- \`GET /health\` returns \`{ "ok": true }\`.\n- Errors are JSON: \`{ "error": { "code": "...", "message": "..." } }\`.\n- \`401\`: missing or invalid API key; \`404\`: missing route/group/document; \`409\`: duplicate group; \`413\`: content is too large.\n\n## OpenAPI\n\nMachine-readable definition: [${PUBLIC_BASE_URL}/openapi.json](${PUBLIC_BASE_URL}/openapi.json)\n`;
}

*/

function apiMarkdown() {
  return [
    "# RAG Bucket API",
    "",
    "Base URL: " + PUBLIC_BASE_URL,
    "",
    "RAG Bucket stores Markdown knowledge by company group. Write endpoints require Authorization: Bearer <RAG_BUCKET_API_KEY>. Public read routes need no authentication and are intended for ChatGPT and other AI web fetchers.",
    "",
    "## Public retrieval",
    "",
    "| Method | Path | Description |",
    "| --- | --- | --- |",
    "| GET | /r/:group | AI entrypoint: reading guide and source-document links. Start here. |",
    "| GET | /r/:group/README.md | The group retrieval guide. |",
    "| GET | /r/:group/docs/:filename | A source Markdown document. |",
    "| GET | /r/:group/index.json | Machine-readable group and document catalogue. |",
    "| GET | /r/:group/llms.txt | AI-friendly alias for the entrypoint. |",
    "| GET | /llms.txt | Service-level AI discovery file. |",
    "| GET | /robots.txt | Crawler policy allowing OpenAI/ChatGPT access. |",
    "",
    "## Publishing API",
    "",
    "### Create a group",
    "",
    "POST /v1/groups",
    "",
    "Content-Type: application/json",
    "",
    '{ "company": "Acme Inc", "slug": "acme", "description": "Product knowledge", "readme": "# Retrieval guide" }',
    "",
    "The slug is optional and generated from company when omitted. The README is the retrieval guide telling an AI which documents to use.",
    "",
    "### Upload or replace a document",
    "",
    "PUT /v1/groups/:group/documents/:filename?description=...",
    "",
    "Send raw Markdown. The filename must be a descriptive .md file; README.md is reserved. Maximum size: 5 MB.",
    "",
    "curl --upload-file ./pricing-and-plans.md -X PUT \\\"" + PUBLIC_BASE_URL + "/v1/groups/acme/documents/pricing-and-plans.md?description=Current%20pricing\\\" -H \\\"Authorization: Bearer $RAG_BUCKET_API_KEY\\\" -H \\\"Content-Type: text/markdown\\\"",
    "",
    "### Update a group guide",
    "",
    "PUT /v1/groups/:group/README.md",
    "",
    "Send the complete raw Markdown guide. Maximum size: 512 KB.",
    "",
    "### Inspect a group",
    "",
    "GET /v1/groups/:group",
    "",
    "### Delete a document",
    "",
    "DELETE /v1/groups/:group/documents/:filename",
    "",
    "## Status and errors",
    "",
    "GET /health returns { ok: true }.",
    "Errors are JSON: { error: { code: ..., message: ... } }.",
    "401: invalid API key; 404: missing route/group/document; 409: duplicate group; 413: content too large.",
    "",
    "## OpenAPI",
    "",
    "Machine-readable definition: " + PUBLIC_BASE_URL + "/openapi.json",
  ].join("\\n");
}

function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "RAG Bucket API", version: "0.1.0", description: "API-first Markdown knowledge buckets optimized for AI web retrieval." },
    servers: [{ url: PUBLIC_BASE_URL }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "API key" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code", "message"] } }, required: ["error"] },
        GroupInput: { type: "object", required: ["company"], properties: { company: { type: "string", example: "Acme Inc" }, slug: { type: "string", example: "acme" }, description: { type: "string" }, readme: { type: "string", description: "Markdown retrieval guide" } } },
        Document: { type: "object", properties: { filename: { type: "string", example: "pricing-and-plans.md" }, title: { type: "string" }, description: { type: "string" }, excerpt: { type: "string" }, updated_at: { type: "string", format: "date-time" }, sha256: { type: "string" } } },
      },
    },
    paths: {
      "/health": { get: { security: [], summary: "Health check", responses: { "200": { description: "Service is healthy" } } } },
      "/r/{group}": { get: { security: [], summary: "Fetch the AI retrieval entrypoint", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Markdown group guide and source catalogue", content: { "text/markdown": { schema: { type: "string" } } } }, "404": { description: "Group not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/r/{group}/docs/{filename}": { get: { security: [], summary: "Fetch a public source document", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string", pattern: ".+\\.md$" } }], responses: { "200": { description: "Markdown source", content: { "text/markdown": { schema: { type: "string" } } } }, "404": { description: "Document not found" } } } },
      "/v1/groups": { post: { summary: "Create a company knowledge group", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GroupInput" } } } }, responses: { "201": { description: "Group created" }, "401": { description: "Invalid API key" }, "409": { description: "Group already exists" } } } },
      "/v1/groups/{group}": { get: { summary: "Get authenticated group metadata", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Group catalogue" }, "401": { description: "Invalid API key" }, "404": { description: "Group not found" } } } },
      "/v1/groups/{group}/README.md": { put: { summary: "Replace a group retrieval guide", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "text/markdown": { schema: { type: "string" } } } }, responses: { "200": { description: "Guide updated" }, "401": { description: "Invalid API key" } } } },
      "/v1/groups/{group}/documents/{filename}": {
        put: { summary: "Upload or replace a Markdown document", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string", pattern: ".+\\.md$" } }, { name: "description", in: "query", schema: { type: "string" } }], requestBody: { required: true, content: { "text/markdown": { schema: { type: "string" } } } }, responses: { "200": { description: "Document stored", content: { "application/json": { schema: { type: "object", properties: { document: { $ref: "#/components/schemas/Document" }, url: { type: "string", format: "uri" } } } } } }, "401": { description: "Invalid API key" } } },
        delete: { summary: "Delete a Markdown document", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Document deleted" }, "401": { description: "Invalid API key" }, "404": { description: "Document not found" } } },
      },
    },
  };
}

function docsPage() {
  const markdownUrl = `${PUBLIC_BASE_URL}/api.md`;
  const openApiUrl = `${PUBLIC_BASE_URL}/openapi.json`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RAG Bucket API</title><style>body{max-width:760px;margin:48px auto;padding:0 20px;font:16px/1.55 system-ui,sans-serif;color:#17202a}code{background:#f2f4f4;padding:2px 4px;border-radius:3px}a{color:#075ecb}h1{margin-bottom:4px}.muted{color:#5d6d7e}</style></head><body><h1>RAG Bucket API</h1><p class="muted">Markdown knowledge buckets optimized for AI web retrieval.</p><p>Choose a documentation format:</p><ul><li><a href="${markdownUrl}">API reference in Markdown</a> — ideal for ChatGPT and quick reading.</li><li><a href="${openApiUrl}">OpenAPI 3.1 JSON</a> — for SDKs, clients, and tooling.</li></ul><p>For AI retrieval, start at <code>/r/&lt;group&gt;</code>.</p></body></html>`;
}

async function readBody(req, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw apiError(413, `Request body exceeds the ${Math.floor(limit / 1024)} KB limit.`, "payload_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req) {
  const raw = await readBody(req, MAX_README_BYTES);
  try { return JSON.parse(raw); } catch { throw apiError(400, "Request body must be valid JSON."); }
}

function isAuthorized(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const candidate = Buffer.from(token);
  return API_KEYS.some((key) => {
    const expected = Buffer.from(key);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

function requireAuthorization(req) {
  if (!isAuthorized(req)) throw apiError(401, "Use Authorization: Bearer <RAG_BUCKET_API_KEY>.", "unauthorized");
}

function titleFromFilename(filename) {
  return filename.replace(/\.md$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function excerpt(source) {
  const text = source
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 240) || "No summary available.";
}

async function getGroup(slug) {
  const metadata = await readJson(join(groupDir(slug), "group.json"));
  const readme = await readFile(join(groupDir(slug), "README.md"), "utf8");
  return { metadata, readme };
}

async function getDocuments(slug) {
  const index = await readJson(join(groupDir(slug), "documents.json"));
  return index.documents || [];
}

async function saveDocuments(slug, documents) {
  await writeAtomic(join(groupDir(slug), "documents.json"), JSON.stringify({ documents }, null, 2));
}

function publicGroupUrl(slug) { return `${PUBLIC_BASE_URL}/r/${encodeURIComponent(slug)}`; }
function publicDocUrl(slug, filename) { return `${publicGroupUrl(slug)}/docs/${encodeURIComponent(filename)}`; }

async function publicEntry(slug) {
  const { metadata, readme } = await getGroup(slug);
  const documents = await getDocuments(slug);
  const catalogue = documents.length
    ? documents.map((doc) => `- [${doc.title}](${publicDocUrl(slug, doc.filename)}) — ${doc.description || doc.excerpt}`).join("\n")
    : "_No documents have been uploaded yet._";
  return `# ${metadata.company} — AI Knowledge Bucket\n\n> This is a machine-readable knowledge source. Start with the guide below, then fetch only the linked documents relevant to the question. Cite the document URLs used in your answer.\n\n## Reading guide\n\n${readme.trim()}\n\n## Source documents\n\n${catalogue}\n\n## Machine endpoints\n\n- JSON catalogue: ${publicGroupUrl(slug)}/index.json\n- LLM catalogue: ${publicGroupUrl(slug)}/llms.txt\n- Guide: ${publicGroupUrl(slug)}/README.md\n`;
}

async function route(req, res) {
  const url = new URL(req.url, PUBLIC_BASE_URL);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && path === "/") return html(res, 200, docsPage());
  if (req.method === "GET" && path === "/docs") return html(res, 200, docsPage());
  if (req.method === "GET" && path === "/api.md") return markdown(res, 200, apiMarkdown());
  if (req.method === "GET" && path === "/openapi.json") return json(res, 200, openApiDocument());
  if (req.method === "GET" && path === "/robots.txt") {
    res.writeHead(200, { "content-type": MIME.text, "cache-control": "public, max-age=86400" });
    return res.end("User-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: ChatGPT-User\nAllow: /\n\nUser-agent: *\nAllow: /\n");
  }
  if (req.method === "GET" && path === "/llms.txt") {
    return markdown(res, 200, "# RAG Bucket\n\nPublic, Markdown-first AI knowledge buckets. Fetch `/r/{group}` to obtain a group guide and document catalogue.\n");
  }

  // Public, AI-reader routes.
  if (req.method === "GET" && segments[0] === "r" && segments.length >= 2) {
    const slug = slugify(segments[1], "group");
    if (segments.length === 2) return markdown(res, 200, await publicEntry(slug));
    if (segments.length === 3 && segments[2] === "README.md") return markdown(res, 200, (await getGroup(slug)).readme);
    if (segments.length === 3 && segments[2] === "llms.txt") return markdown(res, 200, await publicEntry(slug));
    if (segments.length === 3 && segments[2] === "index.json") {
      const { metadata } = await getGroup(slug);
      return json(res, 200, { ...metadata, entry_url: publicGroupUrl(slug), readme_url: `${publicGroupUrl(slug)}/README.md`, documents: (await getDocuments(slug)).map((doc) => ({ ...doc, url: publicDocUrl(slug, doc.filename) })) });
    }
    if (segments.length === 4 && segments[2] === "docs") {
      const filename = documentName(segments[3]);
      try { return markdown(res, 200, await readFile(docPath(slug, filename), "utf8")); }
      catch (error) { if (error.code === "ENOENT") throw apiError(404, "Document not found.", "not_found"); throw error; }
    }
  }

  // Authenticated publishing API.
  if (segments[0] === "v1" && segments[1] === "groups") {
    requireAuthorization(req);
    if (req.method === "POST" && segments.length === 2) {
      const body = await readJsonBody(req);
      const slug = slugify(body.slug || body.company, "company or slug");
      const folder = groupDir(slug);
      if (await exists(join(folder, "group.json"))) throw apiError(409, "A group with this slug already exists.", "conflict");
      const metadata = { slug, company: String(body.company || slug).trim(), description: String(body.description || "").trim(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const readme = String(body.readme || `# ${metadata.company} knowledge guide\n\nDescribe which documents to read for each type of question.\n`);
      await writeAtomic(join(folder, "group.json"), JSON.stringify(metadata, null, 2));
      await writeAtomic(join(folder, "README.md"), readme);
      await saveDocuments(slug, []);
      return json(res, 201, { group: metadata, entry_url: publicGroupUrl(slug), api_url: `${PUBLIC_BASE_URL}/v1/groups/${slug}` });
    }
    if (segments.length >= 3) {
      const slug = slugify(segments[2], "group");
      if (req.method === "GET" && segments.length === 3) {
        const { metadata } = await getGroup(slug);
        return json(res, 200, { ...metadata, entry_url: publicGroupUrl(slug), documents: await getDocuments(slug) });
      }
      if (req.method === "PUT" && segments.length === 4 && segments[3] === "README.md") {
        await getGroup(slug);
        const readme = await readBody(req, MAX_README_BYTES);
        if (!readme.trim()) throw apiError(400, "README.md cannot be empty.");
        await writeAtomic(join(groupDir(slug), "README.md"), readme);
        return json(res, 200, { ok: true, readme_url: `${publicGroupUrl(slug)}/README.md` });
      }
      if (segments.length === 5 && segments[3] === "documents") {
        const filename = documentName(segments[4]);
        if (req.method === "PUT") {
          await getGroup(slug);
          const content = await readBody(req, MAX_DOCUMENT_BYTES);
          if (!content.trim()) throw apiError(400, "Document cannot be empty.");
          await writeAtomic(docPath(slug, filename), content);
          const documents = await getDocuments(slug);
          const suppliedDescription = url.searchParams.get("description")?.trim();
          const record = { filename, title: titleFromFilename(filename), description: suppliedDescription || "", excerpt: excerpt(content), updated_at: new Date().toISOString(), sha256: createHash("sha256").update(content).digest("hex") };
          const index = documents.findIndex((doc) => doc.filename.toLowerCase() === filename.toLowerCase());
          if (index >= 0) documents[index] = record; else documents.push(record);
          documents.sort((a, b) => a.filename.localeCompare(b.filename));
          await saveDocuments(slug, documents);
          return json(res, 200, { document: record, url: publicDocUrl(slug, filename) });
        }
        if (req.method === "DELETE") {
          await getGroup(slug);
          try { await rm(docPath(slug, filename)); } catch (error) { if (error.code === "ENOENT") throw apiError(404, "Document not found.", "not_found"); throw error; }
          await saveDocuments(slug, (await getDocuments(slug)).filter((doc) => doc.filename.toLowerCase() !== filename.toLowerCase()));
          return json(res, 200, { ok: true });
        }
      }
    }
  }
  throw apiError(404, "Route not found.", "not_found");
}

const server = createServer(async (req, res) => {
  try { await route(req, res); }
  catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    json(res, status, { error: { code: error.code || "internal_error", message: status >= 500 ? "Internal server error." : error.message } });
  }
});

await mkdir(GROUPS_DIR, { recursive: true });
server.listen(PORT, () => console.log(`RAG Bucket listening on port ${PORT}`));

export default server;
