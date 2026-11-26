import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'patchright';
import { optimize } from 'svgo';
import type { SvgAssetEntry } from '../types.js';

const MAX_SVG_ASSETS_TOTAL = 25;
const MAX_RAW_SVG_BYTES = 32 * 1024;

interface ExtractedBrowserSvg {
  markup: string;
  selectorHint: string;
  priority: number;
}

export function optimizeSvgMarkup(rawSvg: string): string {
  const result = optimize(rawSvg, {
    multipass: true,
    plugins: ['preset-default'],
  });
  return result.data;
}

export class SvgAssetCollector {
  private readonly extractedDir: string;
  private readonly assets = new Map<string, SvgAssetEntry>();

  constructor(extractedDir: string) {
    this.extractedDir = extractedDir;
  }

  async collectFromPage(page: Page, pageSlug: string): Promise<number> {
    if (this.assets.size >= MAX_SVG_ASSETS_TOTAL) {
      return 0;
    }

    const rawSvgs: ExtractedBrowserSvg[] = await page
      .evaluate((maxBytes) => {
        const results: Array<{ markup: string; selectorHint: string; priority: number }> = [];
        const svgs = Array.from(document.querySelectorAll('svg'));

        for (const svg of svgs) {
          const rect = svg.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;

          const markup = svg.outerHTML;
          if (!markup || markup.length > maxBytes) continue;

          const tag = 'svg';
          const id = svg.id ? `#${svg.id}` : '';
          const cls =
            typeof svg.className?.baseVal === 'string' && svg.className.baseVal.trim()
              ? `.${svg.className.baseVal.trim().split(/\s+/).slice(0, 2).join('.')}`
              : '';
          const selectorHint = `${tag}${id}${cls}`;

          let priority = 10;
          if (svg.closest('header, nav')) priority += 40;
          if (svg.closest('button, a')) priority += 20;
          if (/logo|brand|icon/i.test(selectorHint)) priority += 30;

          results.push({ markup, selectorHint, priority });
        }

        return results.sort((a, b) => b.priority - a.priority).slice(0, 30);
      }, MAX_RAW_SVG_BYTES)
      .catch(() => []);

    if (rawSvgs.length === 0) {
      return 0;
    }

    const outDir = path.join(this.extractedDir, 'svg-assets');
    await fs.mkdir(outDir, { recursive: true });

    let added = 0;
    for (const item of rawSvgs) {
      if (this.assets.size >= MAX_SVG_ASSETS_TOTAL) break;

      let optimized: string;
      try {
        optimized = optimizeSvgMarkup(item.markup);
      } catch {
        continue;
      }

      const hash = crypto
        .createHash('sha256')
        .update(optimized)
        .digest('hex')
        .slice(0, 12);

      if (this.assets.has(hash)) continue;

      const fileName = `${hash}.svg`;
      await fs.writeFile(path.join(outDir, fileName), optimized, 'utf8');

      this.assets.set(hash, {
        hash,
        file: `svg-assets/${fileName}`,
        selectorHint: item.selectorHint,
        pageSlug,
        bytesBefore: Buffer.byteLength(item.markup, 'utf8'),
        bytesAfter: Buffer.byteLength(optimized, 'utf8'),
      });
      added++;
    }

    return added;
  }

  async writeIndex(): Promise<number> {
    if (this.assets.size === 0) {
      return 0;
    }
    const outDir = path.join(this.extractedDir, 'svg-assets');
    await fs.mkdir(outDir, { recursive: true });
    const entries = [...this.assets.values()];
    await fs.writeFile(
      path.join(outDir, 'index.json'),
      JSON.stringify(entries, null, 2),
      'utf8',
    );
    return entries.length;
  }
}
