import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DembrandtSummary } from '../types.js';

const DEMBRANDT_TIMEOUT_MS = 90_000;

async function listFilesRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function runDembrandtProcess(targetUrl: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      [
        'dembrandt',
        targetUrl,
        '--no-sandbox',
        '--save-output',
        '--design-md',
        '--dtcg',
        '--slow',
        '--tailwind',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

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
        resolve({ code: null, stderr: `dembrandt timed out after ${DEMBRANDT_TIMEOUT_MS}ms` });
      }
    }, DEMBRANDT_TIMEOUT_MS);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stderr: err.message });
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stderr });
      }
    });
  });
}

export async function runDembrandt(
  targetUrl: string,
  extractedDir: string,
): Promise<DembrandtSummary> {
  const designSystemDir = path.resolve(extractedDir, 'design-system');
  await fs.mkdir(designSystemDir, { recursive: true });
  const warnings: string[] = [];

  const outputDir = path.resolve('output');
  await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);

  const procResult = await runDembrandtProcess(targetUrl);
  if (procResult.code !== 0) {
    warnings.push(
      `Dembrandt exited with status ${String(procResult.code)}: ${procResult.stderr.trim() || 'no stderr'}`,
    );
  }

  const allGenerated = await listFilesRecursive(outputDir);
  if (allGenerated.length === 0) {
    return { extracted: false, warnings };
  }

  let copiedCount = 0;

  for (const filePath of allGenerated) {
    const fileName = path.basename(filePath);
    const lower = fileName.toLowerCase();

    if (lower === 'design.md') {
      await fs.copyFile(filePath, path.join(designSystemDir, 'DESIGN.md'));
      copiedCount++;
    } else if (lower.endsWith('.tokens.json') || lower.endsWith('.dtcg.json')) {
      await fs.copyFile(filePath, path.join(designSystemDir, 'tokens.dtcg.json'));
      copiedCount++;
    } else if (lower === 'theme.css' || lower.includes('tailwind') && lower.endsWith('.css')) {
      await fs.copyFile(filePath, path.join(designSystemDir, 'theme.tailwind.css'));
      copiedCount++;
    } else if (lower.endsWith('.json') && !lower.endsWith('.tokens.json')) {
      await fs.copyFile(filePath, path.join(designSystemDir, 'dembrandt-summary.json'));
      copiedCount++;
    }
  }

  return {
    extracted: copiedCount > 0,
    warnings,
  };
}
