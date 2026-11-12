// Render assets/icon.svg -> assets/icon.ico (PNG-in-ICO, nhiều kích thước) bằng Playwright.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico');

(async () => {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pngs = [];
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  }
  await browser.close();

  // ICO: header(6) + entries(16 each) + PNG data
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + 16 * SIZES.length;
  const entries = SIZES.map((size, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bpp
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  fs.writeFileSync(icoPath, Buffer.concat([header, ...entries, ...pngs]));
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), pngs[pngs.length - 1]);
  console.log(`Wrote ${icoPath}`);
})();
