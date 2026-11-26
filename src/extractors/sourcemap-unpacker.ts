import fs from 'node:fs/promises';
import path from 'node:path';
import type { CollectedAsset, SourceMapRecoverySummary } from '../types.js';

interface SourceMapV3 {
  version?: number;
  sources?: unknown;
  sourcesContent?: unknown;
  sourceRoot?: string;
  sections?: Array<{
    map?: SourceMapV3;
  }>;
}

const IGNORED_SOURCE_PATTERNS = [
  'node_modules/',
  '(webpack)/',
  'webpack/runtime/',
  'vite/preload-helper',
  'turbopack',
];

const SOURCE_MAPPING_URL_REGEX =
  /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$|\/\*[#@]\s*sourceMappingURL=([^\s*'"]+)\s*\*\//m;

export function extractSourceMappingUrl(
  code: string,
  headerValue?: string,
): string | null {
  // Check tail of the file first for performance on large bundles
  const tail = code.length > 8192 ? code.slice(-8192) : code;
  const match = SOURCE_MAPPING_URL_REGEX.exec(tail);
  const inlineRef = match?.[1] ?? match?.[2];
  if (inlineRef) {
    return inlineRef.trim();
  }
  if (headerValue && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

export function decodeInlineSourceMap(dataUri: string): string | null {
  const base64Match = /^data:application\/json(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/i.exec(
    dataUri.trim(),
  );
  if (base64Match?.[1]) {
    return Buffer.from(base64Match[1], 'base64').toString('utf8');
  }
  const utf8Match = /^data:application\/json(?:;[^,]*)?,(.*)$/i.exec(dataUri.trim());
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  return null;
}

export function sanitizeSourcePath(rawSource: string, sourceRoot?: string): string | null {
  let candidate = (sourceRoot ? `${sourceRoot.replace(/\/+$/, '')}/${rawSource}` : rawSource)
    .trim()
    .replace(/\\/g, '/');

  // Strip query strings and fragments
  const qIdx = candidate.indexOf('?');
  if (qIdx !== -1) candidate = candidate.slice(0, qIdx);
  const hIdx = candidate.indexOf('#');
  if (hIdx !== -1) candidate = candidate.slice(0, hIdx);

  // Check blocked patterns before stripping scheme/authority (e.g. webpack:///(webpack)/...)
  const lowerRaw = candidate.toLowerCase();
  for (const blocked of IGNORED_SOURCE_PATTERNS) {
    if (lowerRaw.includes(blocked)) {
      return null;
    }
  }

  // Strip bundler schemes (e.g. webpack:///, vite:///, turbopack:///, file:///)
  candidate = candidate.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/+[^/]*\//, '');
  candidate = candidate.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/+/, '');

  const lower = candidate.toLowerCase();
  for (const blocked of IGNORED_SOURCE_PATTERNS) {
    if (lower.includes(blocked)) {
      return null;
    }
  }

  // Strip leading slashes and dot-slashes, and sanitize traversal segments
  const rawSegments = candidate.split('/');
  const safeSegments: string[] = [];
  for (const seg of rawSegments) {
    if (!seg || seg === '.' || seg === '..') {
      continue;
    }
    const cleaned = seg.replace(/[\0<>:"|?*]/g, '_');
    if (cleaned) {
      safeSegments.push(cleaned);
    }
  }

  if (safeSegments.length === 0) {
    return null;
  }

  return safeSegments.join('/');
}

function collectMapEntries(
  parsed: SourceMapV3,
  entries: Array<{ sourcePath: string; content: string }>,
): void {
  if (Array.isArray(parsed.sections)) {
    for (const section of parsed.sections) {
      if (section?.map) {
        collectMapEntries(section.map, entries);
      }
    }
  }

  if (!Array.isArray(parsed.sources) || !Array.isArray(parsed.sourcesContent)) {
    return;
  }

  const len = Math.min(parsed.sources.length, parsed.sourcesContent.length);
  for (let i = 0; i < len; i++) {
    const rawSource = parsed.sources[i];
    const content = parsed.sourcesContent[i];
    if (typeof rawSource !== 'string' || typeof content !== 'string') {
      continue;
    }
    const safeRelPath = sanitizeSourcePath(rawSource, parsed.sourceRoot);
    if (!safeRelPath) {
      continue;
    }
    entries.push({ sourcePath: safeRelPath, content });
  }
}

export function extractFirstPartySourcesFromMap(
  mapJsonText: string,
): Array<{ sourcePath: string; content: string }> {
  const parsed = JSON.parse(mapJsonText) as SourceMapV3;
  const entries: Array<{ sourcePath: string; content: string }> = [];
  collectMapEntries(parsed, entries);
  return entries;
}

async function resolveMapText(
  mappingRef: string,
  baseAssetUrl: string,
  getCollectedMapByUrl: (url: string) => CollectedAsset | undefined,
): Promise<string | null> {
  if (mappingRef.startsWith('data:')) {
    return decodeInlineSourceMap(mappingRef);
  }

  let resolvedUrl: string;
  try {
    resolvedUrl = new URL(mappingRef, baseAssetUrl).toString();
  } catch {
    return null;
  }

  if (!resolvedUrl.startsWith('http://') && !resolvedUrl.startsWith('https://')) {
    return null;
  }

  const cached = getCollectedMapByUrl(resolvedUrl);
  if (cached) {
    return cached.content;
  }

  try {
    const response = await fetch(resolvedUrl, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

export async function unpackSourceMaps(
  jsAssets: CollectedAsset[],
  getCollectedMapByUrl: (url: string) => CollectedAsset | undefined,
  extractedDir: string,
): Promise<SourceMapRecoverySummary> {
  const outRoot = path.resolve(extractedDir, 'client-src', 'from-sourcemaps');
  const recoveredBundleHashes = new Set<string>();
  const writtenPaths = new Set<string>();
  const warnings: string[] = [];
  let filesRecovered = 0;

  for (const asset of jsAssets) {
    const mappingRef = extractSourceMappingUrl(asset.content, asset.sourceMapHeader);
    if (!mappingRef) {
      continue;
    }

    const mapText = await resolveMapText(mappingRef, asset.url, getCollectedMapByUrl);
    if (!mapText) {
      continue;
    }

    let entries: Array<{ sourcePath: string; content: string }>;
    try {
      entries = extractFirstPartySourcesFromMap(mapText);
    } catch (err) {
      warnings.push(
        `Failed to parse SourceMap for ${asset.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (entries.length === 0) {
      continue;
    }

    recoveredBundleHashes.add(asset.hash);

    for (const entry of entries) {
      const targetPath = path.resolve(outRoot, entry.sourcePath);
      if (!targetPath.startsWith(`${outRoot}${path.sep}`)) {
        continue;
      }
      if (writtenPaths.has(targetPath)) {
        continue;
      }
      writtenPaths.add(targetPath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, entry.content, 'utf8');
      filesRecovered++;
    }
  }

  return {
    filesRecovered,
    recoveredBundleHashes,
    warnings,
  };
}
