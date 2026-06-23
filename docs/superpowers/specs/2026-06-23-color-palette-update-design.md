# Design Specification: Color Palette Update

This document describes the color scheme updates for the HubJupyLab website to align with the chosen Color Hunt palette: `000000` (Black), `233d4d` (Deep Blue), `fe7f2d` (Orange), `eaecf0` (Light Gray).

## Proposed Changes

### 1. CSS Variable Mappings (`static/style.css`)
- `--bg-dark`: `#000000`
- `--bg-card`: `rgba(35, 61, 77, 0.5)` (Deep Blue `#233d4d` with opacity)
- `--border-color`: `rgba(234, 236, 240, 0.08)` (Light Gray `#eaecf0` with opacity)
- `--text-primary`: `#eaecf0`
- `--text-secondary`: `rgba(234, 236, 240, 0.6)`
- `--accent-color`: `#fe7f2d`
- `--accent-hover`: `#e66a1a` (Slightly darker orange)

### 2. Radial Gradient Background (`static/style.css`)
- Update body background-image gradients to use the new orange accent and deep blue:
  ```css
  background-image: 
      radial-gradient(circle at 10% 20%, rgba(254, 127, 45, 0.08) 0%, transparent 40%),
      radial-gradient(circle at 90% 80%, rgba(35, 61, 77, 0.2) 0%, transparent 40%);
  ```

### 3. Header Logo Gradient (`static/style.css`)
- Update `.logo-container h1` gradient:
  ```css
  background: linear-gradient(to right, #fe7f2d, #eaecf0);
  ```
