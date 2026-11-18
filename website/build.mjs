// Assemble the static site using the same artwork as the repository README.
import { copyFile, mkdir } from 'node:fs/promises';

const site = new URL('./', import.meta.url);
const output = new URL('dist/', site);
await mkdir(new URL('assets/', output), { recursive: true });
for (const file of ['index.html', 'download.html', 'site.css', 'keycaps.svg']) {
  await copyFile(new URL(file, site), new URL(file, output));
}
for (const file of ['logo.svg', 'wordmark.svg']) {
  await copyFile(new URL('../docs/assets/' + file, site), new URL('assets/' + file, output));
}
