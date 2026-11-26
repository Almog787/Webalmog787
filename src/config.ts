import path from 'node:path';
import type { CrawlConfig, StealthMode, ViewportMode } from './types.js';

export const COMPUTED_STYLE_WHITELIST: readonly string[] = [
  'display',
  'position',
  'z-index',
  'top',
  'left',
  'right',
  'bottom',
  'width',
  'height',
  'margin',
  'padding',
  'border-radius',
  'border-width',
  'border-color',
  'background-color',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'opacity',
  'visibility',
  'overflow',
  'transform',
  'box-shadow',
  'flex-direction',
  'grid-template-columns',
];

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

function parseViewports(raw: string | undefined): ViewportMode {
  if (raw?.trim() === 'desktop-only') {
    return 'desktop-only';
  }
  return 'desktop+mobile';
}

function parseStealthMode(raw: string | undefined): StealthMode {
  if (raw?.trim() === 'chromium-headless') {
    return 'chromium-headless';
  }
  return 'chrome-xvfb';
}

export function validateHttpUrl(rawUrl: string, label: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error(`${label} is required and cannot be empty.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid URL (received "${rawUrl}").`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http: or https: protocol (received "${parsed.protocol}").`);
  }
  return parsed.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CrawlConfig {
  const targetUrl = validateHttpUrl(env.TARGET_URL ?? '', 'TARGET_URL');
  const maxPages = clampInt(env.MAX_PAGES, 25, 1, 200);
  const maxDepth = clampInt(env.MAX_DEPTH, 2, 0, 5);
  const viewports = parseViewports(env.VIEWPORTS);
  const stealthMode = parseStealthMode(env.STEALTH_MODE);
  const unpackJs = parseBool(env.UNPACK_JS, true);
  const compressOutput = parseBool(env.COMPRESS_OUTPUT, true);

  const rawBudget = env.TOKEN_BUDGET?.trim();
  const parsedBudget = rawBudget ? Number.parseInt(rawBudget, 10) : 180000;
  const tokenBudget =
    Number.isFinite(parsedBudget) && parsedBudget >= 10000 ? parsedBudget : 180000;

  let proxyUrl: string | undefined;
  const rawProxy = env.PROXY_URL?.trim();
  if (rawProxy) {
    try {
      const parsedProxy = new URL(rawProxy);
      if (!parsedProxy.protocol) {
        throw new Error('Missing protocol');
      }
      proxyUrl = parsedProxy.toString();
    } catch {
      throw new Error(`PROXY_URL is not a valid URL.`);
    }
  }

  const extractedDir = path.resolve(env.EXTRACTED_DIR?.trim() || './extracted');
  const storageDir = path.resolve(env.CRAWLEE_STORAGE_DIR?.trim() || './storage');

  return {
    targetUrl,
    maxPages,
    maxDepth,
    viewports,
    stealthMode,
    unpackJs,
    compressOutput,
    tokenBudget,
    proxyUrl,
    extractedDir,
    storageDir,
  };
}
