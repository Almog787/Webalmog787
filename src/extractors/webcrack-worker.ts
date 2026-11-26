import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { runDefaultTransformationRules as WakaruRunRules } from '@wakaru/unminify';
import type { unpack as WakaruUnpack } from '@wakaru/unpacker';
import prettier from 'prettier';
import { webcrack } from 'webcrack';

const require = createRequire(import.meta.url);
const { runDefaultTransformationRules } = require('@wakaru/unminify') as {
  runDefaultTransformationRules: typeof WakaruRunRules;
};
const { unpack: wakaruUnpack } = require('@wakaru/unpacker') as {
  unpack: typeof WakaruUnpack;
};

interface WorkerOutput {
  ok: boolean;
  mode: 'webcrack' | 'wakaru' | 'prettier' | 'failed';
  error?: string;
}

function sendResult(result: WorkerOutput): void {
  if (typeof process.send === 'function') {
    process.send(result);
  }
}

async function tryWakaruUnpackAndUnminify(
  code: string,
  outputDir: string,
): Promise<boolean> {
  try {
    const unpacked = wakaruUnpack(code);
    if (unpacked.modules.length > 1) {
      for (const mod of unpacked.modules) {
        const modName = `module-${String(mod.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.js`;
        let modCode = mod.code;
        try {
          const unminified = await runDefaultTransformationRules({
            path: modName,
            source: modCode,
          });
          if (unminified.code) {
            modCode = unminified.code;
          }
        } catch {
          // Keep raw unpacked module code if unminify fails on an edge syntax
        }
        await fs.writeFile(path.join(outputDir, modName), modCode, 'utf8');
      }
      return true;
    }

    const unminified = await runDefaultTransformationRules({
      path: 'bundle.js',
      source: code,
    });
    if (unminified.code && unminified.code.trim().length > 0) {
      await fs.writeFile(path.join(outputDir, 'unminified.js'), unminified.code, 'utf8');
      return true;
    }
    return false;
  } catch {
    return false;
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

    const moduleCount = result.bundle?.modules.size ?? 0;
    if (moduleCount > 1) {
      await result.save(outputDir);
      sendResult({ ok: true, mode: 'webcrack' });
      process.exit(0);
    }

    // For Vite/Rollup/esbuild/Turbopack bundles where webcrack finds <=1 module, try Wakaru
    const wakaruOk = await tryWakaruUnpackAndUnminify(result.code || code, outputDir);
    if (wakaruOk) {
      sendResult({ ok: true, mode: 'wakaru' });
      process.exit(0);
    }

    await result.save(outputDir);
    const existing = await fs.readdir(outputDir).catch(() => []);
    if (existing.length === 0 && result.code) {
      await fs.writeFile(path.join(outputDir, 'deobfuscated.js'), result.code, 'utf8');
    }
    sendResult({ ok: true, mode: 'webcrack' });
    process.exit(0);
  } catch (err) {
    const wakaruOk = await tryWakaruUnpackAndUnminify(code, outputDir);
    if (wakaruOk) {
      sendResult({ ok: true, mode: 'wakaru' });
      process.exit(0);
    }

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
