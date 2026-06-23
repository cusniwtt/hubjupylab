# User UI Button Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Open JupyterLab ↗" button full width, matching the "Launch GPU Session" button on the user dashboard.

**Architecture:** Add `width: 100%` style attribute to the anchor tags.

**Tech Stack:** HTML, CSS.

## Global Constraints
- Apply changes in templates.
- Preserve existing styling features.

---

### Task 1: Update dashboard.html and _dashboard_status.html

**Files:**
- Modify: `templates/dashboard.html`
- Modify: `templates/partials/_dashboard_status.html`

- [ ] **Step 1: Edit templates/dashboard.html**

Change the style of the "Open JupyterLab" button to include `width: 100%;`.
File: [templates/dashboard.html](file:///home/hubjupylab/hubjupylab/templates/dashboard.html)

- [ ] **Step 2: Edit templates/partials/_dashboard_status.html**

Change the style of the "Open JupyterLab" button to include `width: 100%;`.
File: [templates/partials/_dashboard_status.html](file:///home/hubjupylab/hubjupylab/templates/partials/_dashboard_status.html)

- [ ] **Step 3: Verify tests and rendering**

Run: `bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add templates/dashboard.html templates/partials/_dashboard_status.html docs/
git commit -m "style: make Open JupyterLab button full width"
```
