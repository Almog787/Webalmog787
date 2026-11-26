import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMPUTED_STYLE_WHITELIST, loadConfig } from './config.js';
import {
  sanitizeRenderedHtml,
  stripTrackingParams,
  urlToSlug,
} from './crawler.js';
import { extractCssKeyframesFromText } from './extractors/animation-extractor.js';
import { sanitizeCssBase64 } from './extractors/network-collector.js';
import { normalizeDomSnapshot } from './extractors/snapshot-normalizer.js';
import {
  decodeInlineSourceMap,
  extractFirstPartySourcesFromMap,
  extractSourceMappingUrl,
  sanitizeSourcePath,
  unpackSourceMaps,
} from './extractors/sourcemap-unpacker.js';
import {
  runWebcrackQueue,
  shouldSkipBundleForWebcrack,
} from './extractors/webcrack-runner.js';
import type { CdpCaptureSnapshotResult, CollectedAsset } from './types.js';

test('config: validates TARGET_URL, clamps bounds, and exposes 27 computed styles', () => {
  assert.equal(COMPUTED_STYLE_WHITELIST.length, 27);
  assert.throws(() => loadConfig({}), /TARGET_URL/);
  assert.throws(() => loadConfig({ TARGET_URL: 'ftp://example.com' }), /http: or https:/);

  const cfg = loadConfig({
    TARGET_URL: 'https://example.com/docs',
    MAX_PAGES: '999',
    MAX_DEPTH: '-3',
    VIEWPORTS: 'desktop-only',
    STEALTH_MODE: 'chromium-headless',
    UNPACK_JS: 'false',
    COMPRESS_OUTPUT: 'false',
    TOKEN_BUDGET: '500',
  });

  assert.equal(cfg.targetUrl, 'https://example.com/docs');
  assert.equal(cfg.maxPages, 200);
  assert.equal(cfg.maxDepth, 0);
  assert.equal(cfg.viewports, 'desktop-only');
  assert.equal(cfg.stealthMode, 'chromium-headless');
  assert.equal(cfg.unpackJs, false);
  assert.equal(cfg.compressOutput, false);
  assert.equal(cfg.tokenBudget, 180000);
});

test('crawler helpers: stripTrackingParams, urlToSlug, and sanitizeRenderedHtml', () => {
  const cleanedUrl = stripTrackingParams(
    'https://example.com/pricing?plan=pro&utm_source=x&utm_medium=y&fbclid=123&gclid=456&mc_cid=789&ref=abc#hero',
  );
  assert.equal(cleanedUrl, 'https://example.com/pricing?plan=pro');

  assert.equal(urlToSlug('https://example.com/'), 'index');
  assert.equal(urlToSlug('https://example.com/docs/getting-started'), 'docs__getting-started');
  assert.match(urlToSlug('https://example.com/search?q=test'), /^search--[a-f0-9]{8}$/);

  const longBase64 = 'A'.repeat(300);
  const longSvgPath = 'M0 0 '.repeat(600);
  const html = `<html><body><script>console.log(1)</script><img src="data:image/png;base64,${longBase64}" /><svg><path d="${longSvgPath}" /></svg></body></html>`;
  const sanitized = sanitizeRenderedHtml(html);

  assert.equal(sanitized.includes('<script>'), false);
  assert.equal(sanitized.includes('[base64-omitted:'), true);
  assert.equal(sanitized.includes('[svg-path-truncated:'), true);
});

test('snapshot-normalizer: decodes columnar CDP snapshot, filters hidden nodes, caps 2500, and detects overlays', () => {
  const strings = [
    '',
    'HTML',
    'HEADER',
    'DIV',
    '#text',
    'id',
    'main-nav',
    'class',
    'sticky top-0',
    'role',
    'dialog',
    'aria-modal',
    'true',
    'Welcome Home',
    'flex',
    'sticky',
    '50',
    'none',
    'fixed',
    '60',
    '1',
    'visible',
  ];
  const idx = (val: string) => strings.indexOf(val);
  const styleRow = (overrides: Record<string, string>) =>
    COMPUTED_STYLE_WHITELIST.map((prop) => {
      const v = overrides[prop];
      return v !== undefined ? idx(v) : -1;
    });

  const snapshot: CdpCaptureSnapshotResult = {
    strings,
    documents: [
      {
        contentWidth: 1440,
        contentHeight: 2400,
        nodes: {
          parentIndex: [-1, 0, 1, 0, 0],
          nodeType: [1, 1, 3, 1, 1],
          nodeName: [idx('HTML'), idx('HEADER'), idx('#text'), idx('DIV'), idx('DIV')],
          nodeValue: [-1, -1, idx('Welcome Home'), -1, -1],
          attributes: [
            [],
            [idx('id'), idx('main-nav'), idx('class'), idx('sticky top-0')],
            [],
            [],
            [idx('role'), idx('dialog'), idx('aria-modal'), idx('true')],
          ],
        },
        layout: {
          nodeIndex: [1, 3, 4],
          bounds: [
            [0, 0, 1440, 72],
            [0, 0, 500, 100],
            [100, 100, 400, 300],
          ],
          paintOrders: [10, 11, 25],
          styles: [
            styleRow({ display: 'flex', position: 'sticky', 'z-index': '50', opacity: '1', visibility: 'visible' }),
            styleRow({ display: 'none', position: 'fixed', 'z-index': '99' }),
            styleRow({ display: 'flex', position: 'fixed', 'z-index': '60', opacity: '1', visibility: 'visible' }),
          ],
        },
      },
    ],
  };

  const decoded = normalizeDomSnapshot(snapshot, { width: 1440, height: 900 });
  assert.equal(decoded.viewportSnapshot.nodeCount, 2);
  assert.equal(decoded.viewportSnapshot.nodes[0]?.tag, 'header');
  assert.equal(decoded.viewportSnapshot.nodes[0]?.text, 'Welcome Home');
  assert.equal(decoded.viewportSnapshot.nodes[0]?.styles['display'], 'flex');
  assert.equal(decoded.viewportSnapshot.nodes[0]?.styles['z-index'], '50');
  assert.equal(decoded.viewportSnapshot.nodes[0]?.styles['opacity'], undefined);
  assert.equal(decoded.viewportSnapshot.nodes[0]?.styles['visibility'], undefined);
  assert.equal(decoded.viewportSnapshot.nodes[1]?.role, 'dialog');
  assert.equal(decoded.overlays.length, 2);
  assert.equal(decoded.overlays[0]?.selectorHint, 'header#main-nav.sticky.top-0');
});

