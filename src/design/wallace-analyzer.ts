import fs from 'node:fs/promises';
import path from 'node:path';
import { analyze } from '@projectwallace/css-analyzer';
import { analysis_to_tokens, create_collectors } from '@projectwallace/css-design-tokens';
import type { WallaceAnalysisSummary } from '../types.js';

export function analyzeCssToWallaceTokens(combinedCss: string): {
  tokens: ReturnType<typeof analysis_to_tokens>;
  metrics: {
    colorsCount: number;
    fontSizesCount: number;
    fontFamiliesCount: number;
    gradientsCount: number;
    boxShadowsCount: number;
    durationsCount: number;
    timingFunctionsCount: number;
  };
} {
  const collectors = create_collectors();
  const analysis = analyze(combinedCss, collectors);
  const tokens = analysis_to_tokens(analysis);

  return {
    tokens,
    metrics: {
      colorsCount: Object.keys(tokens.color).length,
      fontSizesCount: Object.keys(tokens.font_size).length,
      fontFamiliesCount: Object.keys(tokens.font_family).length,
      gradientsCount: Object.keys(tokens.gradient).length,
      boxShadowsCount: Object.keys(tokens.box_shadow).length,
      durationsCount: Object.keys(tokens.duration).length,
      timingFunctionsCount: Object.keys(tokens.easing).length,
    },
  };
}

export async function runWallaceAnalysis(
  extractedDir: string,
): Promise<WallaceAnalysisSummary> {
  const stylesDir = path.join(extractedDir, 'styles');
  const designDir = path.join(extractedDir, 'design-system');
  await fs.mkdir(designDir, { recursive: true });
  const warnings: string[] = [];

  let files: string[];
  try {
    files = (await fs.readdir(stylesDir))
      .filter((name) => name.endsWith('.css'))
      .map((name) => path.join(stylesDir, name));
  } catch {
    return { analyzed: false, cssFilesCount: 0, totalBytes: 0, warnings };
  }

  if (files.length === 0) {
    return { analyzed: false, cssFilesCount: 0, totalBytes: 0, warnings };
  }

  let combinedCss = '';
  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      combinedCss += `\n/* ${path.basename(filePath)} */\n${content}\n`;
    } catch {
      // Skip unreadable CSS
    }
  }

  const totalBytes = Buffer.byteLength(combinedCss, 'utf8');
  if (totalBytes === 0) {
    return { analyzed: false, cssFilesCount: files.length, totalBytes: 0, warnings };
  }

  try {
    const result = analyzeCssToWallaceTokens(combinedCss);
    await fs.writeFile(
      path.join(designDir, 'wallace-tokens.json'),
      JSON.stringify(result, null, 2),
      'utf8',
    );
    console.log(
      `[Wallace] Extracted CSS tokens (${result.metrics.colorsCount} colors, ${result.metrics.fontSizesCount} font sizes, ${result.metrics.fontFamiliesCount} fonts, ${result.metrics.durationsCount} durations).`,
    );
    return {
      analyzed: true,
      cssFilesCount: files.length,
      totalBytes,
      warnings,
    };
  } catch (err) {
    const msg = `Wallace CSS analysis failed: ${err instanceof Error ? err.message : String(err)}`;
    warnings.push(msg);
    console.log(`[Wallace] Skipped (${msg})`);
    return { analyzed: false, cssFilesCount: files.length, totalBytes, warnings };
  }
}
