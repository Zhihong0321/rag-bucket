import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
function normalizePublicBaseUrl(value) {
  const candidate = String(value || `http://localhost:${PORT}`).trim().replace(/\/$/, "");
  const absolute = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  let url;
  try { url = new URL(absolute); }
  catch { throw new Error("PUBLIC_BASE_URL must be a valid hostname or http(s) URL."); }
  // Railway's generated public domain is "<service>.up.railway.app" (dot). A hyphen there
  // ("<service>.up-railway.app") does not resolve and has previously been typo'd into this
  // variable, silently poisoning every URL this service hands out.
  if (/-railway\.app$/i.test(url.hostname)) {
    throw new Error(`PUBLIC_BASE_URL "${url.hostname}" looks like a typo of Railway's domain format. Railway uses a dot ("<service>.up.railway.app"), not a hyphen ("<service>.up-railway.app").`);
  }
  return url.origin;
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

function pageName(value) {
  const name = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.html?$/i.test(name)) {
    throw apiError(400, "filename must be an .html or .htm filename.");
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

function pagePath(slug, filename) {
  const target = resolve(groupDir(slug), "pages", filename);
  const allowed = `${resolve(groupDir(slug), "pages")}${sep}`;
  if (!target.startsWith(allowed)) throw apiError(400, "Invalid page filename.");
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
  res.writeHead(status, { "content-type": MIME.html, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  res.end(body);
}

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
    "| GET | / | Visual web hub displaying all uploaded knowledge groups and document reader. |",
    "| GET | /groups.json | Public JSON index of all uploaded knowledge groups. |",
    "| GET | /r/:group | AI entrypoint: reading guide and source-document links. Start here. |",
    "| GET | /r/:group/README.md | The group retrieval guide. |",
    "| GET | /r/:group/docs/:filename | A source Markdown document. |",
    "| GET | /r/:group/pages/:filename | A hosted HTML page. |",
    "| GET | /r/:group/site | The group's index.html page. |",
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
    "curl --upload-file ./pricing-and-plans.md -X PUT \"" + PUBLIC_BASE_URL + "/v1/groups/acme/documents/pricing-and-plans.md?description=Current%20pricing\" -H \"Authorization: Bearer $RAG_BUCKET_API_KEY\" -H \"Content-Type: text/markdown\"",
    "",
    "### Upload or replace an HTML page",
    "",
    "PUT /v1/groups/:group/pages/:filename",
    "",
    "Send raw HTML. The filename must end in .html or .htm. index.html is publicly available at /r/:group/site.",
    "",
    "Example:",
    "curl --upload-file ./index.html -X PUT \"" + PUBLIC_BASE_URL + "/v1/groups/acme/pages/index.html\" -H \"Authorization: Bearer $RAG_BUCKET_API_KEY\" -H \"Content-Type: text/html\"",
    "",
    "Public URLs: /r/acme/pages/index.html and /r/acme/site.",
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
  ].join("\n");
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
        Page: { type: "object", properties: { filename: { type: "string", example: "index.html" }, updated_at: { type: "string", format: "date-time" }, sha256: { type: "string" } } },
      },
    },
    paths: {
      "/health": { get: { security: [], summary: "Health check", responses: { "200": { description: "Service is healthy" } } } },
      "/groups.json": { get: { security: [], summary: "List all uploaded groups (Public)", responses: { "200": { description: "List of all groups" } } } },
      "/r/{group}": { get: { security: [], summary: "Fetch the AI retrieval entrypoint", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Markdown group guide and source catalogue", content: { "text/markdown": { schema: { type: "string" } } } }, "404": { description: "Group not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/r/{group}/docs/{filename}": { get: { security: [], summary: "Fetch a public source document", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string", pattern: ".+\\.md$" } }], responses: { "200": { description: "Markdown source", content: { "text/markdown": { schema: { type: "string" } } } }, "404": { description: "Document not found" } } } },
      "/r/{group}/pages/{filename}": { get: { security: [], summary: "Fetch a public HTML page", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string", pattern: ".+\\.html?$" } }], responses: { "200": { description: "Hosted HTML", content: { "text/html": { schema: { type: "string" } } } }, "404": { description: "Page not found" } } } },
      "/v1/groups": {
        get: { summary: "List all groups", responses: { "200": { description: "List of all groups" }, "401": { description: "Invalid API key" } } },
        post: { summary: "Create a company knowledge group", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GroupInput" } } } }, responses: { "201": { description: "Group created" }, "401": { description: "Invalid API key" }, "409": { description: "Group already exists" } } },
      },
      "/v1/groups/{group}": { get: { summary: "Get authenticated group metadata", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Group catalogue" }, "401": { description: "Invalid API key" }, "404": { description: "Group not found" } } }, delete: { summary: "Delete a group", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Group deleted" }, "401": { description: "Invalid API key" }, "404": { description: "Group not found" } } } },
      "/v1/groups/{group}/README.md": { put: { summary: "Replace a group retrieval guide", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "text/markdown": { schema: { type: "string" } } } }, responses: { "200": { description: "Guide updated" }, "401": { description: "Invalid API key" } } } },
      "/v1/groups/{group}/documents/{filename}": {
        put: { summary: "Upload or replace a Markdown document", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string", pattern: ".+\\.md$" } }, { name: "description", in: "query", schema: { type: "string" } }], requestBody: { required: true, content: { "text/markdown": { schema: { type: "string" } } } }, responses: { "200": { description: "Document stored", content: { "application/json": { schema: { type: "object", properties: { document: { $ref: "#/components/schemas/Document" }, url: { type: "string", format: "uri" } } } } } }, "401": { description: "Invalid API key" } } },
        delete: { summary: "Delete a Markdown document", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Document deleted" }, "401": { description: "Invalid API key" }, "404": { description: "Document not found" } } },
      },
      "/v1/groups/{group}/pages/{filename}": {
        put: { summary: "Upload or replace a hosted HTML page", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string", pattern: ".+\\.html?$" } }], requestBody: { required: true, content: { "text/html": { schema: { type: "string" } } } }, responses: { "200": { description: "Page stored", content: { "application/json": { schema: { type: "object", properties: { page: { $ref: "#/components/schemas/Page" }, url: { type: "string", format: "uri" } } } } } }, "401": { description: "Invalid API key" } } },
        delete: { summary: "Delete a hosted HTML page", parameters: [{ name: "group", in: "path", required: true, schema: { type: "string" } }, { name: "filename", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Page deleted" }, "401": { description: "Invalid API key" }, "404": { description: "Page not found" } } },
      },
    },
  };
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
  try {
    const index = await readJson(join(groupDir(slug), "documents.json"));
    return index.documents || [];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function saveDocuments(slug, documents) {
  await writeAtomic(join(groupDir(slug), "documents.json"), JSON.stringify({ documents }, null, 2));
}

async function getPages(slug) {
  try {
    const index = await readJson(join(groupDir(slug), "pages.json"));
    return index.pages || [];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function savePages(slug, pages) {
  await writeAtomic(join(groupDir(slug), "pages.json"), JSON.stringify({ pages }, null, 2));
}

function publicGroupUrl(slug) { return `${PUBLIC_BASE_URL}/r/${encodeURIComponent(slug)}`; }
function publicDocUrl(slug, filename) { return `${publicGroupUrl(slug)}/docs/${encodeURIComponent(filename)}`; }
function publicPageUrl(slug, filename) { return `${publicGroupUrl(slug)}/pages/${encodeURIComponent(filename)}`; }

async function listAllGroups() {
  try {
    const entries = await readdir(GROUPS_DIR, { withFileTypes: true });
    const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const list = [];
    for (const slug of slugs) {
      try {
        const { metadata } = await getGroup(slug);
        const documents = await getDocuments(slug);
        const pages = await getPages(slug);
        list.push({
          ...metadata,
          entry_url: publicGroupUrl(slug),
          readme_url: `${publicGroupUrl(slug)}/README.md`,
          documents: documents.map((doc) => ({ ...doc, url: publicDocUrl(slug, doc.filename) })),
          pages: pages.map((page) => ({ ...page, url: publicPageUrl(slug, page.filename) })),
        });
      } catch {
        /* skip incomplete group */
      }
    }
    list.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    return list;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function publicEntry(slug) {
  const { metadata, readme } = await getGroup(slug);
  const documents = await getDocuments(slug);
  const pages = await getPages(slug);
  const catalogue = documents.length
    ? documents.map((doc) => `- [${doc.title}](${publicDocUrl(slug, doc.filename)}) — ${doc.description || doc.excerpt}`).join("\n")
    : "_No documents have been uploaded yet._";
  const pagesCatalogue = pages.length
    ? "\n\n## Hosted Web Pages\n\n" + pages.map((p) => `- [${p.filename}](${publicPageUrl(slug, p.filename)})`).join("\n")
    : "";
  return `# ${metadata.company} — AI Knowledge Bucket\n\n> This is a machine-readable knowledge source. Start with the guide below, then fetch only the linked documents relevant to the question. Cite the document URLs used in your answer.\n\n## Reading guide\n\n${readme.trim()}\n\n## Source documents\n\n${catalogue}${pagesCatalogue}\n\n## Machine endpoints\n\n- JSON catalogue: ${publicGroupUrl(slug)}/index.json\n- LLM catalogue: ${publicGroupUrl(slug)}/llms.txt\n- Guide: ${publicGroupUrl(slug)}/README.md\n`;
}

function hubHtml(groups) {
  const totalDocs = groups.reduce((acc, g) => acc + (g.documents?.length || 0), 0);
  const totalPages = groups.reduce((acc, g) => acc + (g.pages?.length || 0), 0);
  const groupsJsonStr = JSON.stringify(groups).replace(/</g, '\\u003c');
  const baseUrl = PUBLIC_BASE_URL;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RAG Bucket — Knowledge Groups Hub</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root {
      --bg: #090d16;
      --bg-surface: #111726;
      --bg-card: #151d30;
      --bg-card-hover: #1b253d;
      --border: #222f4c;
      --border-focus: #3b82f6;
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.12);
      --success: #10b981;
      --success-bg: rgba(16, 185, 129, 0.12);
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: var(--font-sans);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      padding-bottom: 60px;
    }
    .container { max-width: 1360px; margin: 0 auto; padding: 0 24px; }
    header {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 40;
      backdrop-filter: blur(8px);
    }
    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 68px;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
      color: var(--text-main);
    }
    .brand-icon {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #1e40af, #0284c7);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 17px;
      color: #fff;
    }
    .brand-text h1 { font-size: 16px; font-weight: 700; }
    .brand-text p { font-size: 12px; color: var(--text-dim); }
    .top-links { display: flex; align-items: center; gap: 10px; }
    .service-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: #172033;
      border: 1px solid var(--border);
      border-radius: 9999px;
      font-size: 12px;
      color: var(--text-muted);
      text-decoration: none;
      font-family: var(--font-mono);
    }
    .service-badge:hover { border-color: var(--border-focus); color: var(--text-main); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 8px var(--success); }
    .hero-section { padding: 32px 0 24px; }
    .hero-title { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 6px; }
    .hero-subtitle { color: var(--text-muted); font-size: 14px; max-width: 800px; }
    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-top: 24px;
    }
    .stat-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 16px 20px;
    }
    .stat-label { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 4px; }
    .stat-value { font-size: 24px; font-weight: 700; color: var(--text-main); font-family: var(--font-mono); }
    .controls-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 12px 16px;
      margin-bottom: 24px;
    }
    .search-box { position: relative; flex: 1; min-width: 260px; }
    .search-input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 10px 14px 10px 36px;
      border-radius: var(--radius-sm);
      font-size: 14px;
      font-family: inherit;
      outline: none;
    }
    .search-input:focus { border-color: var(--border-focus); }
    .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-dim); }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-main);
      text-decoration: none;
      transition: all 0.15s ease;
      font-family: inherit;
    }
    .btn:hover { background: var(--bg-card-hover); border-color: var(--border-focus); }
    .btn-primary { background: #2563eb; border-color: #3b82f6; color: #ffffff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-sm { padding: 5px 10px; font-size: 12px; }
    .groups-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 20px;
    }
    @media (max-width: 768px) { .groups-grid { grid-template-columns: 1fr; } }
    .group-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .group-card:hover { transform: translateY(-2px); border-color: #334e7a; }
    .group-title { font-size: 16px; font-weight: 700; color: #fff; line-height: 1.35; }
    .group-slug {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--accent);
      background: var(--accent-glow);
      padding: 2px 8px;
      border-radius: 4px;
      margin-top: 4px;
      display: inline-block;
      word-break: break-all;
    }
    .group-desc { font-size: 13px; color: var(--text-muted); margin: 10px 0 14px; line-height: 1.45; }
    .docs-section {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 12px;
      margin-bottom: 16px;
    }
    .docs-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); margin-bottom: 8px; }
    .doc-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin-bottom: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .doc-item:last-child { margin-bottom: 0; }
    .doc-item:hover { background: #18233c; border-color: var(--border-focus); }
    .doc-name { font-family: var(--font-mono); font-size: 12px; color: var(--text-main); display: flex; align-items: center; gap: 6px; }
    .doc-action-tag { font-size: 11px; color: var(--accent); background: rgba(56, 189, 248, 0.1); padding: 2px 6px; border-radius: 4px; }
    .group-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .endpoints-links { display: flex; gap: 8px; }
    .link-tag { font-size: 12px; color: var(--text-muted); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
    .link-tag:hover { color: var(--accent); text-decoration: underline; }
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(4, 7, 13, 0.85);
      backdrop-filter: blur(6px);
      z-index: 50;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal-backdrop.open { display: flex; }
    .modal-box {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      width: 100%;
      max-width: 960px;
      height: 88vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
    }
    .modal-header h2 { font-size: 17px; font-weight: 700; color: #fff; }
    .modal-header p { font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); }
    .modal-body { flex: 1; overflow-y: auto; padding: 24px 30px; background: var(--bg); }
    .markdown-content { font-size: 14px; color: #cbd5e1; line-height: 1.7; }
    .markdown-content h1, .markdown-content h2, .markdown-content h3 { color: #fff; margin: 18px 0 10px; font-weight: 700; }
    .markdown-content h1 { font-size: 20px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .markdown-content p { margin-bottom: 12px; }
    .markdown-content ul, .markdown-content ol { margin-left: 20px; margin-bottom: 14px; }
    .markdown-content blockquote { border-left: 3px solid var(--accent); padding: 8px 16px; background: rgba(56, 189, 248, 0.05); margin-bottom: 14px; }
    .markdown-content table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
    .markdown-content th, .markdown-content td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
    .markdown-content th { background: var(--bg-surface); font-weight: 600; color: #fff; }
    .markdown-content code { font-family: var(--font-mono); background: #1e293b; color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .markdown-content pre { background: #0f172a; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 14px; overflow-x: auto; margin: 14px 0; }
    .markdown-content pre code { background: transparent; padding: 0; color: #f1f5f9; }
    .modal-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 24px;
      background: var(--bg-card);
      border-top: 1px solid var(--border);
    }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #1e293b;
      border: 1px solid #3b82f6;
      color: #fff;
      padding: 10px 18px;
      border-radius: var(--radius-md);
      font-size: 13px;
      z-index: 100;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s ease;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
  </style>
</head>
<body>
  <header>
    <div class="container header-inner">
      <a href="/" class="brand">
        <div class="brand-icon">⚡</div>
        <div class="brand-text">
          <h1>RAG Knowledge Hub</h1>
          <p>Markdown Knowledge Buckets for AI</p>
        </div>
      </a>
      <div class="top-links">
        <a href="/groups.json" target="_blank" class="service-badge">
          <span>{ } groups.json</span>
        </a>
        <a href="/openapi.json" target="_blank" class="service-badge">
          <span class="status-dot"></span>
          <span>OpenAPI 3.1</span>
        </a>
        <a href="/api.md" target="_blank" class="service-badge">
          <span>API Docs (MD)</span>
        </a>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="hero-section">
      <h2 class="hero-title">Uploaded Company Knowledge Groups</h2>
      <p class="hero-subtitle">
        API-first Markdown knowledge groups optimized for autonomous AI agent retrieval and LLM context synthesis.
      </p>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-label">Active Groups</div>
          <div class="stat-value">${groups.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Published Markdown Docs</div>
          <div class="stat-value">${totalDocs}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Hosted Web Pages</div>
          <div class="stat-value">${totalPages}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">API Status</div>
          <div class="stat-value" style="color: var(--success); font-size: 18px;">200 OK Live</div>
        </div>
      </div>
    </section>

    <div class="controls-bar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" id="search-input" class="search-input" placeholder="Search by company name, slug, or document keyword..." />
      </div>
      <div style="display: flex; gap: 10px;">
        <button class="btn" onclick="location.reload()">
          <span>🔄</span> Refresh
        </button>
      </div>
    </div>

    <div id="groups-container" class="groups-grid"></div>
  </main>

  <div id="doc-modal" class="modal-backdrop">
    <div class="modal-box">
      <div class="modal-header">
        <div>
          <h2 id="modal-doc-title">Document Title</h2>
          <p id="modal-doc-path">/r/slug/docs/filename.md</p>
        </div>
      </div>
      <div class="modal-body">
        <div id="modal-doc-content" class="markdown-content"></div>
      </div>
      <div class="modal-footer">
        <a id="modal-doc-raw-link" href="#" target="_blank" class="btn btn-sm">Open Raw Markdown ↗</a>
        <button class="btn btn-sm" onclick="closeModal()">Close</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast">Copied to clipboard</div>

  <script>
    const GROUPS = ${groupsJsonStr};
    const BASE_URL = ${JSON.stringify(baseUrl)};

    function renderGroups(list) {
      const container = document.getElementById('groups-container');
      if (!list.length) {
        container.innerHTML = '<div style="grid-column: 1 / -1; padding: 48px 0; text-align: center; color: var(--text-dim);">No knowledge groups found.</div>';
        return;
      }
      container.innerHTML = list.map(g => {
        const docs = g.documents || [];
        const pages = g.pages || [];
        return \`
          <div class="group-card">
            <div>
              <h3 class="group-title">\${escapeHtml(g.company)}</h3>
              <span class="group-slug">\${escapeHtml(g.slug)}</span>
              <p class="group-desc">\${escapeHtml(g.description || 'Knowledge bucket for ' + g.company)}</p>
              
              <div class="docs-section">
                <div class="docs-title">Knowledge Documents (\${docs.length})</div>
                
                <div class="doc-item" onclick="openDoc('\${g.slug}', 'README.md', '\${g.readme_url}')">
                  <div class="doc-name">
                    <span>📖</span>
                    <span>README.md (Retrieval Guide)</span>
                  </div>
                  <span class="doc-action-tag">Read</span>
                </div>

                \${docs.map(d => \`
                  <div class="doc-item" onclick="openDoc('\${g.slug}', '\${escapeHtml(d.filename)}', '\${d.url}')">
                    <div class="doc-name">
                      <span>📄</span>
                      <span>\${escapeHtml(d.filename)}</span>
                    </div>
                    <span class="doc-action-tag">Read</span>
                  </div>
                \`).join('')}

                \${pages.length ? \`
                  <div class="docs-title" style="margin-top: 10px;">Hosted Web Pages (\${pages.length})</div>
                  \${pages.map(p => \`
                    <a class="doc-item" href="\${p.url}" target="_blank" style="text-decoration: none;">
                      <div class="doc-name">
                        <span>🌐</span>
                        <span>\${escapeHtml(p.filename)}</span>
                      </div>
                      <span class="doc-action-tag">View Site ↗</span>
                    </a>
                  \`).join('')}
                \` : ''}
              </div>
            </div>

            <div class="group-footer">
              <div class="endpoints-links">
                <a href="\${g.entry_url}" target="_blank" class="link-tag" title="AI Retrieval Entrypoint">
                  <span>🌐</span> Entrypoint
                </a>
                <a href="\${g.entry_url}/llms.txt" target="_blank" class="link-tag" title="LLMs.txt">
                  <span>🤖</span> llms.txt
                </a>
                <a href="\${g.entry_url}/index.json" target="_blank" class="link-tag" title="JSON catalogue">
                  <span>⚙️</span> index.json
                </a>
              </div>
              <button class="btn btn-sm" onclick="copyUrl('\${g.entry_url}')">
                <span>📋</span> Copy URL
              </button>
            </div>
          </div>
        \`;
      }).join('');
    }

    document.getElementById('search-input').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (!q) { renderGroups(GROUPS); return; }
      const filtered = GROUPS.filter(g => 
        g.company.toLowerCase().includes(q) ||
        g.slug.toLowerCase().includes(q) ||
        (g.description && g.description.toLowerCase().includes(q)) ||
        (g.documents && g.documents.some(d => d.filename.toLowerCase().includes(q)))
      );
      renderGroups(filtered);
    });

    async function openDoc(slug, filename, url) {
      document.getElementById('modal-doc-title').textContent = filename;
      document.getElementById('modal-doc-path').textContent = '/r/' + slug + '/' + filename;
      document.getElementById('modal-doc-raw-link').href = url;
      document.getElementById('modal-doc-content').innerHTML = '<p style="color: var(--text-dim)">Loading document...</p>';
      document.getElementById('doc-modal').classList.add('open');

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const md = await res.text();
        if (window.marked) {
          document.getElementById('modal-doc-content').innerHTML = marked.parse(md);
        } else {
          document.getElementById('modal-doc-content').innerHTML = '<pre>' + escapeHtml(md) + '</pre>';
        }
      } catch (err) {
        document.getElementById('modal-doc-content').innerHTML = '<p style="color: #ef4444">Failed to load: ' + err.message + '</p>';
      }
    }

    function closeModal() {
      document.getElementById('doc-modal').classList.remove('open');
    }

    function copyUrl(url) {
      navigator.clipboard.writeText(url);
      const t = document.getElementById('toast');
      t.textContent = 'Copied: ' + url;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2000);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    renderGroups(GROUPS);
  </script>
</body>
</html>`;
}

function docsPage() {
  const markdownUrl = `${PUBLIC_BASE_URL}/api.md`;
  const openApiUrl = `${PUBLIC_BASE_URL}/openapi.json`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RAG Bucket API</title><style>body{max-width:760px;margin:48px auto;padding:0 20px;font:16px/1.55 system-ui,sans-serif;color:#17202a}code{background:#f2f4f4;padding:2px 4px;border-radius:3px;overflow-wrap:anywhere}a{color:#075ecb}h1{margin-bottom:4px}.muted{color:#5d6d7e}</style></head><body><h1>RAG Bucket API</h1><p class="muted">Markdown knowledge buckets optimized for AI web retrieval.</p><h2>Host HTML pages</h2><p>Upload an HTML page with <code>PUT /v1/groups/:group/pages/:filename</code>. Uploading <code>index.html</code> makes it available at <code>/r/:group/site</code>.</p><p>Example: <code>PUT /v1/groups/acme/pages/index.html</code></p><p>Choose a documentation format:</p><ul><li><a href="${markdownUrl}">API reference in Markdown</a> — includes cURL examples.</li><li><a href="${openApiUrl}">OpenAPI 3.1 JSON</a> — includes the HTML page endpoints.</li></ul><p>For AI retrieval, start at <code>/r/&lt;group&gt;</code>.</p></body></html>`;
}

async function route(req, res) {
  const url = new URL(req.url, PUBLIC_BASE_URL);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && (path === "/" || path === "/groups")) {
    const all = await listAllGroups();
    return html(res, 200, hubHtml(all));
  }
  if (req.method === "GET" && path === "/groups.json") {
    const all = await listAllGroups();
    return json(res, 200, { total: all.length, groups: all });
  }
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
      return json(res, 200, { ...metadata, entry_url: publicGroupUrl(slug), readme_url: `${publicGroupUrl(slug)}/README.md`, documents: (await getDocuments(slug)).map((doc) => ({ ...doc, url: publicDocUrl(slug, doc.filename) })), pages: (await getPages(slug)).map((page) => ({ ...page, url: publicPageUrl(slug, page.filename) })) });
    }
    if (segments.length === 4 && segments[2] === "docs") {
      const filename = documentName(segments[3]);
      try { return markdown(res, 200, await readFile(docPath(slug, filename), "utf8")); }
      catch (error) { if (error.code === "ENOENT") throw apiError(404, "Document not found.", "not_found"); throw error; }
    }
    if (segments.length === 3 && segments[2] === "site") {
      try { return html(res, 200, await readFile(pagePath(slug, "index.html"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") throw apiError(404, "No index.html page has been uploaded.", "not_found"); throw error; }
    }
    if (segments.length === 4 && segments[2] === "pages") {
      const filename = pageName(segments[3]);
      try { return html(res, 200, await readFile(pagePath(slug, filename), "utf8")); }
      catch (error) { if (error.code === "ENOENT") throw apiError(404, "Page not found.", "not_found"); throw error; }
    }
  }

  // Authenticated publishing API.
  if (segments[0] === "v1" && segments[1] === "groups") {
    requireAuthorization(req);
    if (req.method === "GET" && segments.length === 2) {
      const all = await listAllGroups();
      return json(res, 200, { total: all.length, groups: all });
    }
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
      await savePages(slug, []);
      return json(res, 201, { group: metadata, entry_url: publicGroupUrl(slug), api_url: `${PUBLIC_BASE_URL}/v1/groups/${slug}` });
    }
    if (segments.length >= 3) {
      const slug = slugify(segments[2], "group");
      if (req.method === "GET" && segments.length === 3) {
        const { metadata } = await getGroup(slug);
        return json(res, 200, { ...metadata, entry_url: publicGroupUrl(slug), documents: await getDocuments(slug), pages: await getPages(slug) });
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
      if (segments.length === 5 && segments[3] === "pages") {
        const filename = pageName(segments[4]);
        if (req.method === "PUT") {
          await getGroup(slug);
          const content = await readBody(req, MAX_DOCUMENT_BYTES);
          if (!content.trim()) throw apiError(400, "Page cannot be empty.");
          await writeAtomic(pagePath(slug, filename), content);
          const pages = await getPages(slug);
          const record = { filename, updated_at: new Date().toISOString(), sha256: createHash("sha256").update(content).digest("hex") };
          const index = pages.findIndex((page) => page.filename.toLowerCase() === filename.toLowerCase());
          if (index >= 0) pages[index] = record; else pages.push(record);
          pages.sort((a, b) => a.filename.localeCompare(b.filename));
          await savePages(slug, pages);
          return json(res, 200, { page: record, url: publicPageUrl(slug, filename) });
        }
        if (req.method === "DELETE") {
          await getGroup(slug);
          try { await rm(pagePath(slug, filename)); } catch (error) { if (error.code === "ENOENT") throw apiError(404, "Page not found.", "not_found"); throw error; }
          await savePages(slug, (await getPages(slug)).filter((page) => page.filename.toLowerCase() !== filename.toLowerCase()));
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
