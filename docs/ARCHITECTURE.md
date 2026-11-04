# Architecture: LIF Studio

The published HTML contains all its CSS and JavaScript inline to support local/offline microscopy analysis. The maintainable repository source is split into the eight original script blocks, in their original execution order, plus CSS and the HTML shell.

| Component | Responsibility |
| --- | --- |
| `src/lif-reader.js` | Leica LAS AF/LAS X LIF headers, channel/series metadata, on-demand planes, native 8/16-bit intensity reads |
| `src/tiff-export.js` | Display and raw image TIFF/OME-TIFF writing |
| `src/image-display.js` | Channel look-up tables, colors and display math |
| `src/memory.js` | Preview sampling, caching and browser memory budgets |
| `src/colocalization.js` | Pearson and Manders calculations using raw intensities and ROI/threshold selections |
| `src/rotation.js` | 3D orientation, autorotation and camera movement |
| `src/video-export.js` | Browser capture and video format negotiation |
| `src/app.js` | File selection, view states, controls and exports |
| `src/template.html` | Original application shell and module placeholders |
| `scripts/build.py` | Assembles exact canonical standalone HTML |

**Reproducibility:** The script bodies and styles are extracted unchanged; explanatory source annotations are stripped before assembly. The resulting HTML is identical to the October 14 v2.1 snapshot. No minifier, framework build or network dependency is needed.

**Scientific boundary:** Display gamma/LUTs do not modify source pixels; validate raw analysis and calibration with independent microscopy software.
