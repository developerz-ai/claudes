# claudes

`claudes` is a thin TypeScript launcher that runs the Claude Code CLI (`claude`)
against your team's self-hosted, Anthropic-compatible router using your own
per-person key. It never falls back silently: if the wiring is wrong, it fails
loudly instead of quietly sending traffic somewhere else.

**Status: under construction** — this repository is a scaffold; nothing works yet.

> ⚠️ **Never `npm i -g claudes`.** The unscoped name `claudes` belongs to an
> unrelated third-party package. This tool will be published as
> `@developerz.ai/claudes`.