test('animation-extractor: parses nested @keyframes and @starting-style from raw CSS safely', () => {
  const css = `
    /* @keyframes ignoredComment { 0% { opacity: 0; } } */
    .btn { content: "{ fake brace }"; }
    @keyframes heroFadeUp {
      0% { opacity: 0; transform: translateY(24px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    @starting-style {
      dialog[open] { opacity: 0; }
    }
  `;
  const extracted = extractCssKeyframesFromText(css, 'https://example.com/app.css');
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0]?.name, 'heroFadeUp');
  assert.equal(extracted[0]?.rulesText.includes('translateY(24px)'), true);
  assert.equal(extracted[1]?.name, '@starting-style');
});

test('network-collector: sanitizeCssBase64 truncates oversized data URIs', () => {
  const css = `background: url("data:image/svg+xml;base64,${'B'.repeat(300)}");`;
  const sanitized = sanitizeCssBase64(css);
  assert.equal(sanitized.includes('[base64-omitted:'), true);
});

test('sourcemap-unpacker: filters vendor/runtime sources, blocks traversal, and unpacks inline maps', async () => {
  assert.equal(sanitizeSourcePath('webpack:///./node_modules/react/index.js'), null);
  assert.equal(sanitizeSourcePath('webpack:///(webpack)/buildin/global.js'), null);
  assert.equal(sanitizeSourcePath('webpack:///webpack/runtime/chunk'), null);
  assert.equal(sanitizeSourcePath('vite/preload-helper.js'), null);
  assert.equal(sanitizeSourcePath('turbopack:///[project]/foo.ts'), null);
  assert.equal(sanitizeSourcePath('webpack:///../../src/components/Hero.tsx'), 'src/components/Hero.tsx');

  const sampleMap = JSON.stringify({
    version: 3,
    sources: [
      'webpack:///./node_modules/lodash/index.js',
      'webpack:///../../src/App.tsx',
    ],
    sourcesContent: ['module.exports = {};', 'export const App = () => "ok";'],
  });
  const encoded = Buffer.from(sampleMap, 'utf8').toString('base64');
  const jsCode = `console.log(1);\n//# sourceMappingURL=data:application/json;base64,${encoded}`;
  const ref = extractSourceMappingUrl(jsCode);
  assert.ok(ref);
  const decodedJson = decodeInlineSourceMap(ref);
  assert.ok(decodedJson);
  const entries = extractFirstPartySourcesFromMap(decodedJson);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.sourcePath, 'src/App.tsx');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-test-'));
  try {
    const asset: CollectedAsset = {
      url: 'https://example.com/assets/main.js',
      kind: 'js',
      hash: 'abc123',
      filePath: path.join(tmpDir, 'main.js'),
      content: jsCode,
      sizeBytes: jsCode.length,
    };
    const summary = await unpackSourceMaps([asset], () => undefined, tmpDir);
    assert.equal(summary.filesRecovered, 1);
    assert.equal(summary.recoveredBundleHashes.has('abc123'), true);
    const written = await fs.readFile(
      path.join(tmpDir, 'client-src', 'from-sourcemaps', 'src', 'App.tsx'),
      'utf8',
    );
    assert.equal(written, 'export const App = () => "ok";');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('webcrack-runner: skips vendor/oversized/recovered bundles and forks worker for remaining JS', async () => {
  const vendorAsset: CollectedAsset = {
    url: 'https://example.com/react-dom.production.min.js',
    kind: 'js',
    hash: 'v1',
    filePath: '/tmp/react-dom.production.min.js',
    content: 'console.log(1)',
    sizeBytes: 100,
  };
  assert.equal(shouldSkipBundleForWebcrack(vendorAsset, new Set()).skip, true);
  assert.equal(
    shouldSkipBundleForWebcrack({ ...vendorAsset, url: 'https://example.com/app.js', filePath: '/tmp/app.js', hash: 'h1' }, new Set(['h1'])).skip,
    true,
  );
  assert.equal(
    shouldSkipBundleForWebcrack({ ...vendorAsset, url: 'https://example.com/big.js', filePath: '/tmp/big.js', sizeBytes: 3 * 1024 * 1024 }, new Set()).skip,
    true,
  );

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-test-'));
  try {
    const bundlePath = path.join(tmpDir, 'app.min.js');
    const code = 'function greet(n){return "hi "+n}console.log(greet("world"));';
    await fs.writeFile(bundlePath, code, 'utf8');
    const asset: CollectedAsset = {
      url: 'https://example.com/app.min.js',
      kind: 'js',
      hash: 'h2',
      filePath: bundlePath,
      content: code,
      sizeBytes: Buffer.byteLength(code),
    };
    const summary = await runWebcrackQueue([asset], new Set(), tmpDir);
    assert.equal(summary.filesUnpacked, 1);
    const outFiles = await fs.readdir(path.join(tmpDir, 'client-src', 'unpacked', 'app.min'));
    assert.ok(outFiles.length >= 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
