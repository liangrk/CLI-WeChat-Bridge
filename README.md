# Claude Code / Codex WeChat Bridge

Bridge WeChat messages into a local interactive `codex`, `claude`, or persistent
`powershell.exe` session. The main workflow is:

```text
WeChat (iOS) -> WeChat ClawBot -> ilink API -> wechat-bridge
                                              |
                                              +--> codex
                                              +--> claude
                                              +--> powershell.exe
```

The bridge keeps one local session bridge alive and mirrors:

- WeChat messages -> local CLI stdin
- Local CLI output -> WeChat replies
- Approval prompts -> WeChat `/confirm` or `/deny`

Adapter behavior:

- `codex` runs in two terminals: the bridge stays in one terminal, and the visible Codex panel runs in a second terminal via `bun run codex:panel`
- `claude` and `powershell.exe` still use persistent interactive terminal sessions

## Requirements

- Bun >= 1.0 for setup and tests
- Node.js >= 24 for the default bridge runtime
- A local CLI to bridge: `codex`, `claude`, or `powershell.exe`
- The latest iOS WeChat build with ClawBot support

## Quick Start

1. Install dependencies:

```bash
bun install
```

2. Log in to WeChat and save bridge credentials:

```bash
bun run setup
```

Credentials are stored in `~/.claude/channels/wechat/account.json`.
The bridge uses `account.json.userId` as the only authorized WeChat owner.

3. Start a bridge:

```bash
bun run bridge:codex
# or
bun run bridge:claude
# or
bun run bridge:shell
```

4. If you started `bridge:codex`, open a second terminal in the same repository and run:

```bash
bun run codex:panel
```

5. After startup:

- Send plain text to forward input to the active CLI session
- Use `/status` to inspect the bridge
- Use `/stop` to send Ctrl+C
- Use `/reset` to restart the local session
- Use `/confirm <code>` or `/deny` for approval prompts
- No `/pair` step is required
- Only the logged-in WeChat account from `account.json.userId` is allowed to use the bridge

## Why Node Is The Default Bridge Runtime

On Windows, interactive `node-pty` sessions are more reliable under Node.js than
under Bun for `codex` and `claude`. The package scripts keep the same
`bun run bridge:*` user interface, but those scripts now launch Node directly:

```bash
node --no-warnings --experimental-strip-types wechat-bridge.ts --adapter codex
```

The bridge also resolves Windows launchers more carefully:

- `codex.ps1` is avoided because PowerShell execution policy often blocks it
- `codex.cmd` is wrapped through `cmd.exe` when needed
- bundled vendor `codex.exe` is preferred when available
- `claude.exe` is launched directly when present

For `codex`, the bridge also starts a private local app-server and connects the
visible TUI client to it. The bridge terminal stays clean, the second terminal
shows the visible panel, and WeChat replies are extracted from the Codex session
log instead of raw TUI frames.

## Scripts

```bash
bun run setup
bun run bridge:codex
bun run codex:panel
bun run bridge:claude
bun run bridge:shell
bun run bridge:bun -- --adapter codex   # legacy Bun entrypoint for debugging
bun run start                           # legacy MCP server
bun run check                           # MCP status check
bun run test
```

## Files

| File | Purpose |
| --- | --- |
| `wechat-bridge.ts` | Main WeChat <-> CLI bridge loop |
| `bridge-adapters.ts` | `codex` / `claude` / `shell` PTY adapters |
| `bridge-state.ts` | Owner lock, state file, and logs |
| `wechat-transport.ts` | ilink polling and send-message transport |
| `wechat-channel.ts` | Legacy MCP server |
| `setup.ts` | QR login flow and credential bootstrap |

## Notes

- The bridge is single-owner by design. The owner is `account.json.userId`.
- `shell` mode keeps a persistent PowerShell session and adds approval for risky commands.
- Approval detection for `codex` and `claude` is text-pattern based. Verify it once on your machine.
- `codex` should be started as a two-terminal workflow: bridge first, then `bun run codex:panel` in a second terminal.
- WeChat intentionally does not receive raw Codex TUI frames, task summaries, or heartbeat spam.
- The current WeChat ClawBot path still depends on the official iOS client feature set.

## License

MIT
