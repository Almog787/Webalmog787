import fs from 'node:fs/promises';
import path from 'node:path';
import prettier from 'prettier';
import { webcrack } from 'webcrack';

interface WorkerInput {
  inputFile: string;
  outputDir: string;
}

interface WorkerOutput {
  ok: boolean;
  mode: 'webcrack' | 'prettier' | 'failed';
  error?: string;
}

function sendResult(result: WorkerOutput): void {
  if (typeof process.send === 'function') {
    process.send(result);
  }
}

async function run(): Promise<void> {
  const inputFile = process.argv[2];
  const outputDir = process.argv[3];

  if (!inputFile || !outputDir) {
    sendResult({ ok: false, mode: 'failed', error: 'Missing inputFile or outputDir arguments.' });
    process.exit(1);
  }

  const code = await fs.readFile(inputFile, 'utf8');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const result = await webcrack(code, {
      unpack: true,
      deobfuscate: true,
      unminify: true,
      jsx: true,
    });
    await result.save(outputDir);
    const savedIndex = path.join(outputDir, 'deobfuscated.js');
    const existing = await fs.readdir(outputDir).catch(() => []);
    if (existing.length === 0 && result.code) {
      await fs.writeFile(savedIndex, result.code, 'utf8');
    }
    sendResult({ ok: true, mode: 'webcrack' });
    process.exit(0);
  } catch (err) {
    // Deterministic Prettier fallback inside worker
    try {
      const formatted = await prettier.format(code, {
        parser: 'babel',
        semi: true,
        singleQuote: true,
      });
      await fs.writeFile(path.join(outputDir, 'formatted.js'), formatted, 'utf8');
      sendResult({
        ok: true,
        mode: 'prettier',
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(0);
    } catch (prettierErr) {
      sendResult({
        ok: false,
        mode: 'failed',
        error: prettierErr instanceof Error ? prettierErr.message : String(prettierErr),
      });
      process.exit(1);
    }
  }
}

void run().catch((err) => {
  sendResult({
    ok: false,
    mode: 'failed',
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
