# Deterministic Site Extractor

Zero-AI, fully deterministic deep website extraction engine running on **Node.js 22 LTS + TypeScript ESM** inside **GitHub Actions**, combining browser CDP telemetry, static analyzers, and bundle unpackers into a single XML-structured plain-text artifact (`extractions/ai-site-context-run-<N>-<A>.txt`).

## Integrated Pipeline Stages

1. **Stage 1 — Initialization**: Validates environment parameters (`TARGET_URL`, `MAX_PAGES`, `MAX_DEPTH`, `VIEWPORTS`, `STEALTH_MODE`) and prepares isolated `./extracted` & `./storage` directories.
2. **Stage 1.5 — Pre-Crawl Recon (`src/recon/`)**:
   - **Wappalyzergo (`wappalyzer-cli`)** + deterministic HTTP/HTML fallback -> `tech-stack.json`
   - **Katana (`projectdiscovery/katana`)** -> discovers JS routes & endpoints into `discovered-endpoints.txt` and seeds the browser crawler.
3. **Stage 2 — Stealth Browser Capture (`src/crawler.ts`, `src/extractors/`)**:
   - **Crawlee + Patchright** (Chrome on Xvfb or Chromium headless) captures `DOMSnapshot` layout bounds (pruning browser-default values), overlays, `:hover`/`:focus` & disclosure deltas (`state-prober`), 3-layer CDP/WAAPI/CSSOM/raw CSS animations (`animation-extractor`), deduplicated global CSS (`styles/`), and **SVGO-optimized** inline logos/icons (`svg-assets/`).
   - **Scrapling Fallback (`src/fallback/scrapling_fetch.py`)**: Automatically activates if Patchright hits a hard anti-bot block (`0` pages crawled).
4. **Stage 3 — SourceMap Recovery (`src/extractors/sourcemap-unpacker.ts`)**: Pure TypeScript SourceMap v3 unpacker recovering first-party source trees while stripping `node_modules/` and bundler runtime helpers.
5. **Stage 4 — Bundle Unpacking (`src/extractors/webcrack-runner.ts` + `webcrack-worker.ts`)**: Sequential 2 GB memory-capped workers combining **Webcrack** (Webpack/obfuscator.io) with **Wakaru (`@wakaru/unpacker` + `@wakaru/unminify`)** for Vite/Rollup/esbuild/Turbopack bundles, plus Prettier fallback.
6. **Stage 5 — Design Tokens, CSS Purge & Snapshot (`src/design/`, `src/fallback/`)**:
   - **Dembrandt** -> `design-system/DESIGN.md`, `tokens.dtcg.json`, `theme.tailwind.css`
   - **Project Wallace (`css-analyzer` + `css-design-tokens`)** -> `design-system/wallace-tokens.json`
   - **PurgeCSS** -> removes unused CSS selectors against captured HTML before packing
   - **SingleFile CLI** -> saves an offline self-contained HTML snapshot under `extractions/snapshots/` (outside `./extracted` so it never bloats AI token counts).
7. **Stage 6 — Unified Packing & Repo Storage**: **Repomix** packs `./extracted` into `extractions/ai-site-context-run-<N>-<A>.txt`, commits & pushes it to the repository folder `extractions/`, and also uploads an unzipped Artifact.

## Repository Structure

```text
├── .github/workflows/crawl-site.yml   # CI workflow with actions/cache, Go, Python, Node 22 & Git commit
├── repomix.config.json                # Smart token-saving Repomix config
├── repomix.full.config.json           # Uncompressed Repomix config
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                       # Pipeline orchestrator
    ├── config.ts                      # ENV validation & COMPUTED_STYLE_WHITELIST
    ├── types.ts                       # Shared schemas
    ├── crawler.ts                     # Crawlee + Patchright engine
    ├── recon/
    │   ├── katana-runner.ts           # Katana endpoint discovery
    │   └── tech-detector.ts           # Wappalyzergo + deterministic fallback
    ├── extractors/
    │   ├── snapshot-normalizer.ts     # CDP DOMSnapshot decoder + default style pruning
    │   ├── state-prober.ts            # Scroll, pseudo-state & overlay prober
    │   ├── animation-extractor.ts     # CDP + WAAPI + CSSOM + CSS keyframes
    │   ├── network-collector.ts       # Disk-backed JS/CSS/Map collector
    │   ├── sourcemap-unpacker.ts      # SourceMap v3 unpacker
    │   ├── webcrack-runner.ts         # Sequential worker queue
    │   ├── webcrack-worker.ts         # Isolated Webcrack + Wakaru + Prettier worker
    │   └── svg-optimizer.ts           # SVGO logo & icon optimizer
    ├── design/
    │   ├── dembrandt-runner.ts        # Dembrandt token extractor
    │   ├── wallace-analyzer.ts        # Project Wallace CSS analyzer & tokens
    │   └── css-purger.ts              # PurgeCSS unused-selector pruner
    └── fallback/
        ├── scrapling_fetch.py         # Scrapling StealthyFetcher/Fetcher fallback
        └── singlefile-runner.ts       # SingleFile offline HTML snapshot runner
```

## GitHub Actions Usage (`workflow_dispatch`)

1. Ensure **Settings -> Actions -> General -> Workflow permissions** allows **Read and write permissions** so the workflow can commit outputs to `extractions/`.
2. Open **Actions -> Deep Site Extractor for AI -> Run workflow**.
3. Enter `target_url` (including `https://`), optionally adjust `max_pages`, `max_depth`, `enable_katana`, `enable_purgecss`, `enable_singlefile`, and click **Run workflow**.
4. Download the output directly from `extractions/ai-site-context-run-<N>-<A>.txt` in the repository or from **Artifacts**.
