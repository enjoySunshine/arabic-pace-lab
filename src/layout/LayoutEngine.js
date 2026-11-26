import KernProcessor from './KernProcessor';
import UnicodeLayoutEngine from './UnicodeLayoutEngine';
import GlyphRun from './GlyphRun';
import GlyphPosition from './GlyphPosition';
import * as Script from './Script';
import AATLayoutEngine from '../aat/AATLayoutEngine';
import OTLayoutEngine from '../opentype/OTLayoutEngine';

export default class LayoutEngine {
  constructor(font) {
    this.font = font;
    this.unicodeLayoutEngine = null;
    this.kernProcessor = null;

    // Choose an advanced layout engine. We try the AAT morx table first since more
    // scripts are currently supported because the shaping logic is built into the font.
    if (this.font.morx) {
      this.engine = new AATLayoutEngine(this.font);
    } else if (this.font.GSUB || this.font.GPOS) {
      this.engine = new OTLayoutEngine(this.font);
    }
  }

  layout(string, features, script, language, direction) {
    // Make the features parameter optional
    if (typeof features === 'string') {
      direction = language;
      language = script;
      script = features;
      features = [];
    }

    if (typeof string === 'string') {
      let repeatedRun = this.layoutRepeated(
        string,
        features,
        script,
        language,
        direction,
      );
      if (repeatedRun) {
        return repeatedRun;
      }
    }

    // Map string to glyphs if needed
    if (typeof string === 'string') {
      // Attempt to detect the script from the string if not provided.
      if (script == null) {
        script = Script.forString(string);
      }

      var glyphs = this.font.glyphsForString(string);
    } else {
      // Attempt to detect the script from the glyph code points if not provided.
      if (script == null) {
        let codePoints = [];
        for (let glyph of string) {
          codePoints.push(...glyph.codePoints);
        }

        script = Script.forCodePoints(codePoints);
      }

      var glyphs = string;
    }

    let glyphRun = new GlyphRun(glyphs, features, script, language, direction);

    // Return early if there are no glyphs
    if (glyphs.length === 0) {
      glyphRun.positions = [];
      return glyphRun;
    }

    // Setup the advanced layout engine
    if (this.engine && this.engine.setup) {
      this.engine.setup(glyphRun);
    }

    // Substitute and position the glyphs
    this.substitute(glyphRun);
    this.position(glyphRun);

    this.hideDefaultIgnorables(glyphRun.glyphs, glyphRun.positions);

    // Let the layout engine clean up any state it might have
    if (this.engine && this.engine.cleanup) {
      this.engine.cleanup();
    }

    return glyphRun;
  }

