/* @repository-note
   rotation.js: Compute camera orientation and angular animations for 3D.
   This note is stripped when building the canonical v2.1 release.
   Module order matters: the runtime uses browser globals.
*/

(function (root) {
  'use strict';
  const radians = degrees => degrees * Math.PI / 180;
  // Column-major camera-to-world matrices, matching WebGL uniforms.
  function multiply(a, b) {
    const out = new Array(9).fill(0);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++)
      for (let k = 0; k < 3; k++) out[c * 3 + r] += a[k * 3 + r] * b[c * 3 + k];
    return out;
  }
  function axisRotation(axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    if (axis === 'x') return [1,0,0,0,c,s,0,-s,c];
    if (axis === 'y') return [c,0,-s,0,1,0,s,0,c];
    if (axis === 'z') return [c,s,0,-s,c,0,0,0,1];
    throw Error('Unknown rotation axis.');
  }
  function fromAngles(yaw, tilt, roll = 0) {
    return multiply(multiply(axisRotation('z', yaw), axisRotation('x', tilt)), axisRotation('y', roll));
  }
  function toAngles(m) {
    const tilt = Math.asin(Math.max(-1, Math.min(1, m[5])));
    if (Math.abs(Math.cos(tilt)) < 1e-7) return { yaw: Math.atan2(m[1], m[0]), tilt, roll: 0 };
    return { yaw: Math.atan2(-m[3], m[4]), tilt, roll: Math.atan2(-m[2], m[8]) };
  }
  function cycleDuration(options) {
    const extent = options.motion === 'sweep' ? options.angle : 360;
    return extent * (options.motion === 'sweep' ? 2 : 1) / options.speed;
  }
  function rotationAt(base, options, seconds) {
    const extent = options.motion === 'sweep' ? options.angle : 360;
    const travel = Math.max(0, seconds) * options.speed;
    const position = options.motion === 'sweep'
      ? extent - Math.abs((travel % (extent * 2)) - extent)
      : travel % 360;
    const signed = position * (options.direction === 'cw' ? -1 : 1);
    return multiply(axisRotation(options.axis, radians(signed)), base);
  }
  function stereoEyes(base, separationDegrees, swap = false) {
    const half = radians(separationDegrees) / 2;
    const left = multiply(base, axisRotation('y', -half));
    const right = multiply(base, axisRotation('y', half));
    return swap ? { left: right, right: left } : { left, right };
  }
  const api = { radians, multiply, axisRotation, fromAngles, toAngles, cycleDuration, rotationAt, stereoEyes };
  root.StackView = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

