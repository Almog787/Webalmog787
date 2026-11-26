import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { runCrawlStage } from './crawler.js';
import { runDembrandt } from './design/dembrandt-runner.js';
import { unpackSourceMaps } from './extractors/sourcemap-unpacker.js';
import { runWebcrackQueue } from './extractors/webcrack-runner.js';
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

async function main(): Promise<void> {
  const config = loadConfig();
  const warnings: string[] = [];

  startGroup(`[Stage 1] Initializing extraction for ${config.targetUrl}`);
  console.log(
    `[Config] maxPages=${config.maxPages}, maxDepth=${config.maxDepth}, viewports=${config.viewports}, stealth=${config.stealthMode}, unpackJs=${config.unpackJs}`,
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
      designSystemExtracted: false,
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

  startGroup('[Stage 2] Crawling pages & capturing layout/overlay/animation snapshots');
  const crawlResult = await runCrawlStage(config);
  warnings.push(...crawlResult.warnings);
  console.log(
    `[Stage 2 Summary] Crawled ${crawlResult.pages.length} page(s), ${crawlResult.totalLayoutNodes} nodes, ${crawlResult.totalOverlays} overlays, ${crawlResult.totalAnimations} animations.`,
  );
  endGroup();

  const jsAssets = crawlResult.networkCollector.getAllAssets('js');
  let sourceMapFilesRecovered = 0;
  let webcrackFilesUnpacked = 0;

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

    startGroup('[Stage 4] Running isolated webcrack queue on remaining JS bundles');
    const wcResult = await runWebcrackQueue(
      jsAssets,
      smResult.recoveredBundleHashes,
      config.extractedDir,
    );
    webcrackFilesUnpacked = wcResult.filesUnpacked;
    warnings.push(...wcResult.warnings);
    console.log(
      `[Stage 4 Summary] Unpacked ${webcrackFilesUnpacked} bundle(s) (${wcResult.prettierFallbackCount} via Prettier fallback).`,
    );
    endGroup();
  } else {
    console.log('[Stage 3-4] UNPACK_JS=false — skipping SourceMap & webcrack unpacking.');
  }

  startGroup('[Stage 5] Extracting deterministic design tokens via Dembrandt');
  const dembrandtResult = await runDembrandt(config.targetUrl, config.extractedDir);
  warnings.push(...dembrandtResult.warnings);
  console.log(`[Stage 5 Summary] Design system extracted: ${dembrandtResult.extracted}`);
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
      designSystemExtracted: dembrandtResult.extracted,
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
    `${finalManifest.stats.totalLayoutNodes} layout nodes, ` +
    `${finalManifest.stats.totalOverlays} overlays, ` +
    `${finalManifest.stats.totalAnimations} animations, ` +
    `${sourceMapFilesRecovered} sourcemap files, ` +
    `${webcrackFilesUnpacked} unpacked bundles.`;

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
