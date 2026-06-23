# Color Palette Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the chosen Color Hunt palette to the entire HubJupyLab application stylesheet.

**Architecture:** Modify root CSS variables and specific logo/background gradient declarations.

**Tech Stack:** CSS

## Global Constraints
- Target palette colors: `#000000`, `#233d4d`, `#fe7f2d`, `#eaecf0`.

---

### Task 1: Update CSS Variables and Gradients

**Files:**
- Modify: `static/style.css:3-16,31-34,59-61`

- [ ] **Step 1: Replace variables and background gradient**

Modify the `:root` variables, body gradients, and logo text gradients in `static/style.css`.

Update variables:
```css
:root {
    --bg-dark: #000000;
    --bg-card: rgba(35, 61, 77, 0.5);
    --border-color: rgba(234, 236, 240, 0.08);
    --text-primary: #eaecf0;
    --text-secondary: rgba(234, 236, 240, 0.6);
    --accent-color: #fe7f2d;
    --accent-hover: #e66a1a;
    --danger-color: #ef4444;
    --danger-hover: #dc2626;
    --success-color: #10b981;
    --success-bg: rgba(16, 185, 129, 0.1);
    --error-bg: rgba(239, 68, 68, 0.1);
}
```

Update body gradient:
```css
    background-image: 
        radial-gradient(circle at 10% 20%, rgba(254, 127, 45, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(35, 61, 77, 0.2) 0%, transparent 40%);
```

Update logo text gradient:
```css
    background: linear-gradient(to right, #fe7f2d, #eaecf0);
```

- [ ] **Step 2: Run test suite to verify no regressions**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "feat: apply chosen Color Hunt palette to style.css"
```