  // Long runs made from one exact repeated unit have a small number of local
  // shaping states: the isolated/opening state, identical interior states, and
  // the opposite endpoint. Shape a few copies once and tile those blocks.
  // Anything whose substitutions or positioning are not demonstrably periodic
  // falls back to the full general layout path.
  layoutRepeated(string, features, script, language, direction) {
    let unitLength = findRepeatedUnitLength(string);
    if (!unitLength) {
      return null;
    }

    let repeatCount = string.length / unitLength;
    let unit = string.slice(0, unitLength);
    let layoutArgs = [features, script, language, direction];

    let isolated = this.layout(unit, ...layoutArgs);
    let blockLength = isolated.glyphs.length;
    if (blockLength === 0) {
      return null;
    }

    const SAMPLE_COUNT = 5;
    let sample = this.layout(unit.repeat(SAMPLE_COUNT), ...layoutArgs);

    if (
      sample.glyphs.length !== SAMPLE_COUNT * blockLength ||
      sample.positions.length !== sample.glyphs.length ||
      (sample.glyphInfos && sample.glyphInfos.length !== sample.glyphs.length)
    ) {
      return null;
    }

    let blocks = [];
    for (let block = 0; block < SAMPLE_COUNT; block++) {
      let start = block * blockLength;
      blocks.push({
        glyphs: sample.glyphs.slice(start, start + blockLength),
        positions: sample.positions.slice(start, start + blockLength),
        infos: sample.glyphInfos
          ? sample.glyphInfos.slice(start, start + blockLength)
          : null,
      });
    }

    // The three middle sample blocks must be identical in every observable
    // shaping result. This rejects long-context or parity effects.
    for (let block = 2; block <= 3; block++) {
      if (
        !sameGlyphBlock(blocks[1], blocks[block]) ||
        !sameInfoBlock(blocks[1].infos, blocks[block].infos)
      ) {
        return null;
      }
    }

    let middle = blocks[1];
    let blockAdvance = (block) =>
      block.positions.reduce((sum, position) => sum + position.xAdvance, 0);

    // Exact total of the normal periodic layout: two endpoint blocks plus
    // repeatCount - 2 copies of the stable interior block.
    let periodicAdvance =
      blockAdvance(blocks[0]) +
      (repeatCount - 2) * blockAdvance(middle) +
      blockAdvance(blocks[4]);

    // The first block exposed to callers is the isolated/opening word. For
    // locally periodic fonts, replacing the first endpoint and using interior
    // blocks changes the total by a small residual; put that residual on one
    // later position so the run's total remains the full layout's total.
    let plannedAdvance =
      isolated.advanceWidth + (repeatCount - 1) * blockAdvance(middle);
    let correction = periodicAdvance - plannedAdvance;

    let glyphs = isolated.glyphs.slice();
    let positions = isolated.positions.map(clonePosition);
    let glyphInfos =
      sample.glyphInfos && isolated.glyphInfos
        ? isolated.glyphInfos.slice()
        : null;

    for (let repeat = 1; repeat < repeatCount; repeat++) {
      for (let i = 0; i < blockLength; i++) {
        glyphs.push(middle.glyphs[i]);

        let source = middle.positions[i];
        let xAdvance = source.xAdvance;
        if (repeat === 1 && i === 0 && correction !== 0) {
          xAdvance += correction;
        }

        positions.push(
          new GlyphPosition(
            xAdvance,
            source.yAdvance,
            source.xOffset,
            source.yOffset,
          ),
        );

        if (glyphInfos && middle.infos) {
          glyphInfos.push(middle.infos[i]);
        }
      }
    }

    let run = new GlyphRun(
      glyphs,
      [],
      sample.script,
      sample.language,
      sample.direction,
    );
    run.positions = positions;
    run.glyphInfos = glyphInfos;
    run.features = { ...sample.features };
    return run;
  }

  substitute(glyphRun) {
    // Call the advanced layout engine to make substitutions
    if (this.engine && this.engine.substitute) {
      this.engine.substitute(glyphRun);
    }
  }

  position(glyphRun) {
    // Get initial glyph positions
    glyphRun.positions = glyphRun.glyphs.map(
      (glyph) => new GlyphPosition(glyph.advanceWidth),
    );
    let positioned = null;

    // Call the advanced layout engine. Returns the features applied.
    if (this.engine && this.engine.position) {
      positioned = this.engine.position(glyphRun);
    }

    // if there is no GPOS table, use unicode properties to position marks.
    if (!positioned && (!this.engine || this.engine.fallbackPosition)) {
      if (!this.unicodeLayoutEngine) {
        this.unicodeLayoutEngine = new UnicodeLayoutEngine(this.font);
      }

      this.unicodeLayoutEngine.positionGlyphs(
        glyphRun.glyphs,
        glyphRun.positions,
        this.engine ? 'ltr' : glyphRun.direction,
      );
    }

    // The advanced layout engines reverse right-to-left glyphs themselves.
    // Without one, reverse them here, before kerning, so that kerning pairs
    // are visual like in HarfBuzz.
    if (!this.engine && glyphRun.direction === 'rtl') {
      glyphRun.glyphs.reverse();
      glyphRun.positions.reverse();
    }

    // if kerning is not supported by GPOS, do kerning with the TrueType/AAT kern table
    if (
      (!positioned || !positioned.kern) &&
      glyphRun.features.kern !== false &&
      this.font.kern
    ) {
      if (!this.kernProcessor) {
        this.kernProcessor = new KernProcessor(this.font);
      }

      this.kernProcessor.process(glyphRun.glyphs, glyphRun.positions);
      glyphRun.features.kern = true;
    }
  }

  hideDefaultIgnorables(glyphs, positions) {
    let space = this.font.glyphForCodePoint(0x20);
    for (let i = 0; i < glyphs.length; i++) {
      let glyph = glyphs[i];
      let codePoint = glyph.codePoints[0];
      // Like HarfBuzz, keep the ones that GSUB substituted, e.g. a soft hyphen
      // replaced by its `case` form:
      if (
        this.isDefaultIgnorable(codePoint) &&
        glyph.id === this.font.glyphForCodePoint(codePoint).id
      ) {
        glyphs[i] = space;
        positions[i].xAdvance = 0;
        positions[i].yAdvance = 0;
      }
    }
  }

