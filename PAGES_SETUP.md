# GitHub Pages deployment

The public repository now contains a root `index.html` which redirects to `LIF_Studio.html`. The `.nojekyll` file disables Jekyll so the standalone JavaScript remains unmodified.

To activate GitHub Pages:

1. Open https://github.com/lennikov/lif-explorer/settings/pages.
2. Under Build and deployment, select Source **Deploy from a branch**.
3. Select branch **main**, folder **/(root)**, and click **Save**.

Then visit https://lennikov.github.io/lif-explorer/ (direct app: https://lennikov.github.io/lif-explorer/LIF_Studio.html).

This app processes microscopy files locally in the browser. Validate unsupported Leica LIF layouts and quantitative measurements against reference software before scientific use.
