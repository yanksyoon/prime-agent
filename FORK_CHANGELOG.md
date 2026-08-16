# Fork changelog

This file tracks changes specific to the `yanksyoon/prime-agent` fork.
Upstream changes remain documented in `packages/coding-agent/CHANGELOG.md`; do not add fork-only entries there.

## Unreleased

- Added local harness memory commands and explicit agent memory capture for persisted sessions.
- Removed the non-functional Graphiti memory controls from the interactive settings menu.

## [0.7.3] - 2026-08-16

- Bundled the timing extension so fork installations load it by default.
- Added a Telegram messaging gateway with BotFather setup, access allowlists, persistent per-chat/topic sessions, status replies, and shared chat commands.
- Added configurable external memory capture settings with explicit capture as the default.
- Added local `graphiti-core` installation to the Prime Agent runtime and kernel bootstrap.
- Included the GitHub Copilot Responses `service_tier` compatibility fix.
