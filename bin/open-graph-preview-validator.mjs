#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOOL_ID, LIMITS, finding, report, validatePreview } from '../src/index.mjs';

const usage = `Usage: ${TOOL_ID} --root DIR --page RELATIVE.html`;
const safeName = name => typeof name === 'string' && name.length > 0 && name.length <= 240 && !isAbsolute(name) && !name.split(/[\\/]/).includes('..') && !/[\u0000-\u001f\u007f-\u009f]/.test(name);
const inside = (root, target) => { const rel = relative(root, target); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
function confined(root, name, maxBytes) {
  const target = realpathSync(resolve(root, name));
  if (!inside(root, target) || !statSync(target).isFile()) throw Error();
  if (statSync(target).size > maxBytes) throw Error('byte-limit');
  const bytes = readFileSync(target);
  if (bytes.length > maxBytes) throw Error('byte-limit');
  return bytes;
}
function pngMetadata(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 10000 || height > 10000) return null;
  return { mime: 'image/png', width, height };
}
export function main(argv, now = Date.now, output = process.stdout, error = process.stderr) {
  if (argv.length === 1 && argv[0] === '--help') { output.write(`${usage}\n`); return 0; }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--root', '--page'].includes(argv[i]) || !argv[i + 1] || Object.hasOwn(args, argv[i])) { error.write(`${usage}\n`); return 2; }
    args[argv[i]] = argv[i + 1];
  }
  if (Object.keys(args).length !== 2 || !safeName(args['--page'])) { error.write(`${usage}\n`); return 2; }
  let root;
  try { root = realpathSync(args['--root']); if (!statSync(root).isDirectory()) throw Error(); }
  catch { error.write('Root must be a readable directory\n'); return 2; }
  const deadline = now() + LIMITS.milliseconds;
  let result;
  try {
    const bytes = confined(root, args['--page'], LIMITS.pageBytes);
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const resolveImage = url => {
      const pathname = decodeURIComponent(url.pathname);
      if (!pathname.startsWith('/') || pathname.split('/').some(part => part === '..' || part === '.' || part.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/.test(part))) throw Error();
      const image = confined(root, `.${pathname}`, LIMITS.imageBytes);
      return pngMetadata(image);
    };
    result = validatePreview(html, resolveImage, { deadline, now });
  } catch (cause) {
    result = report([finding(cause?.message === 'byte-limit' ? 'input-too-large' : 'input-unavailable', '@page', '', 'Page input could not be read or decoded')]);
  }
  output.write(`${JSON.stringify(result)}\n`);
  error.write(`${result.status}: ${result.summary.checked} pages, ${result.findings.length} findings\n`);
  return result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
