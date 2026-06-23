# Design Specification: Dashboard Button Logos Fix

This document describes layout adjustments to fix the JupyterLab button logo URL and remove emojis from remote GPU buttons.

## Proposed Changes

### 1. Logo URL Adjustment
- Update JupyterLab logo URL from `https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/jupyter.svg` to `https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/jupyter.svg`.

### 2. Emoji Removal
- Remove emoji `🚀` and `💻` prefixes from RunPod GPU launcher buttons:
  - "Launch GPU JupyterLab"
  - "Launch GPU Code Server"
