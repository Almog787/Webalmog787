import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { runCrawlStage } from './crawler.js';
import { runPurgeCss } from './design/css-purger.js';
import { runDembrandt } from './design/dembrandt-runner.js';
import { runWallaceAnalysis } from './design/wallace-analyzer.js';
import { unpackSourceMaps } from './extractors/sourcemap-unpacker.js';
import { runWebcrackQueue } from './extractors/webcrack-runner.js';
import { runSingleFileSnapshot } from './fallback/singlefile-runner.js';
import { runKatanaRecon } from './recon/katana-runner.js';
import { runTechDetector } from './recon/tech-detector.js';
import type { ManifestData } from './types.js';

const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

function startGroup(title: string): void {
  if (IS_GITHUB_ACTIONS) {
    console.log(`::group::${title}`);
  } else {
    console.log(title);
  }
}

function endGroup(): void {
  if (IS_GITHUB_ACTIONS) {
    console.log('::endgroup::');
  }
}

async function resetWorkspaceDirs(extractedDir: string, storageDir: string): Promise<void> {
  await Promise.all([
    fs.rm(extractedDir, { recursive: true, force: true }),
    fs.rm(storageDir, { recursive: true, force: true }),
  ]);
  await Promise.all([
    fs.mkdir(extractedDir, { recursive: true }),
    fs.mkdir(storageDir, { recursive: true }),
  ]);
}

