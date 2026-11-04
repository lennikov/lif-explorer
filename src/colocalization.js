/* @repository-note
   colocalization.js: Calculate native pixel correlations, colocalization and region statistics.
   This note is stripped when building the canonical v2.1 release.
   Module order matters: the runtime uses browser globals.
*/

(function (root) {
  'use strict';

  // Independent implementation of standard intensity correlation and thresholded
  // intensity-fraction metrics. Every operation uses native samples, never LUTs.
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function finiteNonnegative(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(name + ' must be a finite nonnegative number no greater than Number.MAX_SAFE_INTEGER.');
    }
    return value;
  }
  function positiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
      throw new RangeError(name + ' must be a positive integer no greater than ' + max + '.');
    }
    return value;
  }
  function dimensions(width, height) {
    positiveInteger(width, 'width'); positiveInteger(height, 'height');
    if (!Number.isSafeInteger(width * height)) throw new RangeError('Image dimensions are too large.');
  }
  function plane(data, width, height, name) {
    if (!data || typeof data.length !== 'number' || data.length !== width * height) {
      throw new RangeError(name + ' length must equal width × height.');
    }
  }
  function normalizeROI(roi, width, height) {
    dimensions(width, height);
    if (roi == null) return { x: 0, y: 0, width, height };
    const r = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      if (typeof roi[key] !== 'number' || !Number.isFinite(roi[key])) throw new RangeError('ROI ' + key + ' must be finite.');
      r[key] = roi[key];
    }
    // Negative drag widths/heights are normalized; a partial pixel is included.
    const x0 = clamp(Math.floor(Math.min(r.x, r.x + r.width)), 0, width);
    const x1 = r.width === 0 ? x0 : clamp(Math.ceil(Math.max(r.x, r.x + r.width)), 0, width);
    const y0 = clamp(Math.floor(Math.min(r.y, r.y + r.height)), 0, height);
    const y1 = r.height === 0 ? y0 : clamp(Math.ceil(Math.max(r.y, r.y + r.height)), 0, height);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  function moments() { return { n: 0, meanA: 0, meanB: 0, m2A: 0, m2B: 0, cross: 0 }; }
  function addMoment(m, a, b) {
    ++m.n;
    const da = a - m.meanA, db = b - m.meanB;
    m.meanA += da / m.n;
    m.meanB += db / m.n;
    m.m2A += da * (a - m.meanA);
    m.m2B += db * (b - m.meanB);
    m.cross += da * (b - m.meanB);
  }
  function pearson(m) {
    if (m.n < 2 || !(m.m2A > 0) || !(m.m2B > 0)) return null;
    const r = m.cross / Math.sqrt(m.m2A) / Math.sqrt(m.m2B);
    return Number.isFinite(r) ? clamp(r, -1, 1) : null;
  }
  function compensated() { return { sum: 0, error: 0 }; }
  function sumInto(s, value) {
    const y = value - s.error, next = s.sum + y;
    s.error = (next - s.sum) - y; s.sum = next;
  }
  function safeIncrement(counts, index) {
    if (counts[index] >= Number.MAX_SAFE_INTEGER) throw new RangeError('Histogram count exceeds the safe integer capacity.');
    ++counts[index];
  }
  function binIndex(value, bins, maximum) {
    // Integer bins span [0, maximum + 1), so e.g. 256 bins over uint16
    // correspond exactly to [0..255], [256..511], ..., [65280..65535].
    return Math.min(bins - 1, Math.floor(value * (bins / (maximum + 1))));
  }
  function createAccumulator(options = {}) {
    if (!options || typeof options !== 'object') throw new TypeError('Options must be an object.');
    const thresholdA = finiteNonnegative(options.thresholdA ?? 0, 'thresholdA');
    const thresholdB = finiteNonnegative(options.thresholdB ?? 0, 'thresholdB');
    const maxA = finiteNonnegative(options.maxA ?? 65535, 'maxA');
    const maxB = finiteNonnegative(options.maxB ?? 65535, 'maxB');
    const bins = positiveInteger(options.bins ?? 128, 'bins', 2048);
    const excludeDoubleZero = Boolean(options.excludeDoubleZero);
    const raw = moments(), above = moments(), scatterCounts = new Float64Array(bins * bins);
    const sumA = compensated(), sumB = compensated(), jointA = compensated(), jointB = compensated();
    const totalA = compensated(), totalB = compensated(), passingA = compensated(), passingB = compensated();
    let totalPixels = 0, excludedDoubleZeroCount = 0, foregroundA = 0, foregroundB = 0, joint = 0;
    let planes = 0, firstWidth = null, firstHeight = null, firstROI = null, mixedROI = false, clippedCount = 0;
    const api = {
      add(a, b, width, height, addOptions = {}) {
        dimensions(width, height); plane(a, width, height, 'Channel A'); plane(b, width, height, 'Channel B');
        if (!addOptions || typeof addOptions !== 'object') throw new TypeError('Plane options must be an object.');
        if (planes && (width !== firstWidth || height !== firstHeight)) throw new RangeError('All accumulated planes must have matching dimensions.');
        const roi = normalizeROI(own(addOptions, 'roi') ? addOptions.roi : options.roi, width, height);
        // Validate before mutating accumulator state so a bad plane cannot partly
        // contaminate results from previously accumulated valid planes.
        for (let y = roi.y; y < roi.y + roi.height; ++y) {
          for (let x = roi.x; x < roi.x + roi.width; ++x) {
            const i = y * width + x;
            finiteNonnegative(a[i], 'Channel A sample'); finiteNonnegative(b[i], 'Channel B sample');
          }
        }
        if (!Number.isSafeInteger(totalPixels + roi.width * roi.height)) throw new RangeError('Pixel count exceeds the safe integer capacity.');
        if (!planes) { firstWidth = width; firstHeight = height; firstROI = roi; }
        else if (['x', 'y', 'width', 'height'].some(k => firstROI[k] !== roi[k])) mixedROI = true;
        ++planes;
        totalPixels += roi.width * roi.height;
        for (let y = roi.y; y < roi.y + roi.height; ++y) {
          for (let x = roi.x; x < roi.x + roi.width; ++x) {
            const i = y * width + x, av = a[i], bv = b[i];
            const fa = av > thresholdA, fb = bv > thresholdB;
            sumInto(totalA, av); sumInto(totalB, bv);
            if (fb) sumInto(passingA, av);
            if (fa) sumInto(passingB, bv);
            if (fa) { ++foregroundA; sumInto(sumA, av); }
            if (fb) { ++foregroundB; sumInto(sumB, bv); }
            if (fa && fb) { ++joint; sumInto(jointA, av); sumInto(jointB, bv); addMoment(above, av, bv); }
            if (excludeDoubleZero && av === 0 && bv === 0) { ++excludedDoubleZeroCount; continue; }
            addMoment(raw, av, bv);
            if (av > maxA || bv > maxB) ++clippedCount;
            safeIncrement(scatterCounts, binIndex(bv, bins, maxB) * bins + binIndex(av, bins, maxA));
          }
        }
        return api;
      },
      finish() {
        const union = foregroundA + foregroundB - joint;
        const tM1 = totalA.sum > 0 ? clamp(passingA.sum / totalA.sum, 0, 1) : null;
        const tM2 = totalB.sum > 0 ? clamp(passingB.sum / totalB.sum, 0, 1) : null;
        const foregroundM1 = sumA.sum > 0 ? clamp(jointA.sum / sumA.sum, 0, 1) : null;
        const foregroundM2 = sumB.sum > 0 ? clamp(jointB.sum / sumB.sum, 0, 1) : null;
        return {
          totalPixels, count: raw.n, excludedDoubleZeroCount, planes,
          pearson: pearson(raw), pearsonAboveThresholds: pearson(above), thresholdedPearsonCount: above.n,
          m1: tM1, m2: tM2, tM1, tM2, manders: { m1: tM1, m2: tM2, tM1, tM2 },
          foregroundManders: { tM1: foregroundM1, tM2: foregroundM2 },
          foregroundFractions: { a: foregroundM1, b: foregroundM2 },
          foreground: { a: foregroundA, b: foregroundB, joint, union },
          intensities: { aTotal: totalA.sum, bTotal: totalB.sum, aPassingB: passingA.sum, bPassingA: passingB.sum, aForeground: sumA.sum, bForeground: sumB.sum, aJoint: jointA.sum, bJoint: jointB.sum },
          overlapFraction: union ? joint / union : null,
          jointFraction: totalPixels ? joint / totalPixels : null,
          thresholdA, thresholdB, excludeDoubleZero,
          scatter: { counts: scatterCounts.slice(), bins, maxA, maxB, clippedCount },
          roi: mixedROI || !firstROI ? null : { ...firstROI }, mixedROI,
          width: firstWidth, height: firstHeight
        };
      }
    };
    return api;
  }
  function analyze(a, b, width, height, options = {}) {
    return createAccumulator(options).add(a, b, width, height).finish();
  }
  function histogram(data, options = {}) {
    if (!options || typeof options !== 'object') throw new TypeError('Options must be an object.');
    const width = options.width ?? data?.length, height = options.height ?? 1;
    dimensions(width, height); plane(data, width, height, 'Histogram input');
    const roi = normalizeROI(options.roi, width, height);
    const bins = positiveInteger(options.bins ?? 256, 'bins', 65536);
    const maxValue = finiteNonnegative(options.maxValue ?? 65535, 'maxValue');
    const counts = new Float64Array(bins);
    let min = Infinity, max = -Infinity, count = 0, clippedCount = 0;
    for (let y = roi.y; y < roi.y + roi.height; ++y) {
      for (let x = roi.x; x < roi.x + roi.width; ++x) {
        const value = finiteNonnegative(data[y * width + x], 'Histogram sample');
        min = Math.min(min, value); max = Math.max(max, value); ++count;
        if (value > maxValue) ++clippedCount;
        safeIncrement(counts, binIndex(value, bins, maxValue));
      }
    }
    return { counts, bins, maxValue, count, min: count ? min : null, max: count ? max : null, roi, clippedCount };
  }
  function otsu(hist, suppliedMax) {
    const counts = hist?.counts ?? hist, maximum = suppliedMax ?? hist?.maxValue ?? 65535;
    finiteNonnegative(maximum, 'maxValue');
    if (!counts || !Number.isSafeInteger(counts.length) || counts.length < 2) throw new RangeError('Otsu requires at least two histogram bins.');
    let total = 0, weighted = 0, populated = 0;
    for (let i = 0; i < counts.length; ++i) {
      const c = finiteNonnegative(counts[i], 'Histogram count');
      if (c) ++populated;
      total += c; weighted += i * c;
    }
    if (populated < 2) return null;
    let leftCount = 0, leftWeighted = 0, best = -1, firstBest = 0, lastBest = 0;
    for (let i = 0; i < counts.length - 1; ++i) {
      leftCount += counts[i]; leftWeighted += i * counts[i];
      const rightCount = total - leftCount;
      if (!leftCount || !rightCount) continue;
      const delta = leftWeighted / leftCount - (weighted - leftWeighted) / rightCount;
      const score = leftCount * rightCount * delta * delta;
      if (score > best) { best = score; firstBest = lastBest = i; }
      else if (score === best) lastBest = i;
    }
    // Midpoint for tied empty-bin plateaus, mapped to the upper integer value of
    // that threshold bin. Foreground uses value > threshold. Quantization is
    // explicit: use one bin per native value for an exact uint8/uint16 cutoff.
    const index = Math.floor((firstBest + lastBest) / 2);
    return clamp(Math.ceil((index + 1) * ((maximum + 1) / counts.length)) - 1, 0, maximum);
  }
  const api = { analyze, createAccumulator, normalizeROI, histogram, otsu };
  root.LifColoc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

