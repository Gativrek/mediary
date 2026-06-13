// Renders build/icon.svg into build/icon.ico (multi-size, for the .exe)
// and renderer/icon.png (for the app window). Run: node tools/make-icons.js

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'));
const sizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const pngs = await Promise.all(
    sizes.map((s) => sharp(svg).resize(s, s).png().toBuffer())
  );

  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), ico);

  fs.writeFileSync(
    path.join(__dirname, '..', 'renderer', 'icon.png'),
    pngs[sizes.indexOf(256)]
  );

  console.log('Wrote build/icon.ico and renderer/icon.png');
}

main().catch((err) => { console.error(err); process.exit(1); });
