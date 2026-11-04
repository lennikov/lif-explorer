/* @repository-note
   tiff-export.js: Write display TIFF and OME-TIFF preserving 8/16-bit intensities and metadata.
   This note is stripped when building the canonical v2.1 release.
   Module order matters: the runtime uses browser globals.
*/

/* LIF Studio TIFF exporter. No third-party code or runtime dependencies.
 * Classic TIFF 6.0, little-endian, uncompressed single-strip image planes.
 * OME metadata follows the primary OME-TIFF specification and 2016-06 schema:
 * https://docs.openmicroscopy.org/ome-model/6.2.2/ome-tiff/specification.html
 * https://www.openmicroscopy.org/Schemas/OME/2016-06/ome.xsd
 * XYCZT means channel varies first, then Z, then time; one grayscale IFD/plane.
 * Blob fragments prevent a stack-sized contiguous JS buffer. They still retain
 * the complete export, in addition to any decoded source data in the caller.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LifTIFF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
  const CLASSIC_TIFF_MAX_BYTES = 0xffffffff;
  const encoder = new TextEncoder();
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const TYPES = { SHORT: 3, LONG: 4, ASCII: 2, RATIONAL: 5 };
  const SOFTWARE = 'LIF Studio local TIFF exporter';
  const align2 = n => n + (n % 2);

  function positiveInteger(value, name, fallback) {
    const n = value == null && fallback != null ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 0xffffffff) {
      throw new RangeError(name + ' must be a positive integer within classic TIFF limits.');
    }
    return n;
  }
  function positiveNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function textXML(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function ascii(value) {
    const bytes = encoder.encode(String(value) + '\0');
    return bytes;
  }
  function normalizeSpacing(spacing) {
    const source = spacing || {};
    // API defaults are µm and seconds. Unknown explicit units fail closed:
    // retaining the pixels is preferable to writing a false physical scale.
    const lengthFactors = { 'µm': 1, 'μm': 1, um: 1, nm: 0.001, mm: 1000, m: 1000000 };
    const timeFactors = { s: 1, ms: 0.001, 'µs': 0.000001, 'μs': 0.000001, us: 0.000001, min: 60, h: 3600 };
    const lengthUnit = source.unit == null ? 'µm' : String(source.unit);
    const timeUnit = source.timeUnit == null ? 's' : String(source.timeUnit);
    const out = {};
    for (const axis of ['x', 'y', 'z']) {
      const n = positiveNumber(source[axis]);
      const converted = n && Object.prototype.hasOwnProperty.call(lengthFactors, lengthUnit) ? n * lengthFactors[lengthUnit] : null;
      if (converted && Number.isFinite(converted)) out[axis] = converted;
    }
    const t = positiveNumber(source.t);
    const convertedT = t && Object.prototype.hasOwnProperty.call(timeFactors, timeUnit) ? t * timeFactors[timeUnit] : null;
    if (convertedT && Number.isFinite(convertedT)) out.t = convertedT;
    return out;
  }
  function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function omeColor(color) {
    let values;
    if (typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color)) {
      values = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
    } else if (typeof color === 'string' && /^#[a-f0-9]{3}$/i.test(color)) {
      values = Array.from(color.slice(1), c => parseInt(c + c, 16));
    } else if (Array.isArray(color) && color.length >= 3 && color.slice(0, 3).every(Number.isFinite)) {
      const scale = color.slice(0, 3).every(n => n >= 0 && n <= 1) ? 255 : 1;
      values = color.slice(0, 3).map(n => Math.round(Math.max(0, Math.min(255, n * scale))));
    } else if (Number.isInteger(color) && color >= 0 && color <= 0xffffff) {
      values = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
    } else return null;
    return ((values[0] << 24) | (values[1] << 16) | (values[2] << 8) | 255);
  }
  function shape(input) {
    if (!input || typeof input !== 'object') throw new TypeError('A series descriptor is required.');
    const width = positiveInteger(input.width, 'width');
    const height = positiveInteger(input.height, 'height');
    const depth = positiveInteger(input.depth, 'depth', 1);
    const timepoints = positiveInteger(input.timepoints, 'timepoints', 1);
    if (!Array.isArray(input.channels) || input.channels.length < 1) throw new TypeError('At least one channel is required.');
    const channels = input.channels.map((channel, c) => {
      if (!channel || typeof channel !== 'object') throw new TypeError('Channel ' + c + ' requires metadata.');
      const bitDepth = positiveInteger(channel.bitDepth, 'channel bitDepth', 8);
      if (bitDepth > 16) throw new RangeError('Raw TIFF export supports unsigned 8- or 16-bit storage only (including 9–15 significant bits).');
      return { name: channel.name == null ? 'Channel ' + (c + 1) : channel.name, color: channel.color, bitDepth };
    });
    const significantBits = Math.max(...channels.map(c => c.bitDepth));
    const bits = significantBits <= 8 ? 8 : 16;
    const pixelsPerPlane = width * height;
    const planes = depth * timepoints * channels.length;
    const planeBytes = pixelsPerPlane * (bits / 8);
    const rawBytes = planeBytes * planes;
    if (![pixelsPerPlane, planes, planeBytes, rawBytes].every(Number.isSafeInteger)) throw new RangeError('Series dimensions exceed safe TIFF arithmetic.');
    return { width, height, depth, timepoints, channels, significantBits, bits, pixelsPerPlane, planes, planeBytes, rawBytes, spacing: normalizeSpacing(input.spacing), name: input.name || 'LIF series' };
  }
  function omeXML(s) {
    let calibration = '';
    for (const axis of ['x', 'y', 'z']) {
      if (s.spacing[axis]) calibration += ' PhysicalSize' + axis.toUpperCase() + '="' + s.spacing[axis] + '" PhysicalSize' + axis.toUpperCase() + 'Unit="µm"';
    }
    if (s.spacing.t) calibration += ' TimeIncrement="' + s.spacing.t + '" TimeIncrementUnit="s"';
    const channels = s.channels.map((channel, c) => {
      const color = omeColor(channel.color);
      return '<Channel ID="Channel:0:' + c + '" Name="' + textXML(channel.name) + '" SamplesPerPixel="1"' + (color === null ? '' : ' Color="' + color + '"') + '/>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!-- OME-XML metadata: preserve this block to retain dimensions and physical calibration. -->\n' +
      '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openmicroscopy.org/Schemas/OME/2016-06 http://www.openmicroscopy.org/Schemas/OME/2016-06/ome.xsd" Creator="LIF Studio" UUID="urn:uuid:' + uuid() + '">' +
      '<Image ID="Image:0" Name="' + textXML(s.name) + '"><Pixels ID="Pixels:0" DimensionOrder="XYCZT" Type="uint' + s.bits + '" SignificantBits="' + s.significantBits + '" BigEndian="false" Interleaved="false" SizeX="' + s.width + '" SizeY="' + s.height + '" SizeC="' + s.channels.length + '" SizeZ="' + s.depth + '" SizeT="' + s.timepoints + '"' + calibration + '>' +
      channels + '<TiffData IFD="0" PlaneCount="' + s.planes + '"/></Pixels></Image></OME>';
  }
  function rational(value) {
    // Approximate a positive resolution within TIFF's uint32 numerator/denominator.
    const denominator = Math.max(1, Math.min(1000000, Math.floor(0xffffffff / value)));
    const numerator = Math.max(1, Math.min(0xffffffff, Math.round(value * denominator)));
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, numerator, true); view.setUint32(4, denominator, true);
    return bytes;
  }
  function entriesFor(width, height, bits, rgb, description, spacing) {
    const entries = [
      [256, TYPES.LONG, 1, width], [257, TYPES.LONG, 1, height],
      [258, TYPES.SHORT, rgb ? 3 : 1, rgb ? new Uint8Array([8, 0, 8, 0, 8, 0]) : bits],
      [259, TYPES.SHORT, 1, 1], [262, TYPES.SHORT, 1, rgb ? 2 : 1],
      [273, TYPES.LONG, 1, 0], [277, TYPES.SHORT, 1, rgb ? 3 : 1],
      [278, TYPES.LONG, 1, height], [279, TYPES.LONG, 1, 0],
      [305, TYPES.ASCII, SOFTWARE.length + 1, ascii(SOFTWARE)], [339, TYPES.SHORT, 1, 1]
    ];
    if (description != null) {
      const bytes = ascii(description);
      entries.push([270, TYPES.ASCII, bytes.length, bytes]);
    }
    if (rgb) entries.push([284, TYPES.SHORT, 1, 1]);
    if (spacing.x && spacing.y) {
      entries.push([282, TYPES.RATIONAL, 1, rational(10000 / spacing.x)], [283, TYPES.RATIONAL, 1, rational(10000 / spacing.y)], [296, TYPES.SHORT, 1, 3]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    return entries;
  }
  function ifdLength(entries) {
    let length = 2 + entries.length * 12 + 4;
    for (const entry of entries) if (entry[3] instanceof Uint8Array && entry[3].byteLength > 4) length += align2(entry[3].byteLength);
    return length;
  }
  function encodeIFD(entries, offset, stripOffset, stripBytes, next) {
    const bytes = new Uint8Array(ifdLength(entries));
    const view = new DataView(bytes.buffer);
    view.setUint16(0, entries.length, true);
    let external = 2 + entries.length * 12 + 4;
    entries.forEach((entry, i) => {
      const p = 2 + i * 12;
      const [tag, type, count, value] = entry;
      view.setUint16(p, tag, true); view.setUint16(p + 2, type, true); view.setUint32(p + 4, count, true);
      if (tag === 273) view.setUint32(p + 8, stripOffset, true);
      else if (tag === 279) view.setUint32(p + 8, stripBytes, true);
      else if (value instanceof Uint8Array) {
        if (value.byteLength <= 4) bytes.set(value, p + 8);
        else { view.setUint32(p + 8, offset + external, true); bytes.set(value, external); external += align2(value.byteLength); }
      } else if (type === TYPES.SHORT) view.setUint16(p + 8, value, true);
      else view.setUint32(p + 8, value, true);
    });
    view.setUint32(2 + entries.length * 12, next, true);
    return bytes;
  }
  function header() {
    return new Uint8Array([73, 73, 42, 0, 8, 0, 0, 0]);
  }
  function enforceLimit(totalBytes, maxBytes) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes > CLASSIC_TIFF_MAX_BYTES) {
      throw new RangeError('Export exceeds the 4 GiB classic TIFF limit. Export a smaller Z/time/channel subset; BigTIFF streaming is not implemented.');
    }
    const limit = maxBytes == null ? MAX_EXPORT_BYTES : positiveInteger(maxBytes, 'maxBytes');
    if (totalBytes > limit) {
      throw new RangeError('Export would retain ' + Math.ceil(totalBytes / 1048576) + ' MiB of TIFF data, above the ' + Math.floor(limit / 1048576) + ' MiB browser export limit. Export a smaller Z/time/channel subset.');
    }
  }
  function abort(signal) {
    if (signal && signal.aborted) {
      if (typeof DOMException !== 'undefined') throw new DOMException('TIFF export was cancelled.', 'AbortError');
      const error = new Error('TIFF export was cancelled.'); error.name = 'AbortError'; throw error;
    }
  }
  function planSeries(input, options) {
    const s = shape(input);
    // Reject huge page counts before constructing XML or allocating IFD arrays.
    enforceLimit(s.rawBytes + s.planes * 150 + 8, options && options.maxBytes);
    const firstEntries = entriesFor(s.width, s.height, s.bits, false, omeXML(s), s.spacing);
    const nextEntries = entriesFor(s.width, s.height, s.bits, false, null, s.spacing);
    const firstLength = ifdLength(firstEntries);
    const nextLength = ifdLength(nextEntries);
    const dataOffset = 8 + firstLength + nextLength * (s.planes - 1);
    const storedPlaneBytes = align2(s.planeBytes);
    const totalBytes = dataOffset + storedPlaneBytes * s.planes;
    enforceLimit(totalBytes, options && options.maxBytes);
    return { s, firstEntries, nextEntries, firstLength, nextLength, dataOffset, storedPlaneBytes, totalBytes };
  }
  function planeBytes(pixels, s, channel) {
    if (!pixels || typeof pixels.length !== 'number' || pixels.length !== s.pixelsPerPlane) throw new RangeError('A decoded plane has the wrong number of pixels.');
    const channelMax = Math.pow(2, channel.bitDepth) - 1;
    const unsigned8 = pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray;
    const unsigned16 = pixels instanceof Uint16Array;
    // Validate significant-bit metadata and reject signed/float arrays so raw
    // intensity can never silently wrap, clip, or be normalized for export.
    if (!unsigned8 && !unsigned16 && !Array.isArray(pixels)) throw new TypeError('Raw TIFF planes require unsigned Uint8Array/Uint16Array pixels or an array of unsigned integers.');
    for (let i = 0; i < pixels.length; i++) {
      if (!Number.isInteger(pixels[i]) || pixels[i] < 0 || pixels[i] > channelMax) throw new RangeError('A raw pixel falls outside the declared unsigned channel bit depth.');
    }
    if (s.bits === 8) return unsigned8 ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) : Uint8Array.from(pixels);
    if (unsigned16 && littleEndian) return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (littleEndian) return new Uint8Array(Uint16Array.from(pixels).buffer);
    const bytes = new Uint8Array(s.planeBytes), view = new DataView(bytes.buffer);
    for (let i = 0; i < pixels.length; i++) view.setUint16(i * 2, pixels[i], true);
    return bytes;
  }

  /** Returns retained output bytes; source/decoded buffers are additional memory. */
  function estimateSeries(input, options) {
    const p = planSeries(input, options || {});
    return { bytes: p.totalBytes, rawBytes: p.s.rawBytes, planes: p.s.planes, bitDepth: p.s.bits, maxBytes: (options && options.maxBytes) || MAX_EXPORT_BYTES };
  }
  /**
   * Export unaltered source intensities as one local OME-TIFF Blob.
   * spacing: {x,y,z} µm/sample, {t} seconds; optional unit/timeUnit conversion.
   * readPlane({z,t,c}) -> {pixels:Uint8Array|Uint16Array,width,height}.
   * onProgress({completed,total,fraction,z,t,c}); signal: AbortSignal.
   * maxBytes defaults to 512 MiB. No compression/BigTIFF/streaming is applied.
   */
  async function series(input, options) {
    options = options || {};
    abort(options.signal);
    const p = planSeries(input, options), s = p.s;
    if (typeof input.readPlane !== 'function') throw new TypeError('readPlane({z,t,c}) is required.');
    const parts = [header()];
    for (let i = 0; i < s.planes; i++) {
      const offset = i === 0 ? 8 : 8 + p.firstLength + p.nextLength * (i - 1);
      const length = i === 0 ? p.firstLength : p.nextLength;
      parts.push(encodeIFD(i === 0 ? p.firstEntries : p.nextEntries, offset, p.dataOffset + i * p.storedPlaneBytes, s.planeBytes, i + 1 < s.planes ? offset + length : 0));
    }
    let completed = 0;
    for (let t = 0; t < s.timepoints; t++) for (let z = 0; z < s.depth; z++) for (let c = 0; c < s.channels.length; c++) {
      abort(options.signal);
      const plane = await input.readPlane({ z, t, c });
      abort(options.signal);
      if (!plane || Number(plane.width) !== s.width || Number(plane.height) !== s.height) throw new RangeError('Decoded plane dimensions differ from the series.');
      // Each fragment snapshots one plane, allowing a reusable decoder buffer.
      parts.push(new Blob([planeBytes(plane.pixels, s, s.channels[c])]));
      if (s.planeBytes % 2) parts.push(new Uint8Array(1));
      completed++;
      if (typeof options.onProgress === 'function') options.onProgress({ completed, total: s.planes, fraction: completed / s.planes, z, t, c });
      // Give browser input/abort events a turn during long exports.
      if (completed % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    abort(options.signal);
    return new Blob(parts, { type: 'image/tiff' });
  }
  /** Export a rendered presentation frame as RGB8; alpha is discarded. */
  function rgb(rgba, width, height, options) {
    options = options || {};
    width = positiveInteger(width, 'width'); height = positiveInteger(height, 'height');
    const count = width * height;
    if (!Number.isSafeInteger(count) || !rgba || rgba.length !== count * 4) throw new RangeError('RGBA frame dimensions do not match its pixels.');
    if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray)) throw new TypeError('RGB TIFF export requires 8-bit RGBA pixels.');
    const spacing = normalizeSpacing(options.spacing);
    const entries = entriesFor(width, height, 8, true, options.description || 'LIF Studio rendered RGB presentation frame', spacing);
    const metadataLength = ifdLength(entries), byteCount = count * 3;
    const totalBytes = 8 + metadataLength + align2(byteCount);
    enforceLimit(totalBytes, options.maxBytes);
    const pixels = new Uint8Array(byteCount);
    for (let i = 0, j = 0; i < rgba.length; i += 4) { pixels[j++] = rgba[i]; pixels[j++] = rgba[i + 1]; pixels[j++] = rgba[i + 2]; }
    const parts = [header(), encodeIFD(entries, 8, 8 + metadataLength, byteCount, 0), pixels];
    if (byteCount % 2) parts.push(new Uint8Array(1));
    return new Blob(parts, { type: 'image/tiff' });
  }
  return Object.freeze({ series, rgb, estimateSeries, MAX_EXPORT_BYTES, CLASSIC_TIFF_MAX_BYTES });
});

