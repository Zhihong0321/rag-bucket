# RAG Bucket

RAG Bucket is a small, API-first Markdown knowledge service for giving ChatGPT and other web-capable AI tools a clean, public source to retrieve. It has no human-facing application or conversation state.

Each company is a **group**. A group contains:

- `README.md`: an explicit reading guide that tells an AI which documents are authoritative for which questions.
- one or more descriptively named `.md` documents.
- an automatically maintained JSON catalogue and AI entry page.

## Why the public URL works well for AI retrieval

The public group URL, for example `https://your-domain/r/acme`, responds directly with `text/markdown`, no JavaScript, no cookie wall, no login, and a short document catalogue. A model should fetch this URL first, read its `README.md` guide, and then fetch only the relevant document links. `robots.txt` explicitly allows `OAI-SearchBot` and `ChatGPT-User`.

Use it in ChatGPT as: `Read https://your-domain/r/acme. Follow its reading guide and answer my question with document citations.`

Public routes:

| Route | Purpose |
| --- | --- |
| `GET /r/:group` | Best starting URL; Markdown guide and document links |
| `GET /r/:group/README.md` | The group reading guide |
| `GET /r/:group/docs/:filename` | A source Markdown document |
| `GET /r/:group/index.json` | Machine-readable catalogue |
| `GET /r/:group/llms.txt` | AI-friendly catalogue alias |
| `GET /robots.txt` | Allows ChatGPT/OpenAI crawlers |
| `GET /` | API documentation landing page |
| `GET /docs` | Browser-readable API documentation |
| `GET /api.md` | Markdown API documentation |
| `GET /openapi.json` | OpenAPI 3.1 specification |

## Deploy to Railway

1. Create a Railway project from this repository.
2. Add a **Volume** mounted at `/data`.
3. Set these variables:

   ```text
   DATA_DIR=/data
   RAG_BUCKET_API_KEYS=<generate-a-long-random-secret>
   PUBLIC_BASE_URL=https://<your-railway-domain>
   NODE_ENV=production
   ```

4. Deploy. Railway uses `railway.toml`, runs `npm start`, and checks `GET /health`.

Without a Volume, Railway's local filesystem is ephemeral and uploaded knowledge will disappear on a redeploy.

## Publishing API

All write and management calls require:

```http
Authorization: Bearer <RAG_BUCKET_API_KEY>
```

Create a company group. The initial `readme` is the retrieval guide.

```bash
curl -X POST https://your-domain/v1/groups \
  -H "Authorization: Bearer $RAG_BUCKET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "company": "Acme Inc",
    "slug": "acme",
    "description": "Product and support knowledge",
    "readme": "# Acme retrieval guide\n\n- Pricing questions: read `pricing-and-plans.md`.\n- API questions: read `api-reference.md`.\n- If the answer is absent, say so."
  }'
```

Upload or replace a Markdown source. The filename must end in `.md`; `README.md` is reserved for the group guide.

```bash
curl --upload-file ./pricing-and-plans.md \
  -X PUT "https://your-domain/v1/groups/acme/documents/pricing-and-plans.md?description=Current pricing and plans" \
  -H "Authorization: Bearer $RAG_BUCKET_API_KEY" \
  -H "Content-Type: text/markdown"
```

Replace the guide:

```bash
curl --data-binary @README.md \
  -X PUT https://your-domain/v1/groups/acme/README.md \
  -H "Authorization: Bearer $RAG_BUCKET_API_KEY" \
  -H "Content-Type: text/markdown"
```

Inspect a group (authenticated) or remove a document:

```bash
curl https://your-domain/v1/groups/acme -H "Authorization: Bearer $RAG_BUCKET_API_KEY"
curl -X DELETE https://your-domain/v1/groups/acme/documents/old-policy.md -H "Authorization: Bearer $RAG_BUCKET_API_KEY"
```

## Local run

```bash
Copy-Item .env.example .env
# Set RAG_BUCKET_API_KEYS, then:
npm start
```

For local development only, if no key is set the key defaults to `local-development-key`.
