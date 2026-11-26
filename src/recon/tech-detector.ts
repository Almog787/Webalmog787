import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TechStackResult } from '../types.js';

const WAPPALYZER_TIMEOUT_MS = 25_000;

interface TechRule {
  name: string;
  categories: string[];
  headerPattern?: RegExp;
  htmlPattern?: RegExp;
}

const FALLBACK_RULES: TechRule[] = [
  { name: 'Next.js', categories: ['Web frameworks'], htmlPattern: /__NEXT_DATA__|\/_next\/static\//i, headerPattern: /x-powered-by:\s*next\.js/i },
  { name: 'Nuxt.js', categories: ['Web frameworks'], htmlPattern: /__NUXT__|\/_nuxt\//i },
  { name: 'React', categories: ['JavaScript frameworks'], htmlPattern: /data-reactroot|react-dom/i },
  { name: 'Vue.js', categories: ['JavaScript frameworks'], htmlPattern: /data-v-[a-f0-9]+|__vue__/i },
  { name: 'Astro', categories: ['Static site generators'], htmlPattern: /astro-island|\/_astro\//i },
  { name: 'WordPress', categories: ['CMS'], htmlPattern: /wp-content\/|wp-includes\//i, headerPattern: /x-pingback:.*xmlrpc\.php/i },
  { name: 'Elementor', categories: ['Page builders'], htmlPattern: /elementor-widget|elementor-section|\/wp-content\/plugins\/elementor/i },
  { name: 'WooCommerce', categories: ['Ecommerce'], htmlPattern: /woocommerce|wc-block/i },
  { name: 'Shopify', categories: ['Ecommerce'], htmlPattern: /cdn\.shopify\.com|Shopify\.theme/i },
  { name: 'Webflow', categories: ['CMS'], htmlPattern: /w-webflow-badge|data-wf-site/i },
  { name: 'Tailwind CSS', categories: ['UI frameworks'], htmlPattern: /--tw-border-spacing|--tw-translate-/i },
  { name: 'GSAP', categories: ['Animation'], htmlPattern: /gsap(\.min)?\.js|ScrollTrigger/i },
  { name: 'Swiper', categories: ['JavaScript libraries'], htmlPattern: /swiper-wrapper|swiper-slide/i },
  { name: 'Lottie', categories: ['Animation'], htmlPattern: /lottie-player|bodymovin/i },
  { name: 'Cloudflare', categories: ['CDN'], headerPattern: /server:\s*cloudflare|cf-ray:/i },
];

export function detectTechFallbackFromResponse(
  targetUrl: string,
  headersText: string,
  htmlText: string,
): TechStackResult['technologies'] {
  const detected: TechStackResult['technologies'] = [];
  for (const rule of FALLBACK_RULES) {
    const matchedHeader = rule.headerPattern ? rule.headerPattern.test(headersText) : false;
    const matchedHtml = rule.htmlPattern ? rule.htmlPattern.test(htmlText) : false;
    if (matchedHeader || matchedHtml) {
      detected.push({
        name: rule.name,
        categories: rule.categories,
      });
    }
  }
  if (detected.length === 0 && targetUrl.startsWith('https://')) {
    // Keep result cleanly empty if no signatures matched
    return [];
  }
  return detected;
}

function runWappalyzerCli(
  targetUrl: string,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('wappalyzer-cli', ['--target', targetUrl, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, stdout: '', error: `wappalyzer-cli timed out after ${WAPPALYZER_TIMEOUT_MS}ms` });
      }
    }, WAPPALYZER_TIMEOUT_MS);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, stdout: '', error: err.message });
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: code === 0 && stdout.trim().length > 0,
          stdout,
          ...(code !== 0 && stderr.trim() ? { error: stderr.trim() } : {}),
        });
      }
    });
  });
}

function parseWappalyzerJson(rawJson: string): TechStackResult['technologies'] {
  const parsed = JSON.parse(rawJson) as unknown;
  const results: TechStackResult['technologies'] = [];

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.technologies)) {
      for (const item of obj.technologies) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          const name = typeof rec.name === 'string' ? rec.name : '';
          if (!name) continue;
          const categories = Array.isArray(rec.categories)
            ? rec.categories.filter((c): c is string => typeof c === 'string')
            : [];
          const version = typeof rec.version === 'string' && rec.version ? rec.version : undefined;
          results.push({ name, categories, ...(version ? { version } : {}) });
        }
      }
      return results;
    }

    // Handle map format { "WordPress": { ... } } or { "WordPress": ["CMS"] }
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'url' || key === 'target') continue;
      if (Array.isArray(val)) {
        results.push({
          name: key,
          categories: val.filter((v): v is string => typeof v === 'string'),
        });
      } else if (val && typeof val === 'object') {
        const rec = val as Record<string, unknown>;
        const categories = Array.isArray(rec.categories)
          ? rec.categories.filter((v): v is string => typeof v === 'string')
          : [];
        results.push({ name: key, categories });
      } else {
        results.push({ name: key, categories: [] });
      }
    }
  }

  return results;
}

export async function runTechDetector(
  targetUrl: string,
  extractedDir: string,
): Promise<TechStackResult> {
  const warnings: string[] = [];
  let technologies: TechStackResult['technologies'] = [];
  let detector: TechStackResult['detector'] = 'wappalyzergo';

  const cliRes = await runWappalyzerCli(targetUrl);
  if (cliRes.ok) {
    try {
      technologies = parseWappalyzerJson(cliRes.stdout);
    } catch (err) {
      warnings.push(
        `Failed to parse wappalyzer-cli JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (technologies.length === 0) {
    detector = 'builtin-fallback';
    if (cliRes.error) {
      warnings.push(`wappalyzergo CLI fallback used (${cliRes.error})`);
    }
    try {
      const response = await fetch(targetUrl, {
        signal: AbortSignal.timeout(15000),
      });
      const headersLines: string[] = [];
      response.headers.forEach((value, key) => {
        headersLines.push(`${key}: ${value}`);
      });
      const html = await response.text();
      technologies = detectTechFallbackFromResponse(
        targetUrl,
        headersLines.join('\n'),
        html,
      );
    } catch (err) {
      warnings.push(
        `Fallback tech fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const output: TechStackResult = {
    targetUrl,
    detector,
    technologies,
    warnings,
  };

  await fs.writeFile(
    path.join(extractedDir, 'tech-stack.json'),
    JSON.stringify(output, null, 2),
    'utf8',
  );

  console.log(
    `[TechStack] Detected ${technologies.length} technology signature(s) via ${detector}.`,
  );

  return output;
}
