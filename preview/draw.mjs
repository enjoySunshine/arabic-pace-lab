import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { openSync } from '../dist/node/index.js';

const font = openSync(
  new URL('../test/data/amiri/amiri-regular.ttf', import.meta.url),
);

const word = 'السلام';
const paragraph = word.repeat(1500); // 6 code units * 1500 = 9000 characters

const start = performance.now();
const paragraphRun = font.layout(paragraph);
const layoutMs = performance.now() - start;

const wordRun = font.layout(word);
const glyphIds = wordRun.glyphs.map((glyph) => glyph.id);
const advances = wordRun.positions.map((position) => position.xAdvance);
const paragraphAdvance = paragraphRun.advanceWidth;

console.log('word glyph ids:', glyphIds.join(', '));
console.log('word advances:', advances.join(', '));
console.log('word advance:', wordRun.advanceWidth);
console.log(
  `paragraph: ${paragraphRun.glyphs.length} glyphs, advance ${paragraphAdvance}, ${layoutMs.toFixed(1)} ms`,
);

// The preview is intentionally data-driven: changing a substitution in the
// shaping tables changes wordRun/paragraphRun, and therefore both the drawing
// and the captions below. Nothing here hard-codes glyph outlines or widths.
const f2 = (value) => Math.round(value * 100) / 100;
const viewBoxX = -250;
const viewBoxY = -1900;
const viewBoxWidth = 4900;
const viewBoxHeight = 4300;

let penX = 0;
const glyphMarkup = wordRun.glyphs
  .map((glyph, index) => {
    const position = wordRun.positions[index];
    const x = penX + position.xOffset;
    const y = position.yOffset;
    const markup = `
      <path d="${glyph.path.toSVG()}" transform="translate(${f2(x)} ${f2(
        y,
      )})" fill="#202124"/>`;
    penX += position.xAdvance;
    return markup;
  })
  .join('');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="980" height="860" viewBox="${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}"
     data-glyph-ids="${glyphIds.join(' ')}"
     data-advances="${advances.join(' ')}"
     data-word-advance="${wordRun.advanceWidth}"
     data-paragraph-glyphs="${paragraphRun.glyphs.length}"
     data-paragraph-advance="${paragraphAdvance}">
  <rect x="${viewBoxX}" y="${viewBoxY}" width="${viewBoxWidth}" height="${viewBoxHeight}" fill="#fbf8f1"/>
  <text x="0" y="-1680" font-family="sans-serif" font-size="150" font-weight="700" fill="#111827">Amiri Regular — السلام</text>
  <g transform="scale(1,-1)">
    <line x1="0" y1="-1150" x2="0" y2="1550" stroke="#94a3b8" stroke-width="10"/>
    <line x1="${wordRun.advanceWidth}" y1="-1150" x2="${wordRun.advanceWidth}" y2="1550" stroke="#e11d48" stroke-width="12"/>
    <circle cx="${wordRun.advanceWidth}" cy="0" r="34" fill="#e11d48"/>
    ${glyphMarkup}
  </g>
  <text x="0" y="1250" font-family="monospace" font-size="110" fill="#0f766e">glyphs ${glyphIds.join(' · ')}</text>
  <text x="0" y="1520" font-family="monospace" font-size="110" fill="#374151">advances ${advances.join(' + ')} = ${wordRun.advanceWidth}</text>
  <text x="0" y="1790" font-family="monospace" font-size="110" fill="#374151">9000-char column: ${paragraphRun.glyphs.length} glyphs, total ${paragraphAdvance}</text>
</svg>
`;

fs.writeFileSync(new URL('./out.svg', import.meta.url), svg);
console.log('wrote preview/out.svg');
