/* @repository-note
   video-export.js: Encode rotated volumes to video when supported by browser codecs.
   This note is stripped when building the canonical v2.1 release.
   Module order matters: the runtime uses browser globals.
*/

(function (root) {
  'use strict';
  async function recordCanvas({ canvas, fps, duration, render, signal, onProgress }) {
    if (!root.MediaRecorder || !canvas.captureStream) throw Error('Video export is unavailable in this browser. Save a frame instead.');
    const formats = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = formats.find(value => root.MediaRecorder.isTypeSupported(value));
    if (!mime) throw Error('This browser has no supported video recorder.');
    if (!(fps > 0 && duration > 0 && Number.isFinite(duration))) throw Error('Invalid video timing.');
    const checkAbort = () => { if (signal?.aborted) throw new DOMException('Video export cancelled.', 'AbortError'); };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    let stream, recorder, complete, recordingError;
    const chunks = [];
    try {
      checkAbort(); render(0);
      stream = canvas.captureStream(fps);
      recorder = new root.MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
      complete = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = resolve;
        recorder.onerror = event => { recordingError = event.error || Error('Video recording failed.'); reject(recordingError); };
      });
      complete.catch(() => {});
      recorder.start();
      const started = performance.now(), interval = 1000 / fps;
      let elapsed = 0;
      while (elapsed < duration) {
        await wait(Math.max(0, interval - (performance.now() - started - elapsed * 1000)));
        checkAbort(); if (recordingError) throw recordingError;
        // Wall-clock timing keeps the chosen angular speed on slower GPUs.
        elapsed = Math.min(duration, (performance.now() - started) / 1000);
        render(elapsed); onProgress?.(elapsed / duration, mime);
      }
      await wait(interval); checkAbort();
      recorder.stop(); await complete;
      if (!chunks.length) throw Error('The browser produced an empty video.');
      const actualMime = recorder.mimeType || mime;
      return { blob: new Blob(chunks, { type: actualMime }), extension: actualMime.startsWith('video/mp4') ? 'mp4' : 'webm' };
    } finally {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stream?.getTracks().forEach(track => track.stop());
    }
  }
  const api = { recordCanvas };
  root.StackVideo = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

