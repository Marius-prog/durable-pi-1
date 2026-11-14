# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Durable Pi: agents built on `@earendil-works/pi-durable` that live on a device and commit every step to SQLite, so a run survives restarts and outlives every client. Each device runs `dpi-backend`; thin clients (web hub, `dpi-tui`, curl) reach it with a URL and a bearer token. The device owns the run. Clients only watch and steer.

`/prime` (`.claude/commands/prime.md`) lists the files to read for full context. `/install` sets up a fresh checkout.

## Commands

Recipes live in `justfile` plus `just/<group>/mod.just` and run under `zsh`. Node 24 (`.nvmrc`). There is no root `package.json`: each app under `apps/` has its own `node_modules` and lockfile.

```bash
just install            # npm install in dpi-sdk, dpi-backend, dpi-playground, dpi-tui
just check              # type checks + unit tests for every app (same as `just test unit`)
just backend run        # this machine's device server on :4780 (frees the port first)
just backend dev        # same, restarting on file changes
just hub build          # type-check and build the web UI; rerun after any FE change
just hub start          # serve the built UI on http://localhost:4781
just hub dev            # hub with Vite hot reload (no build needed)
just tui attach <device>[:<session>:<agent>]
just net up|status|deploy|logs|restart|rotate <device>
```

Per-app checks, run inside the app folder:

| App | Commands |
|---|---|
| `apps/dpi-sdk`, `apps/dpi-backend`, `apps/dpi-tui` | `npm run check` (strict `tsc --noEmit`), `npm test` |
| `apps/dpi-playground` | `npm run build` (vue-tsc + tsc + Vite), `npm run lint` (oxlint), `npm run fmt` (oxfmt), `npm test` |
| `apps/proactive-dpi-demo` | `npm run build`; no unit tests |

Tests use Node's built-in runner through tsx. A single file or test:

```bash
cd apps/dpi-backend && npx tsx --test tests/store.test.ts
cd apps/dpi-backend && npx tsx --test --test-name-pattern "<name>" tests/api.test.ts
```

Test tiers and what they cost:

- `just test unit` and `just test ui` use the faux provider (`DPI_PROVIDER=faux`): free, deterministic, no network. `just test ui` drives the installed Google Chrome against two faux devices and builds the UI first.
- `just test device <id>`, `just test devices` and `just test e2e <id>` call a real model on a real device and cost money. They need the hub running, and must run one device at a time because they share the hub's persisted selection. `e2e` needs a device that runs as a service and drives the TUI in tmux.
- `just test smoke [faux|<device>]` is the TUI smoke test.

The proactive demo is separate: `just proactive install`, `build`, then `take` (reset + start, port 4790), `bug`, `stop`, `tail`. The demo must be stopped before `reset`.

## Architecture

Three levels: a **device** runs one `dpi-backend`; a **session** is one pi-durable harness with its own `agent.sqlite` in a working directory; an **agent** is a conversation in that session (`Main`, a fork or a subagent).

| App | Role |
|---|---|
| `apps/dpi-sdk` | The shared contract. `src/api.ts` is the v1 wire contract, `client.ts` has `DpiClient` and `follow()`, `models.ts` has the reducers (`AgentModel`, `SessionModel`, `NetworkModel`), `transcript.ts` builds the items both clients render. `src/node/` holds the device registry, the `dpi-network.yaml` parser and one ops driver per device kind; `scripts/net.ts` is the CLI behind every `just net` recipe. |
| `apps/dpi-backend` | Express device server on `/v1` (HTTP + SSE, bearer auth). Owns harnesses, tools, extensions (`extensions.ts`, `addons.ts`), durable jobs (`jobs.ts`), shared App State (`shared-state.ts`), streams (`streams.ts`) and idempotent sends (`idempotency.ts`). API reference: `apps/dpi-backend/API.md`. |
| `apps/dpi-playground` | npm workspace with two packages: `dpi-playground-hub` (Express: device registry, token-injecting REST proxy, one multiplexed SSE stream per tab) and `dpi-playground-fe` (Vue 3, Vite). Runs no agents. |
| `apps/dpi-tui` | Terminal client on `@earendil-works/pi-tui`. Talks to the device directly using the registry. |
| `apps/proactive-dpi-demo` | Standalone npm workspace (`proactive-dpi-be`, `-fe`, `-logs`) with its own harness, not a client of `dpi-backend`. A watcher sends each mock log row to Jev; code counts verdicts against thresholds and opens an incident; a durable agent fixes it and waits on an `ops.deploy` approval task. |

Things that span files:

- **The SDK is imported by relative path**, not published: `../../dpi-sdk/src/client.ts`, or `@sdk/*` in the Vite client. Everything in `dpi-sdk/src/` outside `src/node/` must stay browser-safe and free of runtime dependencies.
- **One reducer, two renderers.** The web client and the TUI feed the same stream frames into the same `AgentModel` and render the same transcript items. A transcript change belongs in the SDK, then in both renderers.
- **Wire contract is type-checked.** `apps/dpi-backend/src/contract-check.ts` ties pi-durable's types to `dpi-sdk/src/api.ts`; `npm run check` in the backend fails when they drift.
- **Streams never replay.** Every stream is `hello → snapshot → deltas`, and a reconnect starts from a fresh snapshot. Sends are idempotent through `requestId`.
- **Tokens stay server-side.** The browser holds one SSE connection to the hub and never sees a device token; the hub opens the authenticated upstreams. `guard.ts` rejects unknown Host headers, cross-origin requests and non-JSON writes.
- **Tool replay policy.** Replay-safe tools rerun after a crash; a tool that may have partly run (such as `bash`) returns an interrupted result instead. New tools need the right policy.
- The pi packages (`pi-durable`, `pi-ai`, `chord`, `pi-tui`) are pinned to exact versions. Local copies of their docs are in `ai_docs/pi/` and `ai_docs/durable_pi/`.

## State on disk

- `~/.dpi/backend.env`: the device's token and config (0600). `~/.dpi/backend/`: `catalog.sqlite`, `app-state.sqlite`, `sessions/<uuid>/agent.sqlite`, `archive/` (DELETE archives, it never removes files).
- `~/.dpi/network.sqlite`: the hub's device registry and tokens.
- `apps/proactive-dpi-demo/.data/` and `workspace/`: the demo's databases, log and mock repo, rebuilt by `reset`.

## Devices

`dpi-network.yaml` (gitignored; start from `dpi-network.example.yaml`) is the only place that names machines. Every device recipe takes an id from it, and tokens never live in the YAML. Kinds are `local`, `ssh`, `exe-dev` and `url`.

- Touch only devices named in that file. `just net destroy` works only on `exe-dev` VMs listed there.
- `just net deploy`, `restart`, `rotate` and `destroy` act on remote machines; `just backend run` and `just hub start` kill whatever already holds their port.
- A token holder has the agent's shell and filesystem access on that device. Start dirs are where sessions begin, not a sandbox.
- Operating devices by kind: `.claude/skills/agent-sandboxes-exe-dev/cookbook/dpi-network.md`.
