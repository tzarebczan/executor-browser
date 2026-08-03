# Design notes

## Product constraint

Side panel is ~360px. Status must be glanceable: Executor reachability, reverse live, agent tab count.

## Capture

Local JPEG preview only. Soft auto-capture respects Chrome’s capture quota (~1/s). Fails on `chrome://` and when no Executor-group tab exists.

## Historical removals (v0.8)

- Native host (path C) and companion (:9230) UI, permissions, and registration code
- Drive-mode chips that switched between reverse / native / companion

Keep docs honest: reverse-only.
