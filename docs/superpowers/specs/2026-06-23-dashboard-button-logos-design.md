# Design Specification: Dashboard Button Logos

This document describes the design changes for embedding logos into the JupyterLab and Code Server launcher buttons on the user dashboard.

## Proposed Changes

### 1. Image URLs
- JupyterLab button logo: `https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/jupyter.svg`
- Code Server button logo: `https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg`

### 2. Styling
- Size of logos inside buttons: `18px` by `18px`.
- Use `display: flex; align-items: center; justify-content: center; gap: 0.5rem;` on the parent anchor/button elements to horizontally center-align and spacing-align the logo and text.

### 3. Layout Structure (`templates/dashboard.html` & `templates/partials/_dashboard_status.html`)
- Integrate `<img>` tag inside both local and remote GPU button templates.
