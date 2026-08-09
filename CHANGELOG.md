# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-08-09

### Added

- First public npm package release of `pi-subagents-lean` with exactly
  `Agent` and `AgentContinue`; the publicly visible `v0.1`–`v0.3` Git tags
  were internal checkpoints. It provides isolated child sessions, complete
  foreground results, and no background or delivery surface.
- Bundled `architect`, `scout`, `implementer`, `reviewer`, and `verifier`
  roles, with always-on parent orchestration and a live trust-scoped catalog.
- Same-turn independent `Agent` calls under FIFO root concurrency, bounded
  queueing, and retained `AgentContinue` sessions for explicit follow-up
  handoffs.
- Mandatory bounded trust-aware context loading for new sessions, model and
  thinking resolution, user/project/worktree catalogs, selected worktree
  overlays, Skills, and Extensions.
- Supported Pi/provider usage telemetry for tokens, prompt-cache reads and
  writes, cost, context, and compaction details, kept distinct from retained
  child conversation state.
