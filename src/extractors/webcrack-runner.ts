import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import type { CollectedAsset, WebcrackSummary } from '../types.js';

const MAX_BUNDLE_BYTES = Math.floor(2.5 * 1024 * 1024);
const WORKER_TIMEOUT_MS = 30_000;

const VENDOR_PATTERNS = [
  'react-dom',
  'three',
  'lodash',
  'jquery',
  'chunk-vendors',
  'wp-includes',
  'wp-emoji',
  'elementor',
  'swiper',
  'gsap',
  'polyfill',
  'core-js',
  'analytics',
  'gtag',
  'fbevents',
  'slick',
  'owl.carousel',
  'bootstrap',
  'fontawesome',
];

export function shouldSkipBundleForWebcrack(
  asset: CollectedAsset,
  recoveredBundleHashes: Set<string>,
): { skip: boolean; reason?: string } {
  if (recoveredBundleHashes.has(asset.hash)) {
    return { skip: true, reason: 'already-recovered-via-sourcemap' };
  }

  if (asset.sizeBytes > MAX_BUNDLE_BYTES) {
    return { skip: true, reason: 'exceeds-2.5mb-limit' };
  }

  const lowerUrl = asset.url.toLowerCase();
  const lowerFile = path.basename(asset.filePath).toLowerCase();
  for (const vendor of VENDOR_PATTERNS) {
    if (lowerUrl.includes(vendor) || lowerFile.includes(vendor)) {
      return { skip: true, reason: `vendor-bundle:${vendor}` };
    }
  }

  return { skip: false };
}

interface WorkerMessage {
  ok: boolean;
  mode: 'webcrack' | 'prettier' | 'failed';
  error?: string;
}

function runWorkerWithTimeout(
  workerPath: string,
  inputFile: string,
  outputDir: string,
): Promise<WorkerMessage> {
  return new Promise((resolve) => {
    const execArgv = workerPath.endsWith('.ts')
      ? ['--max-old-space-size=2048', '--import', 'tsx']
      : ['--max-old-space-size=2048'];

    const child = fork(workerPath, [inputFile, outputDir], {
      execArgv,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    let settled = false;
    let lastMessage: WorkerMessage | null = null;
    let stderrText = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrText.length < 1024) {
        stderrText += chunk.toString('utf8');
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({
          ok: false,
          mode: 'failed',
          error: `webcrack worker timed out after ${WORKER_TIMEOUT_MS}ms`,
        });
      }
    }, WORKER_TIMEOUT_MS);

    child.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && 'mode' in msg) {
        lastMessage = msg as WorkerMessage;
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, mode: 'failed', error: err.message });
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (lastMessage) {
          resolve(lastMessage);
        } else if (code === 0) {
          resolve({ ok: true, mode: 'webcrack' });
        } else {
          resolve({
            ok: false,
            mode: 'failed',
            error: stderrText.trim() || `Worker exited with code ${code ?? 'unknown'}`,
          });
        }
      }
    });
  });
}

async function runPrettierFallback(
  asset: CollectedAsset,
  outputDir: string,
): Promise<boolean> {
  await fs.mkdir(outputDir, { recursive: true });
  try {
    const code =
      typeof asset.content === 'string'
        ? asset.content
        : await fs.readFile(asset.filePath, 'utf8');
    const formatted = await prettier.format(code, {
      parser: 'babel',
      semi: true,
      singleQuote: true,
    });
    await fs.writeFile(path.join(outputDir, 'formatted.js'), formatted, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function runWebcrackQueue(
  jsAssets: CollectedAsset[],
  recoveredBundleHashes: Set<string>,
  extractedDir: string,
): Promise<WebcrackSummary> {
  const unpackedRoot = path.resolve(extractedDir, 'client-src', 'unpacked');
  await fs.mkdir(unpackedRoot, { recursive: true });

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const workerTsPath = path.join(currentDir, 'webcrack-worker.ts');
  const workerJsPath = path.join(currentDir, 'webcrack-worker.js');
  let workerPath = workerTsPath;
  try {
    await fs.access(workerTsPath);
  } catch {
    workerPath = workerJsPath;
  }

  let filesUnpacked = 0;
  let prettierFallbackCount = 0;
  const warnings: string[] = [];

  for (let idx = 0; idx < jsAssets.length; idx++) {
    const asset = jsAssets[idx]!;
    const baseName = path.basename(asset.filePath);
    const decision = shouldSkipBundleForWebcrack(asset, recoveredBundleHashes);
    if (decision.skip) {
      console.log(
        `[Webcrack ${idx + 1}/${jsAssets.length}] Skipped ${baseName} (${decision.reason})`,
      );
      continue;
    }

    const kb = Math.max(1, Math.round(asset.sizeBytes / 1024));
    const startedAt = Date.now();
    console.log(`[Webcrack ${idx + 1}/${jsAssets.length}] Unpacking ${baseName} (${kb} KB)...`);

    const bundleName = path.basename(asset.filePath, path.extname(asset.filePath));
    const outputDir = path.join(unpackedRoot, bundleName);
    const result = await runWorkerWithTimeout(workerPath, asset.filePath, outputDir);
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (result.ok && result.mode === 'webcrack') {
      filesUnpacked++;
      console.log(`[Webcrack ${idx + 1}/${jsAssets.length}] Done ${baseName} via webcrack (${elapsedSec}s)`);
    } else if (result.ok && result.mode === 'prettier') {
      prettierFallbackCount++;
      filesUnpacked++;
      console.log(`[Webcrack ${idx + 1}/${jsAssets.length}] Done ${baseName} via prettier fallback (${elapsedSec}s)`);
    } else {
      const okPrettier = await runPrettierFallback(asset, outputDir);
      if (okPrettier) {
        prettierFallbackCount++;
        filesUnpacked++;
        console.log(`[Webcrack ${idx + 1}/${jsAssets.length}] Done ${baseName} via prettier fallback (${elapsedSec}s)`);
      } else {
        console.log(`[Webcrack ${idx + 1}/${jsAssets.length}] Failed ${baseName} (${elapsedSec}s)`);
        warnings.push(
          `Skipped unpacking ${baseName}: ${result.error ?? 'unknown error'}`,
        );
      }
    }
  }

  return {
    filesUnpacked,
    prettierFallbackCount,
    warnings,
  };
}
