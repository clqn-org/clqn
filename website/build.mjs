// Assemble the static site using the same artwork as the repository README.
import { copyFile, mkdir } from 'node:fs/promises';
import { buildDocs } from './build-docs.mjs';

const site = new URL('./', import.meta.url);
const output = new URL('dist/', site);
await mkdir(new URL('assets/', output), { recursive: true });
for (const file of ['index.html', 'download.html', 'site.css', 'groundhogs.svg', 'groundhogs-still.svg']) {
  await copyFile(new URL(file, site), new URL(file, output));
}
for (const file of ['logo.svg', 'wordmark.svg']) {
  await copyFile(new URL(`../docs/assets/${file}`, site), new URL(`assets/${file}`, output));
}
await buildDocs(new URL('../docs/', site), new URL('docs/', output));
