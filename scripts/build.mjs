import * as esbuild from 'esbuild';
import { deflateSync } from 'zlib';
import { mkdirSync, readFileSync, writeFileSync, cpSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

const apiBase =
  process.env.SCF_API_BASE_URL?.replace(/\/$/, '') ||
  'http://localhost:3001/api';

mkdirSync(dist, { recursive: true });

const define = {
  __SCF_API_BASE_URL__: JSON.stringify(apiBase),
};

/** Create a solid-color PNG of the given size (RGBA). */
function createPng(size, rgba = [26, 122, 92, 255]) {
  const [r, g, b, a] = rgba;
  const raw = Buffer.alloc(size * size * 4 + size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const compressed = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      }
    }
    return ~c >>> 0;
  }

  function chunk(type, data) {
    const typeBuf = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4);
    const crc = crc32(Buffer.concat([typeBuf, data]));
    crcBuf.writeUInt32BE(crc);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function copyStatic() {
  const manifest = JSON.parse(
    readFileSync(join(root, 'src', 'manifest.json'), 'utf8')
  );
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const iconsDir = join(dist, 'icons');
  mkdirSync(iconsDir, { recursive: true });
  for (const size of [16, 48, 128]) {
    writeFileSync(join(iconsDir, `icon${size}.png`), createPng(size));
  }

  const sidepanelDist = join(dist, 'sidepanel');
  mkdirSync(sidepanelDist, { recursive: true });
  cpSync(
    join(root, 'src/sidepanel/index.html'),
    join(sidepanelDist, 'index.html')
  );
  cpSync(
    join(root, 'src/sidepanel/sidepanel.css'),
    join(sidepanelDist, 'sidepanel.css')
  );
}

const contentBuild = {
  entryPoints: [join(root, 'src/content/content.ts')],
  bundle: true,
  outfile: join(dist, 'content/content.js'),
  format: 'iife',
  target: ['chrome110'],
  sourcemap: true,
  logLevel: 'info',
  define,
};

const backgroundBuild = {
  entryPoints: [join(root, 'src/background/serviceWorker.ts')],
  bundle: true,
  outfile: join(dist, 'background/serviceWorker.js'),
  format: 'esm',
  target: ['chrome110'],
  sourcemap: true,
  logLevel: 'info',
  define,
};

const sidepanelBuild = {
  entryPoints: [join(root, 'src/sidepanel/sidepanel.ts')],
  bundle: true,
  outfile: join(dist, 'sidepanel/sidepanel.js'),
  format: 'esm',
  target: ['chrome110'],
  sourcemap: true,
  logLevel: 'info',
  define,
};

copyStatic();

async function buildOnce() {
  await Promise.all([
    esbuild.build(contentBuild),
    esbuild.build(backgroundBuild),
    esbuild.build(sidepanelBuild),
  ]);
  copyStatic();
  console.log('[SCF Extension] build complete →', dist);
  console.log('[SCF Extension] API base:', apiBase);
}

if (watch) {
  const ctxContent = await esbuild.context(contentBuild);
  const ctxBg = await esbuild.context(backgroundBuild);
  const ctxSide = await esbuild.context(sidepanelBuild);
  await Promise.all([
    ctxContent.watch(),
    ctxBg.watch(),
    ctxSide.watch(),
  ]);
  console.log('[SCF Extension] watching… load unpacked from:', dist);
} else {
  await buildOnce();
}
