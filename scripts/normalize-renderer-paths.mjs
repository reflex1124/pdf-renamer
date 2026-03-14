import fs from 'node:fs/promises';
import path from 'node:path';

const rendererDir = path.resolve('dist/renderer');

await rewriteHtmlFiles(rendererDir);

async function rewriteHtmlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteHtmlFiles(fullPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.html')) {
      continue;
    }

    const source = await fs.readFile(fullPath, 'utf8');
    const normalized = source
      .replaceAll('"/./_astro/', '"./_astro/')
      .replaceAll("'/./_astro/", "'./_astro/")
      .replaceAll('"/_astro/', '"./_astro/')
      .replaceAll("'/_astro/", "'./_astro/");

    if (normalized !== source) {
      await fs.writeFile(fullPath, normalized, 'utf8');
    }
  }
}