  isDefaultIgnorable(ch) {
    // From DerivedCoreProperties.txt in the Unicode database,
    // minus U+115F, U+1160, U+3164 and U+FFA0, which is what
    // Harfbuzz and Uniscribe do.
    let plane = ch >> 16;
    if (plane === 0) {
      // BMP
      switch (ch >> 8) {
        case 0x00:
          return ch === 0x00ad;
        case 0x03:
          return ch === 0x034f;
        case 0x06:
          return ch === 0x061c;
        case 0x17:
          return 0x17b4 <= ch && ch <= 0x17b5;
        case 0x18:
          return 0x180b <= ch && ch <= 0x180e;
        case 0x20:
          return (
            (0x200b <= ch && ch <= 0x200f) ||
            (0x202a <= ch && ch <= 0x202e) ||
            (0x2060 <= ch && ch <= 0x206f)
          );
        case 0xfe:
          return (0xfe00 <= ch && ch <= 0xfe0f) || ch === 0xfeff;
        case 0xff:
          return 0xfff0 <= ch && ch <= 0xfff8;
        default:
          return false;
      }
    } else {
      // Other planes
      switch (plane) {
        case 0x01:
          return (
            (0x1bca0 <= ch && ch <= 0x1bca3) || (0x1d173 <= ch && ch <= 0x1d17a)
          );
        case 0x0e:
          return 0xe0000 <= ch && ch <= 0xe0fff;
        default:
          return false;
      }
    }
  }

  getAvailableFeatures(script, language) {
    let features = [];

    if (this.engine) {
      features.push(...this.engine.getAvailableFeatures(script, language));
    }

    if (this.font.kern && features.indexOf('kern') === -1) {
      features.push('kern');
    }

    return features;
  }

  stringsForGlyph(gid) {
    let result = new Set();

    let codePoints = this.font._cmapProcessor.codePointsForGlyph(gid);
    for (let codePoint of codePoints) {
      result.add(String.fromCodePoint(codePoint));
    }

    if (this.engine && this.engine.stringsForGlyph) {
      for (let string of this.engine.stringsForGlyph(gid)) {
        result.add(string);
      }
    }

    return Array.from(result);
  }
}

function clonePosition(position) {
  return new GlyphPosition(
    position.xAdvance,
    position.yAdvance,
    position.xOffset,
    position.yOffset,
  );
}

function sameGlyphBlock(a, b) {
  if (!b || a.glyphs.length !== b.glyphs.length) {
    return false;
  }

  for (let i = 0; i < a.glyphs.length; i++) {
    if (a.glyphs[i].id !== b.glyphs[i].id) {
      return false;
    }

    let pa = a.positions[i];
    let pb = b.positions[i];
    if (
      pa.xAdvance !== pb.xAdvance ||
      pa.yAdvance !== pb.yAdvance ||
      pa.xOffset !== pb.xOffset ||
      pa.yOffset !== pb.yOffset
    ) {
      return false;
    }
  }

  return true;
}

function sameInfoBlock(a, b) {
  if (!a && !b) {
    return true;
  }

  if (!a || !b || a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) {
      return false;
    }

    let featuresA = Object.keys(a[i].features || {});
    let featuresB = Object.keys(b[i].features || {});
    if (featuresA.length !== featuresB.length) {
      return false;
    }

    for (let feature of featuresA) {
      if (a[i].features[feature] !== b[i].features[feature]) {
        return false;
      }
    }
  }

  return true;
}

// Returns the length of the minimal exact repeating unit for long periodic
// strings, or zero when the string is not worth tiling.
function findRepeatedUnitLength(string) {
  const length = string.length;
  if (length < 512) {
    return 0;
  }

  const prefix = new Int32Array(length);
  for (let i = 1; i < length; i++) {
    let j = prefix[i - 1];
    while (j > 0 && string[i] !== string[j]) {
      j = prefix[j - 1];
    }

    if (string[i] === string[j]) {
      j++;
    }

    prefix[i] = j;
  }

  const unitLength = length - prefix[length - 1];
  const repeatCount = length / unitLength;
  if (
    !Number.isInteger(repeatCount) ||
    repeatCount < 8 ||
    length % unitLength !== 0
  ) {
    return 0;
  }

  return unitLength;
}