function runScraplingFallback(
  targetUrl: string,
  extractedDir: string,
): Promise<{ recovered: boolean; warning?: string }> {
  return new Promise((resolve) => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.join(currentDir, 'fallback', 'scrapling_fetch.py');
    const child = spawn('python3', [scriptPath, targetUrl, extractedDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) console.log(line.trim());
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ recovered: false, warning: 'Scrapling fallback timed out after 60s' });
    }, 60_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ recovered: false, warning: `Scrapling fallback unavailable: ${err.message}` });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ recovered: true });
      } else {
        resolve({
          recovered: false,
          warning: `Scrapling fallback exited ${String(code)}: ${stderr.trim() || 'no output'}`,
        });
      }
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const warnings: string[] = [];

  startGroup(`[Stage 1] Initializing extraction for ${config.targetUrl}`);
  console.log(
    `[Config] maxPages=${config.maxPages}, maxDepth=${config.maxDepth}, viewports=${config.viewports}, stealth=${config.stealthMode}, unpackJs=${config.unpackJs}, katana=${config.enableKatana}, purgeCss=${config.enablePurgeCss}, singleFile=${config.enableSingleFile}`,
  );
  await resetWorkspaceDirs(config.extractedDir, config.storageDir);

  const initialManifest: ManifestData = {
    schemaVersion: '1.0.0',
    targetUrl: config.targetUrl,
    crawledAt: new Date().toISOString(),
    config: {
      maxPages: config.maxPages,
      maxDepth: config.maxDepth,
      viewports: config.viewports,
      stealthMode: config.stealthMode,
      unpackJs: config.unpackJs,
    },
    stats: {
      pagesCrawled: 0,
      totalLayoutNodes: 0,
      totalOverlays: 0,
      totalAnimations: 0,
      sourceMapFilesRecovered: 0,
      webcrackFilesUnpacked: 0,
      wakaruFilesUnpacked: 0,
      svgIconsOptimized: 0,
      cssBytesBeforePurge: 0,
      cssBytesAfterPurge: 0,
      katanaDiscoveredUrls: 0,
      technologiesDetected: 0,
      designSystemExtracted: false,
      wallaceTokensExtracted: false,
      scraplingFallbackUsed: false,
      singleFileSaved: false,
    },
    pages: [],
    warnings: [],
  };

  await fs.writeFile(
    path.join(config.extractedDir, 'manifest.json'),
    JSON.stringify(initialManifest, null, 2),
    'utf8',
  );
  endGroup();

  startGroup('[Stage 1.5] Tech stack fingerprinting (Wappalyzergo) & endpoint discovery (Katana)');
  const techResult = await runTechDetector(config.targetUrl, config.extractedDir);
  warnings.push(...techResult.warnings);

  const katanaResult = config.enableKatana
    ? await runKatanaRecon(config.targetUrl, config.maxDepth, config.maxPages, config.extractedDir)
    : { ran: false, discoveredUrls: [], seedPageUrls: [], warnings: [] };
  warnings.push(...katanaResult.warnings);
  endGroup();

  startGroup('[Stage 2] Crawling pages, capturing DOM/overlays/animations & optimizing SVGs');
  const crawlResult = await runCrawlStage(config, katanaResult.seedPageUrls);
  warnings.push(...crawlResult.warnings);

  let scraplingFallbackUsed = false;
  if (crawlResult.pages.length === 0) {
    console.log('[Stage 2b] 0 pages crawled by Patchright; invoking Scrapling StealthyFetcher fallback...');
    const scraplingRes = await runScraplingFallback(config.targetUrl, config.extractedDir);
    if (scraplingRes.recovered) {
      scraplingFallbackUsed = true;
      crawlResult.pages.push({
        slug: 'index',
        url: config.targetUrl,
        title: 'Recovered via Scrapling',
        status: 200,
      });
    } else if (scraplingRes.warning) {
      warnings.push(scraplingRes.warning);
    }
  }

  console.log(
    `[Stage 2 Summary] Crawled ${crawlResult.pages.length} page(s), ${crawlResult.totalLayoutNodes} nodes, ${crawlResult.totalOverlays} overlays, ${crawlResult.totalAnimations} animations, ${crawlResult.svgIconsOptimized} SVGO icons.`,
  );
  endGroup();

  const jsAssets = crawlResult.networkCollector.getAllAssets('js');
  let sourceMapFilesRecovered = 0;
  let webcrackFilesUnpacked = 0;
  let wakaruFilesUnpacked = 0;

  if (config.unpackJs) {
    startGroup(`[Stage 3] Unpacking SourceMaps across ${jsAssets.length} collected JS asset(s)`);
    const smResult = await unpackSourceMaps(
      jsAssets,
      (url) => crawlResult.networkCollector.getAssetByUrl(url),
      config.extractedDir,
    );
    sourceMapFilesRecovered = smResult.filesRecovered;
    warnings.push(...smResult.warnings);
    console.log(`[Stage 3 Summary] Recovered ${sourceMapFilesRecovered} first-party source file(s).`);
    endGroup();

    startGroup('[Stage 4] Unpacking remaining JS bundles (Webcrack + Wakaru + Prettier)');
    const wcResult = await runWebcrackQueue(
      jsAssets,
      smResult.recoveredBundleHashes,
      config.extractedDir,
    );
    webcrackFilesUnpacked = wcResult.filesUnpacked;
    wakaruFilesUnpacked = wcResult.wakaruUnpackedCount;
    warnings.push(...wcResult.warnings);
    console.log(
      `[Stage 4 Summary] Unpacked ${webcrackFilesUnpacked} bundle(s) (${wakaruFilesUnpacked} via Wakaru, ${wcResult.prettierFallbackCount} via Prettier fallback).`,
    );
    endGroup();
  } else {
    console.log('[Stage 3-4] UNPACK_JS=false — skipping SourceMap & JS unpacking.');
  }

  startGroup('[Stage 5] Extracting design tokens (Dembrandt + Wallace) & purging dead CSS (PurgeCSS)');
  const dembrandtResult = await runDembrandt(config.targetUrl, config.extractedDir);
  warnings.push(...dembrandtResult.warnings);

  const wallaceResult = await runWallaceAnalysis(config.extractedDir);
  warnings.push(...wallaceResult.warnings);

  const purgeResult = config.enablePurgeCss
    ? await runPurgeCss(config.extractedDir)
    : { purged: false, filesProcessed: 0, bytesBefore: 0, bytesAfter: 0, warnings: [] };
  warnings.push(...purgeResult.warnings);

  let singleFileSaved = false;
  if (config.enableSingleFile && config.snapshotOutPath) {
    const sfResult = await runSingleFileSnapshot(config.targetUrl, config.snapshotOutPath);
    singleFileSaved = sfResult.saved;
    warnings.push(...sfResult.warnings);
  }
  endGroup();

  const finalManifest: ManifestData = {
    schemaVersion: '1.0.0',
    targetUrl: config.targetUrl,
    crawledAt: initialManifest.crawledAt,
    config: initialManifest.config,
    stats: {
      pagesCrawled: crawlResult.pages.length,
      totalLayoutNodes: crawlResult.totalLayoutNodes,
      totalOverlays: crawlResult.totalOverlays,
      totalAnimations: crawlResult.totalAnimations,
      sourceMapFilesRecovered,
      webcrackFilesUnpacked,
      wakaruFilesUnpacked,
      svgIconsOptimized: crawlResult.svgIconsOptimized,
      cssBytesBeforePurge: purgeResult.bytesBefore,
      cssBytesAfterPurge: purgeResult.bytesAfter,
      katanaDiscoveredUrls: katanaResult.discoveredUrls.length,
      technologiesDetected: techResult.technologies.length,
      designSystemExtracted: dembrandtResult.extracted,
      wallaceTokensExtracted: wallaceResult.analyzed,
      scraplingFallbackUsed,
      singleFileSaved,
    },
    pages: crawlResult.pages,
    warnings,
  };

  await fs.writeFile(
    path.join(config.extractedDir, 'manifest.json'),
    JSON.stringify(finalManifest, null, 2),
    'utf8',
  );

  const summaryLine =
    `Crawled ${finalManifest.stats.pagesCrawled} page(s), ` +
    `${finalManifest.stats.totalLayoutNodes} nodes, ` +
    `${finalManifest.stats.totalOverlays} overlays, ` +
    `${finalManifest.stats.totalAnimations} animations, ` +
    `${crawlResult.svgIconsOptimized} SVGs, ` +
    `${sourceMapFilesRecovered} sourcemap files, ` +
    `${webcrackFilesUnpacked} unpacked bundles (${wakaruFilesUnpacked} Wakaru), ` +
    `${techResult.technologies.length} tech signatures.`;

  if (IS_GITHUB_ACTIONS) {
    console.log(`::notice::Extraction Complete: ${summaryLine}`);
  } else {
    console.log(`[Complete] ${summaryLine}`);
  }
}

main().catch((err) => {
  console.error('[Fatal]', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
