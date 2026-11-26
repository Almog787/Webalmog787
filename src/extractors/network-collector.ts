import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, Response } from 'patchright';
import type { CollectedAsset, CollectedAssetKind } from '../types.js';

const BASE64_DATA_URI_REGEX = /data:[^;,\s"')]+;base64,[A-Za-z0-9+/=]+/gi;

export function sanitizeCssBase64(cssText: string): string {
  return cssText.replace(BASE64_DATA_URI_REGEX, (match) => {
    if (match.length > 256) {
      return `[base64-omitted:${match.length}-chars]`;
    }
    return match;
  });
}

function classifyAsset(url: string, contentType: string): CollectedAssetKind | null {
  const lowerCt = contentType.toLowerCase();
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase().split('?')[0] ?? '';
  }

  if (pathname.endsWith('.map') || (lowerCt.includes('application/json') && pathname.endsWith('.map'))) {
    return 'map';
  }
  if (pathname.endsWith('.css') || lowerCt.includes('text/css')) {
    return 'css';
  }
  if (
    pathname.endsWith('.js') ||
    pathname.endsWith('.mjs') ||
    pathname.endsWith('.cjs') ||
    lowerCt.includes('javascript') ||
    lowerCt.includes('ecmascript')
  ) {
    return 'js';
  }
  return null;
}

function safeFileBaseName(url: string, fallbackExt: string): string {
  try {
    const parsed = new URL(url);
    const base = path.posix.basename(parsed.pathname) || `asset.${fallbackExt}`;
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    return cleaned || `asset.${fallbackExt}`;
  } catch {
    return `asset.${fallbackExt}`;
  }
}

export async function readAssetText(asset: CollectedAsset): Promise<string> {
  if (typeof asset.content === 'string') {
    return asset.content;
  }
  return fs.readFile(asset.filePath, 'utf8');
}

export class NetworkCollector {
  private readonly extractedDir: string;
  private readonly assetsByHash = new Map<string, CollectedAsset>();
  private readonly assetsByUrl = new Map<string, CollectedAsset>();
  private readonly pageCssHashes = new Map<string, Set<string>>();
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(extractedDir: string) {
    this.extractedDir = extractedDir;
  }

  attachToPage(page: Page, getPageSlug: () => string): () => void {
    const onResponse = (response: Response): void => {
      const task = this.handleResponse(response, getPageSlug).catch(() => undefined);
      this.pendingWrites.add(task);
      void task.finally(() => {
        this.pendingWrites.delete(task);
      });
    };

    page.on('response', onResponse);
    return () => {
      page.off('response', onResponse);
    };
  }

  private async handleResponse(response: Response, getPageSlug: () => string): Promise<void> {
    const status = response.status();
    if (status < 200 || status >= 300) {
      return;
    }

    const url = response.url();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return;
    }

    const headers = response.headers();
    const contentType = headers['content-type'] ?? '';
    const kind = classifyAsset(url, contentType);
    if (!kind) {
      return;
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch {
      return;
    }

    if (!rawText || rawText.length === 0) {
      return;
    }

    const processedText = kind === 'css' ? sanitizeCssBase64(rawText) : rawText;
    const hash = crypto
      .createHash('sha256')
      .update(`${kind}:${processedText}`)
      .digest('hex')
      .slice(0, 16);

    const sourceMapHeader = headers['sourcemap'] || headers['x-sourcemap'];
    const pageSlug = getPageSlug();
    const sizeBytes = Buffer.byteLength(processedText, 'utf8');

    if (kind === 'css' && pageSlug) {
      let slugSet = this.pageCssHashes.get(pageSlug);
      if (!slugSet) {
        slugSet = new Set<string>();
        this.pageCssHashes.set(pageSlug, slugSet);
      }
      if (!slugSet.has(hash)) {
        slugSet.add(hash);
        const stylesDir = path.join(this.extractedDir, 'pages', pageSlug, 'styles');
        await fs.mkdir(stylesDir, { recursive: true });
        const fileName = `${hash}-${safeFileBaseName(url, 'css')}`;
        const cssFilePath = path.join(stylesDir, fileName);
        await fs.writeFile(cssFilePath, processedText, 'utf8');
      }
    }

    if (this.assetsByHash.has(hash)) {
      const existing = this.assetsByHash.get(hash)!;
      if (!this.assetsByUrl.has(url)) {
        this.assetsByUrl.set(url, existing);
      }
      return;
    }

    let targetPath: string;
    if (kind === 'js') {
      const dir = path.join(this.extractedDir, 'client-src', 'raw-bundles');
      await fs.mkdir(dir, { recursive: true });
      targetPath = path.join(dir, `${hash}-${safeFileBaseName(url, 'js')}`);
      await fs.writeFile(targetPath, processedText, 'utf8');
    } else if (kind === 'map') {
      const dir = path.join(this.extractedDir, 'client-src', 'raw-maps');
      await fs.mkdir(dir, { recursive: true });
      targetPath = path.join(dir, `${hash}-${safeFileBaseName(url, 'map')}`);
      await fs.writeFile(targetPath, processedText, 'utf8');
    } else {
      targetPath = path.join(
        this.extractedDir,
        'pages',
        pageSlug || 'index',
        'styles',
        `${hash}-${safeFileBaseName(url, 'css')}`,
      );
    }

    // Store metadata only; file contents live on disk to keep crawler RAM usage minimal
    const asset: CollectedAsset = {
      url,
      kind,
      hash,
      filePath: targetPath,
      sizeBytes,
      ...(sourceMapHeader ? { sourceMapHeader } : {}),
      ...(pageSlug ? { pageSlug } : {}),
    };

    this.assetsByHash.set(hash, asset);
    this.assetsByUrl.set(url, asset);
  }

  async flush(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
  }

  getAllAssets(kind?: CollectedAssetKind): CollectedAsset[] {
    const all = [...this.assetsByHash.values()];
    return kind ? all.filter((asset) => asset.kind === kind) : all;
  }

  getAssetByUrl(url: string): CollectedAsset | undefined {
    return this.assetsByUrl.get(url);
  }
}
