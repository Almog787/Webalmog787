import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PlaywrightCrawler,
  ProxyConfiguration,
  Sitemap,
  type PlaywrightCrawlingContext,
  type RequestOptions,
} from 'crawlee';
import { chromium, type CDPSession, type Page } from 'patchright';
import { COMPUTED_STYLE_WHITELIST } from './config.js';
import {
  attachAnimationTracker,
  extractPageAnimations,
  type AnimationTracker,
} from './extractors/animation-extractor.js';
import { NetworkCollector } from './extractors/network-collector.js';
import { normalizeDomSnapshot } from './extractors/snapshot-normalizer.js';
import { probePageStates } from './extractors/state-prober.js';
import { SvgAssetCollector } from './extractors/svg-optimizer.js';
import type {
  CdpCaptureSnapshotResult,
  CrawlConfig,
  ManifestPageEntry,
  OverlaysOutput,
  PageLayoutOutput,
} from './types.js';

const TRACKING_PARAM_EXACT = new Set(['fbclid', 'gclid', 'mc_cid', 'ref']);

export function stripTrackingParams(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_PARAM_EXACT.has(lower)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function urlToSlug(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const trimmedPath = parsed.pathname.replace(/^\/+|\/+$/g, '');
    let base = trimmedPath ? trimmedPath.replace(/[^a-zA-Z0-9/_-]/g, '-').replace(/\//g, '__') : 'index';
    if (base.length > 90) {
      base = base.slice(0, 90);
    }
    if (parsed.search) {
      const queryHash = crypto
        .createHash('sha256')
        .update(parsed.search)
        .digest('hex')
        .slice(0, 8);
      return `${base}--${queryHash}`;
    }
    return base;
  } catch {
    const hash = crypto.createHash('sha256').update(rawUrl).digest('hex').slice(0, 12);
    return `page-${hash}`;
  }
}

export function sanitizeRenderedHtml(html: string): string {
  let cleaned = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<script\b[^>]*\/>/gi, '');

  cleaned = cleaned.replace(
    /data:[^;,\s"')>]+;base64,[A-Za-z0-9+/=]+/gi,
    (match) => (match.length > 256 ? `[base64-omitted:${match.length}-chars]` : match),
  );

  cleaned = cleaned.replace(
    /(<path\b[^>]*?\bd=)(["'])([\s\S]*?)\2/gi,
    (fullMatch, prefix: string, quote: string, dValue: string) => {
      if (dValue.length > 2048) {
        return `${prefix}${quote}[svg-path-truncated:${dValue.length}-chars]${quote}`;
      }
      return fullMatch;
    },
  );

  return cleaned;
}

export interface CrawlRunResult {
  pages: ManifestPageEntry[];
  totalLayoutNodes: number;
  totalOverlays: number;
  totalAnimations: number;
  svgIconsOptimized: number;
  warnings: string[];
  networkCollector: NetworkCollector;
}

interface PageSessionHandles {
  slug: string;
  detachNetwork: () => void;
  cdpClient: CDPSession | null;
  animationTracker: AnimationTracker | null;
}

export async function runCrawlStage(
  config: CrawlConfig,
  extraSeedUrls: string[] = [],
): Promise<CrawlRunResult> {
  process.env.CRAWLEE_STORAGE_DIR = config.storageDir;
  process.env.CRAWLEE_MEMORY_MBYTES ??= '5120';

  const networkCollector = new NetworkCollector(config.extractedDir);
  const svgCollector = new SvgAssetCollector(config.extractedDir);
  const pageEntries: ManifestPageEntry[] = [];
  const usedSlugs = new Set<string>();
  const warnings: string[] = [];

  let totalLayoutNodes = 0;
  let totalOverlays = 0;
  let totalAnimations = 0;
  let pageCounter = 0;

  const sessionMap = new WeakMap<Page, PageSessionHandles>();
  const targetOrigin = new URL(config.targetUrl).origin;
  const targetHostname = new URL(config.targetUrl).hostname;

  const seedUrls = new Set<string>([stripTrackingParams(config.targetUrl)]);
  for (const extra of extraSeedUrls) {
    if (seedUrls.size >= config.maxPages) break;
    try {
      const parsed = new URL(extra);
      if (parsed.hostname === targetHostname) {
        seedUrls.add(stripTrackingParams(parsed.toString()));
      }
    } catch {
      // Ignore invalid seed URL
    }
  }

  console.log(`[Sitemap] Checking ${targetOrigin}/sitemap.xml...`);
  try {
    const sitemap = await Sitemap.load(
      `${targetOrigin}/sitemap.xml`,
      config.proxyUrl,
    );
    for (const sUrl of sitemap.urls) {
      if (seedUrls.size >= config.maxPages) break;
      try {
        const parsed = new URL(sUrl);
        if (parsed.hostname === targetHostname) {
          seedUrls.add(stripTrackingParams(parsed.toString()));
        }
      } catch {
        // Ignore malformed sitemap entry
      }
    }
    console.log(`[Sitemap] Total seeded URLs: ${seedUrls.size} (cap ${config.maxPages}).`);
  } catch (err) {
    console.log(`[Sitemap] No usable sitemap found; seeded ${seedUrls.size} URL(s).`);
    warnings.push(
      `Sitemap discovery skipped (${targetOrigin}/sitemap.xml): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const proxyConfiguration = config.proxyUrl
    ? new ProxyConfiguration({ proxyUrls: [config.proxyUrl] })
    : undefined;

  type CrawleeLauncher = NonNullable<
    ConstructorParameters<typeof PlaywrightCrawler>[0]
  >['launchContext'] extends { launcher?: infer L } | undefined
    ? L
    : never;

  const crawler = new PlaywrightCrawler({
    launchContext: {
      launcher: chromium as unknown as CrawleeLauncher,
      launchOptions:
        config.stealthMode === 'chrome-xvfb'
          ? {
              channel: 'chrome',
              headless: false,
              args: ['--no-sandbox', '--disable-dev-shm-usage'],
            }
          : {
              headless: true,
              args: ['--no-sandbox', '--disable-dev-shm-usage'],
            },
    },
    browserPoolOptions: {
      useFingerprints: false,
      maxOpenPagesPerBrowser: 2,
      retireBrowserAfterPageCount: 10,
    },
    maxConcurrency: 2,
    maxRequestsPerCrawl: config.maxPages,
    maxCrawlDepth: config.maxDepth,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 180,
    ...(proxyConfiguration ? { proxyConfiguration } : {}),

    preNavigationHooks: [
      async ({ page, request }: PlaywrightCrawlingContext, gotoOptions) => {
        if (gotoOptions) {
          gotoOptions.waitUntil = 'domcontentloaded';
          gotoOptions.timeout = 45000;
        }

        let slug = urlToSlug(request.url);
        if (usedSlugs.has(slug)) {
          const suffix = crypto
            .createHash('sha256')
            .update(request.url)
            .digest('hex')
            .slice(0, 6);
          slug = `${slug}-${suffix}`;
        }
        usedSlugs.add(slug);

        console.log(`[Crawl ->] Loading ${request.url} (slug: ${slug})`);

        const detachNetwork = networkCollector.attachToPage(page, () => slug);
        let cdpClient: CDPSession | null = null;
        let animationTracker: AnimationTracker | null = null;
        try {
          const session = await page.context().newCDPSession(page);
          cdpClient = session;
          animationTracker = await attachAnimationTracker(session);
        } catch (err) {
          warnings.push(
            `CDP pre-navigation setup failed for ${request.url}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        sessionMap.set(page, {
          slug,
          detachNetwork,
          cdpClient,
          animationTracker,
        });
      },
    ],

    requestHandler: async ({ page, request, enqueueLinks, response }) => {
      const pageNum = ++pageCounter;
      const startedAt = Date.now();
      const handles = sessionMap.get(page);
      const slug = handles?.slug ?? urlToSlug(request.url);
      let cdpClient = handles?.cdpClient ?? null;
      const animationTracker = handles?.animationTracker ?? null;

      try {
        await page
          .waitForLoadState('networkidle', { timeout: 10000 })
          .catch(() => undefined);

        const enqueued = await enqueueLinks({
          strategy: 'same-hostname',
          transformRequestFunction: (req: RequestOptions) => {
            req.url = stripTrackingParams(req.url);
            return req;
          },
        });

        const finalUrl = page.url();
        const title = await page.title().catch(() => '');
        const status = response?.status() ?? 200;
        console.log(
          `[Page ${pageNum}/${config.maxPages}] Loaded ${finalUrl} (HTTP ${status}, +${enqueued.processedRequests.length} links)`,
        );

        const activeCdpClient: CDPSession =
          cdpClient ?? (await page.context().newCDPSession(page));
        cdpClient = activeCdpClient;

        const desktopViewport = { width: 1440, height: 900 };
        await page.setViewportSize(desktopViewport);
        await page.waitForTimeout(200);

        console.log(`[Page ${pageNum}/${config.maxPages}] Probing scroll, :hover/:focus & overlays...`);
        const probedStates = await probePageStates(page, activeCdpClient, desktopViewport);

        const rawDesktopSnapshot = (await activeCdpClient.send(
          'DOMSnapshot.captureSnapshot',
          {
            computedStyles: [...COMPUTED_STYLE_WHITELIST],
            includeDOMRects: true,
            includePaintOrder: true,
          },
        )) as CdpCaptureSnapshotResult;

        const decodedDesktop = normalizeDomSnapshot(rawDesktopSnapshot, desktopViewport);
        totalLayoutNodes += decodedDesktop.viewportSnapshot.nodeCount;
        const pageOverlaysCount =
          decodedDesktop.overlays.length +
          probedStates.reduce((acc, item) => acc + item.revealedOverlays.length, 0);
        totalOverlays += pageOverlaysCount;

        const svgsAdded = await svgCollector.collectFromPage(page, slug);

        const layoutOutput: PageLayoutOutput = {
          url: finalUrl,
          viewports: {
            desktop: decodedDesktop.viewportSnapshot,
          },
        };

        const overlaysOutput: OverlaysOutput = {
          url: finalUrl,
          initialOverlays: decodedDesktop.overlays,
          interactiveProbedStates: probedStates,
        };

        const fallbackTracker: AnimationTracker = animationTracker ?? {
          getStartedAnimations: () => [],
          dispose: () => undefined,
        };

        await networkCollector.flush();
        const animationsOutput = await extractPageAnimations(
          page,
          finalUrl,
          fallbackTracker,
          networkCollector.getAllAssets('css'),
        );
        const pageAnimCount =
          animationsOutput.cdpStartedAnimations.length +
          animationsOutput.waapiAnimations.length +
          animationsOutput.cssKeyframes.length;
        totalAnimations += pageAnimCount;

        const rawHtml = await page.content();
        const sanitizedHtml = sanitizeRenderedHtml(rawHtml);

        let mobileNodesCount = 0;
        if (config.viewports === 'desktop+mobile') {
          const mobileViewport = { width: 390, height: 844 };
          await page.setViewportSize(mobileViewport);
          await page.waitForTimeout(300);

          const rawMobileSnapshot = (await activeCdpClient.send(
            'DOMSnapshot.captureSnapshot',
            {
              computedStyles: [...COMPUTED_STYLE_WHITELIST],
              includeDOMRects: true,
              includePaintOrder: true,
            },
          )) as CdpCaptureSnapshotResult;

          const decodedMobile = normalizeDomSnapshot(rawMobileSnapshot, mobileViewport);
          layoutOutput.viewports.mobile = decodedMobile.viewportSnapshot;
          mobileNodesCount = decodedMobile.viewportSnapshot.nodeCount;
          totalLayoutNodes += mobileNodesCount;
        }

        await networkCollector.flush();

        const pageDir = path.join(config.extractedDir, 'pages', slug);
        await fs.mkdir(pageDir, { recursive: true });
        const cssRefs = networkCollector.getPageCssRefs(slug);

        await Promise.all([
          fs.writeFile(path.join(pageDir, 'page.html'), sanitizedHtml, 'utf8'),
          fs.writeFile(
            path.join(pageDir, 'layout-tree.json'),
            JSON.stringify(layoutOutput),
            'utf8',
          ),
          fs.writeFile(
            path.join(pageDir, 'overlays.json'),
            JSON.stringify(overlaysOutput),
            'utf8',
          ),
          fs.writeFile(
            path.join(pageDir, 'animations.json'),
            JSON.stringify(animationsOutput),
            'utf8',
          ),
          ...(cssRefs.length > 0
            ? [
                fs.writeFile(
                  path.join(pageDir, 'styles-used.json'),
                  JSON.stringify(cssRefs),
                  'utf8',
                ),
              ]
            : []),
        ]);

        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        const mobileSummary =
          config.viewports === 'desktop+mobile' ? `, mobile=${mobileNodesCount}` : '';
        console.log(
          `[Page ${pageNum}/${config.maxPages}] Saved pages/${slug}/ (desktop=${decodedDesktop.viewportSnapshot.nodeCount}${mobileSummary}, overlays=${pageOverlaysCount}, anims=${pageAnimCount}, +${svgsAdded} svgs) in ${elapsedSec}s`,
        );

        pageEntries.push({
          slug,
          url: finalUrl,
          title,
          status,
        });
      } finally {
        handles?.detachNetwork();
        animationTracker?.dispose();
        if (cdpClient) {
          await cdpClient.detach().catch(() => undefined);
        }
      }
    },

    failedRequestHandler: async ({ request }, err) => {
      warnings.push(
        `Failed request ${request.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  try {
    await crawler.run([...seedUrls]);
  } finally {
    await crawler.teardown();
  }

  await networkCollector.flush();
  const svgIconsOptimized = await svgCollector.writeIndex();

  return {
    pages: pageEntries,
    totalLayoutNodes,
    totalOverlays,
    totalAnimations,
    svgIconsOptimized,
    warnings,
    networkCollector,
  };
}
