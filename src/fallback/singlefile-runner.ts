import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'patchright';
import type { SingleFileSummary } from '../types.js';

const SINGLEFILE_TIMEOUT_MS = 60_000;

function resolveChromiumExecutable(): string | undefined {
  try {
    const execPath = chromium.executablePath();
    if (execPath && fsSync.existsSync(execPath)) {
      return execPath;
    }
  } catch {
    // Let SingleFile fall back to system browser paths
  }
  return undefined;
}

function runSingleFileCli(
  targetUrl: string,
  outputPath: string,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const execPath = resolveChromiumExecutable();
    const args = [
      'single-file',
      targetUrl,
      outputPath,
      '--browser-arg=--no-sandbox',
      '--browser-arg=--disable-dev-shm-usage',
      ...(execPath ? [`--browser-executable-path=${execPath}`] : []),
    ];
    const child = spawn('npx', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
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
        resolve({ ok: false, stderr: `single-file timed out after ${SINGLEFILE_TIMEOUT_MS}ms` });
      }
    }, SINGLEFILE_TIMEOUT_MS);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, stderr: err.message });
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, stderr });
      }
    });
  });
}

export async function runSingleFileSnapshot(
  targetUrl: string,
  snapshotOutPath?: string,
): Promise<SingleFileSummary> {
  if (!snapshotOutPath) {
    return { saved: false, warnings: [] };
  }

  await fs.mkdir(path.dirname(snapshotOutPath), { recursive: true });
  const res = await runSingleFileCli(targetUrl, snapshotOutPath);

  if (!res.ok) {
    const msg = `SingleFile CLI snapshot skipped: ${res.stderr.trim() || 'non-zero exit'}`;
    console.log(`[SingleFile] ${msg}`);
    return { saved: false, warnings: [msg] };
  }

  try {
    const stat = await fs.stat(snapshotOutPath);
    if (stat.size > 0) {
      console.log(
        `[SingleFile] Saved offline HTML snapshot -> ${snapshotOutPath} (${Math.round(stat.size / 1024)} KB)`,
      );
      return { saved: true, outputPath: snapshotOutPath, warnings: [] };
    }
  } catch {
    // Fall through
  }

  return {
    saved: false,
    warnings: ['SingleFile CLI exited 0 but no snapshot file was created.'],
  };
}
