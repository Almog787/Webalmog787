import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KatanaReconResult } from '../types.js';

const KATANA_TIMEOUT_MS = 45_000;
const MAX_DISCOVERED_LINES = 500;

const STATIC_EXT_REGEX =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf|zip|css|js|mjs|map)$/i;

export function filterKatanaSeedPages(
  urls: string[],
  targetHostname: string,
  maxPages: number,
): string[] {
  const seeds: string[] = [];
  const seen = new Set<string>();

  for (const raw of urls) {
    if (seeds.length >= maxPages) break;
    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      if (parsed.hostname !== targetHostname) continue;
      if (STATIC_EXT_REGEX.test(parsed.pathname)) continue;
      parsed.hash = '';
      const normalized = parsed.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        seeds.push(normalized);
      }
    } catch {
      // Ignore malformed URL line
    }
  }

  return seeds;
}

function runKatanaBinary(
  targetUrl: string,
  maxDepth: number,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const depthArg = String(Math.max(1, Math.min(2, maxDepth)));
    const child = spawn(
      'katana',
      ['-u', targetUrl, '-jc', '-d', depthArg, '-silent', '-nc', '-ct', '30'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 512 * 1024) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: stdout.length > 0, stdout, error: `katana timed out after ${KATANA_TIMEOUT_MS}ms` });
      }
    }, KATANA_TIMEOUT_MS);

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
          ok: code === 0 || stdout.length > 0,
          stdout,
          ...(code !== 0 && stderr.trim() ? { error: stderr.trim() } : {}),
        });
      }
    });
  });
}

export async function runKatanaRecon(
  targetUrl: string,
  maxDepth: number,
  maxPages: number,
  extractedDir: string,
): Promise<KatanaReconResult> {
  const targetHostname = new URL(targetUrl).hostname;
  const warnings: string[] = [];

  const res = await runKatanaBinary(targetUrl, maxDepth);
  if (!res.ok && !res.stdout) {
    if (res.error) {
      console.log(`[Katana] Skipped (${res.error})`);
      warnings.push(`Katana recon unavailable: ${res.error}`);
    }
    return { ran: false, discoveredUrls: [], seedPageUrls: [], warnings };
  }

  const lines = [
    ...new Set(
      res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('http://') || l.startsWith('https://')),
    ),
  ].slice(0, MAX_DISCOVERED_LINES);

  if (lines.length > 0) {
    await fs.writeFile(
      path.join(extractedDir, 'discovered-endpoints.txt'),
      `${lines.join('\n')}\n`,
      'utf8',
    );
  }

  const seedPageUrls = filterKatanaSeedPages(lines, targetHostname, maxPages);
  console.log(
    `[Katana] Discovered ${lines.length} endpoint(s), seeded ${seedPageUrls.length} page URL(s).`,
  );

  if (res.error) {
    warnings.push(res.error);
  }

  return {
    ran: true,
    discoveredUrls: lines,
    seedPageUrls,
    warnings,
  };
}
