# LIF Explorer — LIF Studio v2.1

**Offline Leica LIF microscopy explorer from Lennikov Lab.** A single-page, browser-local viewer that opens microscopy data without uploading specimens or acquisition images.

## Latest recovered stable snapshot
**v2.1 — October 14, 2026.** Open [LIF_Studio.html](LIF_Studio.html) in a modern desktop Chrome browser. An identical copy is retained at [releases/v2.1/LIF_Studio.html](releases/v2.1/LIF_Studio.html).

### Key features
- Browse Leica LAS AF/LAS X conventional uncompressed 8/16-bit LIF series, channels, Z planes and timepoints.
- View slices, maximum-intensity projections, orthogonal sections and interactive 3D, including red–cyan stereo.
- Adjust channels, intensity ranges, gamma and histograms; preserve raw intensities for quantitative analysis.
- Inspect calibration and measure distances; export PNG/JPG/TIFF, raw OME-TIFF, CSV and JSON.
- Analyze colocalization with Pearson correlation, Manders coefficients, raw thresholds, ROI and full Z stacks.
- Use synthetic demonstrations, preview memory controls and browser-local processing.

## Annotated source
The source is split without changing its released behavior:
- `src/lif-reader.js` — binary format, metadata and pixel reads.
- `src/tiff-export.js` — image and OME-TIFF export.
- `src/image-display.js`, `src/style.css` — channel LUTs and display styling.
- `src/memory.js` — browser preview memory budgets.
- `src/colocalization.js` — native-intensity scientific metrics.
- `src/rotation.js`, `src/video-export.js` — 3D view controls and video output.
- `src/app.js` — UI and workflow orchestration.
- `src/template.html`, `scripts/build.py` — exact single-file distribution rebuild.

The top-of-file `@repository-note` annotations are removed by the build script. `tests/test_build.py` verifies byte-identical rebuilding.

```bash
python scripts/build.py --check
python -m unittest discover -s tests -v
```

## Scientific validation and limitations
Supported data: conventional uncompressed 8/16-bit LIF. Proprietary FLIM, packed storage and specialized acquisition modes are not guaranteed. Calibration reflects metadata when supplied. **Verify dimensions, measured intensities and exports against Leica LAS X or Bio-Formats before publication.** This is research software, not a medical diagnostic tool. Independent software, not affiliated with Leica Microsystems. No open-source license is granted automatically.
