---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use when the user asks Codex to build web components, pages, apps, games, dashboards, or interactive tools.
---

# Frontend Design

Use this skill when building or revising a frontend experience. The goal is working code with a deliberate visual point of view, not a generic page shell.

## Approach

- Start from the user, domain, and workflow. Operational tools should feel dense, legible, and efficient; editorial or playful projects can be more expressive.
- Choose a concrete aesthetic direction before coding: utilitarian, editorial, industrial, refined, playful, brutalist, retro-futuristic, or another context-fit direction.
- Build the actual useful interface as the first screen. Do not make a marketing landing page unless the user explicitly asks for one.
- Match the existing app conventions first when working inside a codebase.

## Visual Standards

- Use strong typography, spacing, and layout decisions that fit the product. Avoid default-feeling combinations such as plain Inter/Roboto layouts with generic purple gradients.
- Prefer real visual assets, generated bitmap images, or full-bleed interactive scenes where visuals matter.
- Keep cards for repeated items, modals, and genuinely framed tools. Do not nest cards or make every section a floating card.
- Use stable dimensions for boards, tiles, counters, icon buttons, and toolbars so hover states and dynamic text do not shift the layout.
- Make text fit cleanly at mobile and desktop sizes. Do not scale font size with viewport width, and keep letter spacing at `0`.

## Interaction Standards

- Use familiar controls: icons in tool buttons, swatches for colors, segmented controls for modes, toggles for binary settings, sliders or steppers for numbers, menus for option sets, and tabs for views.
- Prefer lucide icons when the app already uses them or when adding an icon library is consistent with the project.
- Add useful empty, loading, error, and selected states when the workflow naturally needs them.
- For 3D scenes, use Three.js and verify the canvas is nonblank, framed correctly, and interactive across desktop and mobile.

## Verification

After substantial frontend work, run the app and inspect it through the active browser capability. Capture desktop and mobile screenshots when layout or visual quality matters, and fix visible overlap, blank canvases, missing assets, and text overflow before calling the work done.
