# Dashboard Button Logos Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the JupyterLab logo link and remove launcher button emojis.

**Architecture:** Modify template files directly.

**Tech Stack:** HTML

## Global Constraints
- Jupyter URL target: `https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/jupyter.svg`
- No emoji prefixes on GPU buttons.

---

### Task 1: Update SVG Link and Remove Emojis

**Files:**
- Modify: `templates/dashboard.html`
- Modify: `templates/partials/_dashboard_status.html`

- [ ] **Step 1: Replace png reference and remove emojis in templates**

Update both files.

In `templates/dashboard.html`:
Replace local buttons:
```html
            <!-- Open Buttons -->
            <a href="{{ jupyter_url }}" target="_blank" class="btn btn-primary" style="text-decoration: none; width: 100%; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/jupyter.svg" alt="Jupyter" style="width: 18px; height: 18px;">
                Open JupyterLab ↗
            </a>
```
Replace GPU buttons:
```html
                <a href="{{ gpu_endpoint }}{{ separator }}token={{ user.gpu_token }}" target="_blank" class="btn" style="background: linear-gradient(135deg, #7c3aed, #6366f1); color: white; font-weight: 600; text-decoration: none; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                    <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/jupyter.svg" alt="Jupyter" style="width: 18px; height: 18px; filter: brightness(0) invert(1);">
                    Launch GPU JupyterLab
                </a>
                <a href="{{ gpu_code_server_url }}" target="_blank" class="btn btn-outline" style="border-color: #7c3aed; color: #a78bfa; font-weight: 600; text-decoration: none; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                    <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg" alt="Code Server" style="width: 18px; height: 18px;">
                    Launch GPU Code Server
                </a>
```

In `templates/partials/_dashboard_status.html`:
Replace local buttons:
```html
    <!-- Open Buttons -->
    <a href="{{ jupyter_url }}" target="_blank" class="btn btn-primary" style="text-decoration: none; width: 100%; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
        <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/jupyter.svg" alt="Jupyter" style="width: 18px; height: 18px;">
        Open JupyterLab ↗
    </a>
```
Replace GPU buttons:
```html
        <a href="{{ gpu_endpoint }}{{ separator }}token={{ gpu_token }}" target="_blank" class="btn" style="background: linear-gradient(135deg, #7c3aed, #6366f1); color: white; font-weight: 600; text-decoration: none; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/jupyter.svg" alt="Jupyter" style="width: 18px; height: 18px; filter: brightness(0) invert(1);">
            Launch GPU JupyterLab
        </a>
        <a href="{{ gpu_code_server_url }}" target="_blank" class="btn btn-outline" style="border-color: #7c3aed; color: #a78bfa; font-weight: 600; text-decoration: none; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg" alt="Code Server" style="width: 18px; height: 18px;">
            Launch GPU Code Server
        </a>
```

- [ ] **Step 2: Run test suite to verify no regressions**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add templates/dashboard.html templates/partials/_dashboard_status.html
git commit -m "fix: update JupyterLab logo URL to SVG and remove emojis from RunPod buttons"
```
