# Deterministic Site Extractor

Zero-AI, fully deterministic deep website extraction engine running on **Node.js 22 LTS + TypeScript ESM** inside **GitHub Actions**, packing layout coordinates, overlays, animations, design tokens, HTML/CSS, and unpacked client source code into a single XML-structured plain-text artifact (`ai-site-context-run-<N>-<A>.txt`).

## Core Guarantees

- **Zero AI at Runtime**: No LLM APIs, embeddings, or probabilistic models. Every output is captured directly from Chromium/Chrome CDP, DOMSnapshot, WAAPI, CSSOM, SourceMaps, AST deobfuscation, and Dembrandt.
- **Headless Engine Repository**: No web server or frontend dashboard. Trigger via GitHub Actions `workflow_dispatch` or run locally via CLI.
- **RAM-Safe 6-Stage Pipeline**: Browser processes close completely before sequential `webcrack` workers execute (2 GB heap cap + 30s timeout per bundle).
- **Direct Text Artifact Download**: Uploaded with `archive: false` so you download `ai-site-context-run-<N>-<A>.txt` directly from GitHub Actions without unzipping.

## GitHub Actions Usage (`workflow_dispatch`)

1. Open the **Actions** tab in your GitHub repository.
2. Select **Deep Site Extractor for AI** -> **Run workflow**.
3. Enter `target_url` (must include `https://` or `http://`) and adjust optional bounds (`max_pages`, `max_depth`, `viewports`, `stealth_mode`, `unpack_js`, `compress_output`, `token_budget`).
4. When the run finishes, the unified file is committed automatically into `extractions/ai-site-context-run-<N>-<A>.txt` in your repository and also uploaded to **Artifacts** (for 3 days).

## Handling Cloud IP Blocks (Proxy Setup)

Cloud runner IPs (Azure/GitHub) may encounter Cloudflare, DataDome, or Akamai challenges on protected sites. If you hit `403` / challenge pages:

1. Go to **Settings -> Secrets and variables -> Actions** in your repository.
2. Add a repository secret named `PROXY_URL` (e.g., a residential HTTP/SOCKS5 proxy URL `http://user:pass@host:port`).
3. Alternatively, attach a self-hosted runner on a non-cloud IP.

## Recommended Two-Pass Token Budgeting

For large websites (50+ pages):

1. **Pass 1 (Site Map & Design System)**: Run with `max_pages: 30` and `compress_output: true` to capture site architecture, navigation, layout trees, overlays, animations, and full `DESIGN.md` / DTCG tokens while Tree-sitter compresses unpacked JS.
2. **Pass 2 (Deep Component Slice)**: Run against a targeted route with `max_pages: 3`–`5` and `compress_output: false` for full uncompressed client source recovery.

## Local CLI Execution

```bash
npm install
npx patchright install chrome chromium
npx dembrandt install-browser
TARGET_URL="https://example.com" STEALTH_MODE="chromium-headless" npm run crawl
npx repomix ./extracted --config repomix.config.json --no-gitignore --style xml --output ai-site-context-local.txt
```
