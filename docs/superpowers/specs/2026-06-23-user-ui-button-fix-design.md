# Design Specification: User JupyterLab Button UI Fix

This specification outlines the UI adjustment to align the width of the "Open JupyterLab" button on the user dashboard page with the "Launch GPU Session" button.

## Proposed Changes
1. Modify [templates/dashboard.html](file:///home/hubjupylab/hubjupylab/templates/dashboard.html) (line 34) and [templates/partials/_dashboard_status.html](file:///home/hubjupylab/hubjupylab/templates/partials/_dashboard_status.html) (line 27).
2. Set the `width` property to `100%` on the "Open JupyterLab ↗" button style attribute.

---

## Verifiability
We will verify that:
1. The templates render cleanly.
2. The user dashboard shows the button at full width.
