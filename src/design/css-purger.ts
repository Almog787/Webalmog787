import fs from 'node:fs/promises';
import path from 'node:path';
import { PurgeCSS } from 'purgecss';
import type { PurgeCssSummary } from '../types.js';

async function findHtmlFiles(pagesDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(pagesDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(pagesDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findHtmlFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function purgeCssStrings(
  cssText: string,
  htmlContents: string[],
): Promise<string> {
  const results = await new PurgeCSS().purge({
    content: htmlContents.map((raw) => ({ raw, extension: 'html' })),
    css: [{ raw: cssText }],
    keyframes: false,
    variables: false,
    fontFace: false,
    safelist: {
      standard: ['html', 'body', 'active', 'open', 'show', 'visible', 'hidden'],
      greedy: [/^(is|has)-/, /^aria-/, /^data-/],
    },
  });
  return results[0]?.css ?? cssText;
}

export async function runPurgeCss(extractedDir: string): Promise<PurgeCssSummary> {
  const stylesDir = path.join(extractedDir, 'styles');
  const pagesDir = path.join(extractedDir, 'pages');
  const warnings: string[] = [];

  let cssFiles: string[];
  try {
    cssFiles = (await fs.readdir(stylesDir))
      .filter((name) => name.endsWith('.css'))
      .map((name) => path.join(stylesDir, name));
  } catch {
    return {
      purged: false,
      filesProcessed: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      warnings,
    };
  }

  const htmlFiles = await findHtmlFiles(pagesDir);
  if (cssFiles.length === 0 || htmlFiles.length === 0) {
    return {
      purged: false,
      filesProcessed: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      warnings,
    };
  }

  let bytesBefore = 0;
  let bytesAfter = 0;
  let filesProcessed = 0;

  for (const cssFile of cssFiles) {
    try {
      const original = await fs.readFile(cssFile, 'utf8');
      const beforeLen = Buffer.byteLength(original, 'utf8');
      bytesBefore += beforeLen;

      const results = await new PurgeCSS().purge({
        content: htmlFiles,
        css: [cssFile],
        keyframes: false,
        variables: false,
        fontFace: false,
        safelist: {
          standard: ['html', 'body', 'active', 'open', 'show', 'visible', 'hidden'],
          greedy: [/^(is|has)-/, /^aria-/, /^data-/],
        },
      });

      const purgedCss = results[0]?.css;
      if (typeof purgedCss === 'string' && purgedCss.length > 0) {
        await fs.writeFile(cssFile, purgedCss, 'utf8');
        bytesAfter += Buffer.byteLength(purgedCss, 'utf8');
      } else {
        bytesAfter += beforeLen;
      }
      filesProcessed++;
    } catch (err) {
      warnings.push(
        `PurgeCSS skipped ${path.basename(cssFile)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const pct =
    bytesBefore > 0
      ? (((bytesBefore - bytesAfter) / bytesBefore) * 100).toFixed(1)
      : '0.0';
  console.log(
    `[PurgeCSS] Processed ${filesProcessed} stylesheet(s): ${Math.round(bytesBefore / 1024)} KB -> ${Math.round(bytesAfter / 1024)} KB (-${pct}%)`,
  );

  return {
    purged: filesProcessed > 0,
    filesProcessed,
    bytesBefore,
    bytesAfter,
    warnings,
  };
}
