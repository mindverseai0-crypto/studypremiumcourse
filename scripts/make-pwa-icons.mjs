// One-shot PWA icon generator (sharp) — run: bun scripts/make-pwa-icons.mjs
import sharp from 'sharp';
import { readFileSync } from 'fs';

const SRC = 'public/logo-bison.png';

await sharp(SRC).resize(192, 192).png().toFile('public/pwa-icon-192.png');
await sharp(SRC).resize(512, 512).png().toFile('public/pwa-icon-512.png');

// maskable: logo at ~72% on the app's dark background (safe zone)
const badge = Buffer.from(
  '<svg width="512" height="512"><rect width="512" height="512" rx="96" fill="#111827"/></svg>',
);
const logo500 = await sharp(SRC).resize(500, 500).png().toBuffer();
await sharp(badge)
  .composite([{ input: logo500, gravity: 'center' }])
  .png()
  .toFile('public/pwa-icon-maskable-512.png');

// console.log sizes
for (const f of ['pwa-icon-192.png', 'pwa-icon-512.png', 'pwa-icon-maskable-512.png']) {
  const b = readFileSync(`public/${f}`);
  console.log(f, b.readUInt32BE(16) + 'x' + b.readUInt32BE(20), Math.round(b.length / 1024) + 'KB');
}
