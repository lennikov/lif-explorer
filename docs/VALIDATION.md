# Scientific validation and QA

## Reproducibility
Run `python scripts/build.py --check` and `python -m unittest discover -s tests -v`. These check the exact archived release and offline packaging; they are not an independent scientific calibration study.

## Required checks on representative acquisitions
1. Check each supported LIF series and the number/order of channels, Z planes and timepoints against LAS X.
2. Compare native 8/16-bit pixel intensities and acquisition metadata against a reference reader.
3. Check physical X/Y/Z spacing and manually provided calibration.
4. Verify OME-TIFF dimensions and raw pixel values after round-trip import.
5. Compare ROI and colocalization outputs on known synthetic reference volumes.
6. Test Chrome versions, large files, memory-limited Macs and export video codecs separately.

Unsupported or partially supported layouts (such as FLIM and packed data) must not silently enter quantitative analysis. No clinical diagnostic validation is asserted.
