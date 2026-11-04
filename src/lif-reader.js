/* @repository-note
   lif-reader.js: Read Leica LIF headers and calibrated image planes using Blob.slice on demand.
   This note is stripped when building the canonical v2.1 release.
   Module order matters: the runtime uses browser globals.
*/

/* LIF Studio — browser-local Leica LIF reader, 2026.
 * Independently implemented from public format descriptions and inspected
 * reference implementations. No Bio-Formats/readlif/liffile code is included.
 * Format references:
 * https://github.com/cgohlke/liffile (BSD-3-Clause reference)
 * https://github.com/ome/bioformats/blob/develop/components/formats-gpl/src/loci/formats/in/LIFReader.java
 * https://github.com/Arcadia-Science/readlif
 *
 * API: const p = await LIF.open(file, {onProgress(fraction, detail), signal});
 * p = {name, version, xml, series, warnings, readPlane(index,{z=0,t=0,c=0,signal}),
 *      readPreview(index,{z=0,t=0,c=0,maxWidth=96,maxHeight=96,signal})}
 * series[i] = {name,path,width,height,depth,timepoints,channels,spacing,supported,error}
 * Spacing x/y/z is micrometres per pixel; t is seconds. Unknown values are null.
 * Channel bitDepth preserves nominal resolution (e.g. 12); storageBits is 8/16.
 * readPlane returns {pixels: Uint8Array|Uint16Array,width,height,bitDepth}.
 * readPreview returns the same plus sourceWidth/sourceHeight. maxWidth/maxHeight
 * preserve aspect; optional width/height request exact dimensions clipped to the
 * source. Native nearest samples include both endpoints; a one-pixel dimension
 * samples its centre. Preview reads only sampled rows, with <=1 MiB scratch reads.
 * Native integer values are returned, without display LUTs or normalization.
 * Only the XML/block headers and the requested plane are read using Blob.slice.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LIF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_XML_BYTES = 128 * 1024 * 1024;
  const MAX_PLANE_PIXELS = 64 * 1024 * 1024;
  // Strided reads and previews need only a small scratch buffer. A contiguous
  // readPlane buffer is returned directly as the final native plane allocation.
  const CHUNK_BYTES = 1024 * 1024;
  const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const utf16 = new TextDecoder('utf-16le', {fatal: true});
  class LIFError extends Error {
    constructor(message, code = 'INVALID_LIF') { super(message); this.name = 'LIFError'; this.code = code; }
  }
  function fail(message, code) { throw new LIFError(message, code); }
  function abort(signal) {
    if (signal && (signal.aborted || (typeof signal === 'function' && signal()))) {
      const error = new Error('LIF operation cancelled.'); error.name = 'AbortError'; throw error;
    }
  }
  function safe(n, what) {
    if (!Number.isSafeInteger(n) || n < 0) fail(`${what} exceeds the supported integer range or is negative.`);
    return n;
  }
  function uint(value, what, fallback) {
    if ((value === undefined || value === '') && fallback !== undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) fail(`Invalid ${what}.`);
    return safe(Number(value), what);
  }
  function u64(view, at) {
    const n = view.getUint32(at, true) + view.getUint32(at + 4, true) * 4294967296;
    return safe(n, '64-bit LIF block length');
  }
  function clean(value) { return String(value || '').replace(/\0+$/g, '').trim(); }
  function entities(text) {
    return text.replace(/&([^;]+);/g, (_, name) => {
      if (name === 'amp') return '&'; if (name === 'lt') return '<'; if (name === 'gt') return '>';
      if (name === 'quot') return '"'; if (name === 'apos') return "'";
      let n;
      if (/^#x[0-9a-f]+$/i.test(name)) n = parseInt(name.slice(2), 16);
      else if (/^#\d+$/.test(name)) n = Number(name.slice(1));
      if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
      fail('Unsupported or invalid entity in LIF XML.');
    });
  }
  // Small non-validating XML tree reader. External entities/DTDs are rejected.
  // Unlike regex-only extraction it preserves Element/Memory hierarchy and IDs.
  function parseXML(xml) {
    const doc = {tag: '#document', attrs: {}, children: [], text: ''};
    const stack = [doc]; let pos = 0, nodes = 0;
    while (pos < xml.length) {
      const start = xml.indexOf('<', pos);
      if (start < 0) { stack[stack.length - 1].text += entities(xml.slice(pos)); break; }
      stack[stack.length - 1].text += entities(xml.slice(pos, start));
      if (xml.startsWith('<!--', start)) {
        const end = xml.indexOf('-->', start + 4); if (end < 0) fail('Unclosed XML comment.'); pos = end + 3; continue;
      }
      if (xml.startsWith('<![CDATA[', start)) {
        const end = xml.indexOf(']]>', start + 9); if (end < 0) fail('Unclosed XML CDATA.');
        stack[stack.length - 1].text += xml.slice(start + 9, end); pos = end + 3; continue;
      }
      if (xml.startsWith('<?', start)) {
        const end = xml.indexOf('?>', start + 2); if (end < 0) fail('Unclosed XML declaration.'); pos = end + 2; continue;
      }
      if (xml.startsWith('<!', start)) fail('DTD/entity declarations are unsupported in LIF XML.');
      let end = start + 1, quote = '';
      for (; end < xml.length; end++) {
        const c = xml[end];
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (end >= xml.length) fail('Unclosed XML tag.');
      let body = xml.slice(start + 1, end).trim(); pos = end + 1;
      if (body[0] === '/') {
        const tag = body.slice(1).trim();
        if (stack.length < 2 || stack.pop().tag !== tag) fail('Mismatched LIF XML tags.');
        continue;
      }
      const self = body.endsWith('/'); if (self) body = body.slice(0, -1).trimEnd();
      const match = /^([A-Za-z_][\w.:-]*)/.exec(body); if (!match) fail('Invalid LIF XML tag.');
      const node = {tag: match[1], attrs: Object.create(null), children: [], text: ''};
      let rest = body.slice(match[0].length);
      while (rest.trim()) {
        const attr = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
        if (!attr) fail('Invalid LIF XML attribute.');
        if (Object.hasOwn(node.attrs, attr[1])) fail('Duplicate LIF XML attribute.');
        node.attrs[attr[1]] = entities(attr[2] === undefined ? attr[3] : attr[2]); rest = rest.slice(attr[0].length);
      }
      if (++nodes > 1000000 || stack.length > 256) fail('LIF XML is too complex.');
      stack[stack.length - 1].children.push(node); if (!self) stack.push(node);
    }
    if (stack.length !== 1 || doc.children.length !== 1 || doc.text.trim()) fail('Invalid LIF XML document.');
    return doc.children[0];
  }
  function child(node, tag) { return node && node.children.find(n => n.tag === tag); }
  function children(node, tag) { return node ? node.children.filter(n => n.tag === tag) : []; }
  function at(node, ...tags) { for (const tag of tags) node = child(node, tag); return node; }
  function descendants(node, tag, out = []) {
    if (!node) return out;
    for (const n of node.children) { if (n.tag === tag) out.push(n); descendants(n, tag, out); }
    return out;
  }
  function physical(dim, temporal = false) {
    if (!dim || dim.n < 2) return null;
    const length = Number(dim.node.attrs.Length), unit = clean(dim.node.attrs.Unit).toLowerCase().replace(/μ/g, 'µ');
    if (!Number.isFinite(length) || !length) return null;
    const factors = temporal ? {s: 1, sec: 1, ms: 0.001, us: 1e-6, 'µs': 1e-6, ns: 1e-9, ks: 0.001, min: 60} :
      {m: 1e6, mm: 1000, um: 1, 'µm': 1, nm: 0.001, pm: 1e-6};
    const factor = factors[unit]; return factor ? Math.abs(length) * factor / (dim.n - 1) : null;
  }
  function lutColor(name, i, count) {
    const s = clean(name).toLowerCase();
    const colors = {red:'#ff0000',green:'#00ff00',blue:'#0000ff',cyan:'#00ffff',magenta:'#ff00ff',yellow:'#ffff00',white:'#ffffff',gray:'#ffffff',grey:'#ffffff'};
    for (const key of Object.keys(colors)) if (s === key || s.includes(key)) return colors[key];
    return count === 1 ? '#ffffff' : ['#5b83ff','#3cff73','#ff4040','#ff5ce5','#39e2ff','#ffe45a'][i % 6];
  }
  function seriesDescriptor(element, path, blocks, index) {
    const attrs = element.attrs, image = at(element, 'Data', 'Image');
    const desc = child(image, 'ImageDescription');
    const result = {index, name: clean(attrs.Name) || `Series ${index + 1}`, path: path.join('/'),
      width: 0, height: 0, depth: 1, timepoints: 1, channels: [], spacing: {x:null,y:null,z:null,t:null},
      supported: true, error: null, warnings: [], metadata: {uniqueID: attrs.UniqueID || null}};
    try {
      const memory = child(element, 'Memory');
      const id = clean(memory && memory.attrs.MemoryBlockID); result.memoryBlockID = id;
      if (!id || !blocks.has(id)) fail('Image memory block is missing. The file may be incomplete or use external .lifext data.', 'UNSUPPORTED');
      const block = blocks.get(id), dims = new Map();
      for (const node of children(child(desc, 'Dimensions'), 'DimensionDescription')) {
        const dimID = uint(node.attrs.DimID, 'dimension ID');
        const n = uint(node.attrs.NumberOfElements, 'dimension size'); if (n < 1) fail('Zero-length image dimension.');
        if (dims.has(dimID)) fail(`Duplicate dimension ${dimID}; this scan layout is unsupported.`, 'UNSUPPORTED');
        const stride = uint(node.attrs.BytesInc, 'dimension byte stride', 0);
        if (uint(node.attrs.BitInc, 'dimension bit increment', 0) !== 0) fail('Bit-packed dimensions are unsupported.', 'UNSUPPORTED');
        if ((dimID < 1 || dimID > 4) && n > 1) fail(`Dimension ${dimID} (${n} elements) is unsupported. Tile, spectral and loop data must first be exported in LAS X or Bio-Formats.`, 'UNSUPPORTED');
        if (n > 1 && stride === 0) fail('A multi-element dimension has a zero byte stride.');
        dims.set(dimID, {n, stride, node});
      }
      if (!dims.has(1) || !dims.has(2)) fail('Only XY images and XY Z/T stacks are supported; this is a line/XZ scan.', 'UNSUPPORTED');
      result.width = dims.get(1).n; result.height = dims.get(2).n;
      result.depth = dims.has(3) ? dims.get(3).n : 1; result.timepoints = dims.has(4) ? dims.get(4).n : 1;
      if (safe(result.width * result.height, 'Plane pixel count') > MAX_PLANE_PIXELS) fail('Image planes larger than 64 megapixels are unsupported in this viewer.', 'UNSUPPORTED');
      for (const [key, id] of [['x',1],['y',2],['z',3],['t',4]]) result.spacing[key] = physical(dims.get(id), key === 't');
      const channelNodes = children(child(desc, 'Channels'), 'ChannelDescription');
      if (!channelNodes.length) fail('No channel descriptions found.');
      if (channelNodes.length > 64) fail('More than 64 channels are unsupported.', 'UNSUPPORTED');
      result.channels = channelNodes.map((node, i) => {
        const a = node.attrs, bitDepth = uint(a.Resolution, 'channel resolution');
        if (uint(a.DataType, 'channel data type', 0) !== 0 || bitDepth < 1 || bitDepth > 16) fail('Floating-point, FLIM/lifetime and >16-bit data are unsupported. Export an integer intensity image first.', 'UNSUPPORTED');
        if (uint(a.BitInc, 'channel bit increment', 0) !== 0) fail('Bit-packed channel data are unsupported.', 'UNSUPPORTED');
        const channelTag = uint(a.ChannelTag, 'channel tag', 0);
        if (channelTag !== 0) fail('RGB/sample-channel images are unsupported in this version. Export separate grayscale channels first.', 'UNSUPPORTED');
        const dye = children(node, 'ChannelProperty').find(p => clean(child(p, 'Key')?.text) === 'DyeName');
        const name = clean(child(dye, 'Value')?.text || a.Name || a.NameOfMeasuredQuantity).replace(/^Leica\//, '') || `Channel ${i + 1}`;
        return {name, color: lutColor(a.LUTName, i, channelNodes.length), bitDepth, storageBits: bitDepth <= 8 ? 8 : 16,
          bytesInc: uint(a.BytesInc, 'channel byte offset', 0), lut: a.LUTName || '',
          inverted: a.IsLUTInverted === '1', channelTag, originalIndex: i};
      });
      if (new Set(result.channels.map(c => c.bytesInc)).size !== result.channels.length) fail('Multiple channels have the same byte offset; this channel layout is unsupported.', 'UNSUPPORTED');
      // Prefer explicit dye names in channel metadata; confocal HardwareSetting is a fallback.
      if (result.channels.every(c => /^Channel \d+$/.test(c.name))) {
        const hardware = children(image, 'Attachment').find(n => n.attrs.Name === 'HardwareSetting');
        const bands = descendants(child(hardware, 'ATLConfocalSettingDefinition'), 'MultiBand').filter(n => n.attrs.DyeName);
        if (bands.length === result.channels.length) bands.forEach((n, i) => { result.channels[i].name = clean(n.attrs.DyeName).replace(/^Leica\//, ''); });
      }
      let end = 0;
      for (const d of dims.values()) end = safe(end + (d.n - 1) * d.stride, 'Image data extent');
      const channelExtent = Math.max(...result.channels.map(c => safe(c.bytesInc + c.storageBits / 8, 'Channel data extent')));
      if (safe(end + channelExtent, 'Image data extent') > block.size) fail('Image dimensions/strides extend beyond its memory block. The file is truncated or this layout is unsupported.');
      Object.defineProperty(result, '_layout', {value: {block, dims}});
      if (!result.spacing.x || !result.spacing.y) result.warnings.push('Spatial calibration is missing or has an unknown unit. Set scale manually before measuring.');
    } catch (error) {
      if (!(error instanceof LIFError)) throw error;
      result.supported = false; result.error = error.message;
    }
    return result;
  }
  async function open(blob, options = {}) {
    if (!blob || typeof blob.slice !== 'function' || !Number.isSafeInteger(blob.size)) fail('Choose a local Leica .lif file.');
    const signal = options.signal; abort(signal); let indexing = true;
    const progress = (n, phase) => { if (options.onProgress) options.onProgress(n, {phase}); };
    async function read(offset, length, localSignal) {
      if (indexing) abort(signal); abort(localSignal); safe(offset, 'File offset'); safe(length, 'Read length');
      if (safe(offset + length, 'Read end') > blob.size) fail('Unexpected end of LIF file. The file may be truncated.');
      const buffer = await blob.slice(offset, offset + length).arrayBuffer(); if (indexing) abort(signal); abort(localSignal);
      if (buffer.byteLength !== length) fail('Incomplete LIF file read.'); return buffer;
    }
    progress(0, 'Reading header');
    if (blob.size < 13) fail('File is too short to be a Leica LIF file.');
    const header = new DataView(await read(0, 13));
    if (header.getUint32(0, true) !== 0x70 || header.getUint8(8) !== 0x2a) fail('This is not a Leica LIF file. LOF, XLEF, XLIF and LIFEXT containers are not supported.', 'UNSUPPORTED');
    const xmlBytes = header.getUint32(9, true) * 2;
    if (xmlBytes < 2 || xmlBytes > MAX_XML_BYTES) fail('LIF XML header is empty or larger than the 128 MiB safety limit.');
    let xml;
    try { xml = clean(utf16.decode(await read(13, xmlBytes))).replace(/^\uFEFF/, ''); }
    catch (error) { if (error instanceof LIFError || error.name === 'AbortError') throw error; fail('LIF XML is not valid UTF-16LE.'); }
    const tree = parseXML(xml);
    if (tree.tag !== 'LMSDataContainerHeader') fail('Only standard Leica LIF containers are supported.', 'UNSUPPORTED');
    const version = uint(tree.attrs.Version, 'LIF version');
    if (version !== 1 && version !== 2) fail(`LIF version ${version} is unsupported; versions 1 and 2 are supported.`, 'UNSUPPORTED');
    const blocks = new Map(), warnings = []; let offset = 13 + xmlBytes;
    progress(0.2, 'Indexing image blocks');
    while (offset < blob.size) {
      abort(signal);
      if (blocks.size >= 100000) fail('LIF contains too many memory blocks.');
      const remaining = blob.size - offset;
      if (remaining < 4) {
        const tail = new Uint8Array(await read(offset, remaining));
        if (tail.some(x => x !== 0)) fail('Unexpected trailing bytes after LIF blocks.'); break;
      }
      const magic = new DataView(await read(offset, 4)).getUint32(0, true);
      if (magic === 0 && blocks.size) { warnings.push('Zero-filled trailing allocation after image blocks was ignored.'); break; }
      const headLength = version === 1 ? 18 : 22;
      if (remaining < headLength || magic !== 0x70) fail(`Invalid memory block at byte ${offset}. The file may be truncated.`);
      const h = new DataView(await read(offset, headLength));
      const marker = version === 1 ? 13 : 17;
      if (h.getUint8(8) !== 0x2a || h.getUint8(marker) !== 0x2a) fail('Invalid LIF memory block markers.');
      const size = version === 1 ? h.getUint32(9, true) : u64(h, 9);
      const idBytes = h.getUint32(marker + 1, true) * 2;
      if (idBytes > 2 * 1024 * 1024) fail('LIF memory block identifier is too large.');
      const id = clean(utf16.decode(await read(offset + headLength, idBytes)));
      const dataOffset = safe(offset + headLength + idBytes, 'Block data offset');
      const next = safe(dataOffset + size, 'Block end');
      if (next > blob.size) fail(`Memory block ${id || '(unnamed)'} extends beyond the end of the file.`);
      if (id && blocks.has(id)) fail(`Duplicate LIF memory block identifier: ${id}.`);
      if (id) blocks.set(id, {offset:dataOffset, size, id});
      offset = next; progress(0.2 + 0.6 * offset / blob.size, 'Indexing image blocks');
    }
    const elements = children(tree, 'Element'), series = [];
    function visit(element, parentPath) {
      const path = parentPath.concat(clean(element.attrs.Name) || 'Unnamed');
      if (at(element, 'Data', 'Image')) series.push(seriesDescriptor(element, path, blocks, series.length));
      for (const e of children(child(element, 'Children'), 'Element')) visit(e, path);
    }
    for (const element of elements) visit(element, []);
    if (!series.length) fail('No image series were found in this LIF project.', 'UNSUPPORTED');
    const project = {name: clean(elements[0]?.attrs.Name) || clean(blob.name) || 'Leica project', version, xml, series, warnings};
    function planeLayout(seriesIndex, selection) {
      abort(selection.signal);
      if (!Number.isInteger(seriesIndex) || !series[seriesIndex]) fail('Invalid image series index.');
      const s = series[seriesIndex]; if (!s.supported) fail(s.error, 'UNSUPPORTED');
      const z = selection.z ?? 0, t = selection.t ?? 0, c = selection.c ?? 0;
      for (const [name, value, limit] of [['Z',z,s.depth],['T',t,s.timepoints],['channel',c,s.channels.length]]) {
        if (!Number.isInteger(value) || value < 0 || value >= limit) fail(`${name} index ${value} is outside 0–${limit - 1}.`);
      }
      const channel = s.channels[c], bytes = channel.storageBits / 8, {dims, block} = s._layout;
      const sx = dims.get(1).stride, sy = dims.get(2).stride;
      const base = safe(block.offset + channel.bytesInc + z * (dims.get(3)?.stride || 0) + t * (dims.get(4)?.stride || 0), 'Plane offset');
      return {s, channel, bytes, sx, sy, base};
    }
    // Endpoints are retained for both thumbnails and GPU texture sampling.
    function coordinate(index, count, sourceCount) {
      return count === 1 ? Math.floor((sourceCount - 1) / 2) : Math.round(index * (sourceCount - 1) / (count - 1));
    }
    function runEnd(first, count, sourceCount, stride, capacity) {
      if (!stride) return count;
      const start = coordinate(first, count, sourceCount), limit = Math.floor(capacity / stride);
      let low = first + 1, high = count;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (coordinate(mid - 1, count, sourceCount) - start <= limit) low = mid;
        else high = mid - 1;
      }
      return low;
    }
    async function readGrid(layout, width, height, signal) {
      const {s, channel, bytes, sx, sy, base} = layout;
      const PixelArray = bytes === 1 ? Uint8Array : Uint16Array;
      const output = new PixelArray(width * height);
      const fastX = sx <= sy, fastCount = fastX ? width : height, slowCount = fastX ? height : width;
      const sourceFast = fastX ? s.width : s.height, sourceSlow = fastX ? s.height : s.width;
      const fastStride = fastX ? sx : sy, slowStride = fastX ? sy : sx;
      for (let fastFirst = 0; fastFirst < fastCount;) {
        const fastEnd = runEnd(fastFirst, fastCount, sourceFast, fastStride, CHUNK_BYTES - bytes);
        const firstFast = coordinate(fastFirst, fastCount, sourceFast);
        const fastSpan = safe((coordinate(fastEnd - 1, fastCount, sourceFast) - firstFast) * fastStride + bytes, 'Plane row extent');
        for (let slowFirst = 0; slowFirst < slowCount;) {
          abort(signal);
          // Batching skipped preview rows would read most of the source plane.
          // Consecutive rows can share a buffer; sampled rows are read separately.
          const slowEnd = sourceSlow === slowCount ? runEnd(slowFirst, slowCount, sourceSlow, slowStride, CHUNK_BYTES - fastSpan) : slowFirst + 1;
          const firstSlow = coordinate(slowFirst, slowCount, sourceSlow);
          const length = safe((coordinate(slowEnd - 1, slowCount, sourceSlow) - firstSlow) * slowStride + fastSpan, 'Plane chunk extent');
          const view = new DataView(await read(base + firstFast * fastStride + firstSlow * slowStride, length, signal));
          for (let slow = slowFirst; slow < slowEnd; slow++) {
            const rowOffset = (coordinate(slow, slowCount, sourceSlow) - firstSlow) * slowStride;
            if (fastX && fastCount === sourceFast && fastStride === bytes && (bytes === 1 || LITTLE_ENDIAN && rowOffset % 2 === 0)) {
              output.set(new PixelArray(view.buffer, rowOffset, fastEnd - fastFirst), slow * width + fastFirst);
            } else for (let fast = fastFirst; fast < fastEnd; fast++) {
              const offset = rowOffset + (coordinate(fast, fastCount, sourceFast) - firstFast) * fastStride;
              const value = bytes === 1 ? view.getUint8(offset) : view.getUint16(offset, true);
              output[fastX ? slow * width + fast : fast * width + slow] = value;
            }
          }
          slowFirst = slowEnd;
        }
        fastFirst = fastEnd;
      }
      return {pixels:output, width, height, bitDepth:channel.bitDepth};
    }
    project.readPlane = async function (seriesIndex, selection = {}) {
      const layout = planeLayout(seriesIndex, selection), {s, channel, bytes, sx, sy, base} = layout;
      if ((s.width === 1 || sx === bytes) && (s.height === 1 || sy === s.width * bytes) && (bytes === 1 || LITTLE_ENDIAN)) {
        const buffer = await read(base, s.width * s.height * bytes, selection.signal);
        return {pixels:bytes === 1 ? new Uint8Array(buffer) : new Uint16Array(buffer), width:s.width, height:s.height, bitDepth:channel.bitDepth};
      }
      return readGrid(layout, s.width, s.height, selection.signal);
    };
    project.readPreview = async function (seriesIndex, selection = {}) {
      const layout = planeLayout(seriesIndex, selection), {s} = layout;
      function size(value, name) {
        if (!Number.isSafeInteger(value) || value < 1) fail(`Preview ${name} must be a positive integer.`);
        return value;
      }
      const maxWidth = size(selection.maxWidth ?? 96, 'maxWidth'), maxHeight = size(selection.maxHeight ?? 96, 'maxHeight');
      let width, height;
      if (selection.width !== undefined || selection.height !== undefined) {
        width = Math.min(s.width, size(selection.width ?? maxWidth, 'width'));
        height = Math.min(s.height, size(selection.height ?? maxHeight, 'height'));
      } else {
        const scale = Math.min(1, maxWidth / s.width, maxHeight / s.height);
        width = Math.max(1, Math.floor(s.width * scale)); height = Math.max(1, Math.floor(s.height * scale));
      }
      const result = await readGrid(layout, width, height, selection.signal);
      return {...result, sourceWidth:s.width, sourceHeight:s.height};
    };
    indexing = false; progress(1, 'Ready'); return project;
  }
  return {open, LIFError, version:'1.1.0', limits:{maxPlanePixels:MAX_PLANE_PIXELS,maxXmlBytes:MAX_XML_BYTES,maxScratchBytes:CHUNK_BYTES}};
});

