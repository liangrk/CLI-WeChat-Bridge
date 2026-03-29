# Hub-Spoke Architecture Design

## Overview

Redesign CLI-WeChat-Bridge from single-project to multi-project Hub-Spoke architecture.
One Hub process monitors WeChat and routes messages to multiple Claude Code spoke instances
running in parallel.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  wechat-bridge-claude --hub (Hub)    │
                    │  ┌──────────┐  ┌────────────────┐   │
WeChat ◄──────────►│  │ WeChat   │  │ Hub TCP Server │   │
                    │  │ Transport│  │ (固定端口)      │   │
                    │  └────┬─────┘  └───┬────┬───┬──┘   │
                    │       │            │    │    │      │
                    │       │  ┌─────────┘    │    └──┐   │
                    │       │  │  spoke 注册表  │       │   │
                    │       │  └──────────────┘       │   │
                    └───────┼─────────────────────────┼───┘
                            │                         │
              ┌─────────────┼─────────────────────────┼──────┐
              │             │                         │      │
     wechat-claude-A  wechat-claude-B         wechat-claude-C
     [virtual-magic] [CLI-WeChat-Bridge]     [other-project]
              ↕ PTY            ↕ PTY                  ↕ PTY
         Claude Code-A     Claude Code-B         Claude Code-C
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Hub role | Replaces bridge (no PTY in Hub) | Single process for WeChat + routing |
| Spoke discovery | Fixed TCP port (18760) | Simple, no file-based discovery needed |
| Project name | Directory name (auto-detected) | Zero config, works immediately |
| Startup command | `wechat-bridge-claude --hub` | Reuse existing command, `--hub` flag for Hub mode |
| Compatibility | Default single-project + `--hub` | Backward compatible |
| Message labels | Always add `[project-name]` prefix | Consistent format regardless of project count |

## Spoke Connection Protocol

### Discovery (auto-detect, no new params needed)

```
wechat-claude startup:
  1. Try connecting to Hub fixed port (18760)
     ├─ Success → Hub mode: send register message
     └─ Failure → Fallback: read per-workspace endpoint file (current behavior)
```

### Hub-Spoke Protocol (extends local-companion-link)

New message types added to existing protocol:

```typescript
// Spoke → Hub
{ type: "register"; projectName: string; cwd: string; token: string }

// Hub → Spoke
{ type: "register_ack"; accepted: boolean; reason?: string }
{ type: "wechat_message"; messageId: string; text: string; fromUserId: string }
{ type: "wechat_command"; command: string; args?: string }
```

Existing message types (`hello`, `request`, `response`, `event`, `state`) remain unchanged.
Spoke events (`approval_required`, `final_reply`, `status`, etc.) are forwarded through Hub
to WeChat with `[project-name]` prefix.

## Message Routing

### Incoming (WeChat → Spoke)

```
Receive WeChat message text
│
├─ Parse [project-name] prefix
│   ├─ Prefix found → match spoke registry
│   │   ├─ Matched → forward to that spoke
│   │   └─ No match → reply: "未找到项目 xxx，当前在线项目：A, B, C"
│   │
│   └─ No prefix
│       ├─ Only 1 spoke → forward directly (no prefix needed)
│       └─ Multiple spokes → reply: "请指定项目前缀，当前在线项目：A, B, C"
│
├─ System commands (/status, /projects)
│   └─ Hub handles directly, no forwarding
│
└─ Approval response (confirm/deny)
    └─ Forward to spoke associated with pendingApproval
```

### Outgoing (Spoke → WeChat)

All messages always carry project prefix:

- Final reply: `[project-name] 回复内容`
- Approval request: `[project-name] 等待确认：是否允许 Read 文件 xxx？`
- Lifecycle: `[project-name] 项目已上线` / `[project-name] 项目已离线`

## Project Lifecycle

| Event | Hub Action | WeChat Notification |
|-------|-----------|-------------------|
| Spoke connects & registers | Add to registry, assign projectName | `[project-name] 项目已上线` |
| Spoke disconnects | Remove from registry | `[project-name] 项目已离线` |
| Spoke heartbeat timeout | Mark stale, remove after 60s | `[project-name] 项目已离线（超时）` |
| Spoke reconnects (same projectName) | Restore routing, no duplicate notification | (silent) |

## WeChat Commands

| Command | Behavior |
|---------|----------|
| `/projects` | List all online projects with status |
| `/status` | Summary of all online projects |
| `/stop [project]` | Interrupt task; with prefix → specific project, without → error if multiple |
| `/reset [project]` | Reset session for project |

### /projects output format

```
当前在线项目（2）：
  [CLI-WeChat-Bridge] - busy - 正在处理任务
  [virtual-magic] - idle - 等待输入
```

## Heartbeat & Reconnection

### Bidirectional Heartbeat

```
Spoke ──── ping (every 10s) ────► Hub
Spoke ◄──── pong ─────────────── Hub
```

Hub-side timeout:
- 30s without ping → mark spoke as "stale"
- 60s without ping → mark spoke as "offline", notify WeChat
- Ping received again → re-mark as "online" (no duplicate notification)

Spoke-side timeout:
- 15s without pong → consider connection dead
- Trigger immediate reconnection (don't wait for next heartbeat cycle)

### Spoke Reconnection Strategy

```
Connection lost
  → 1st retry: immediate
  → 2nd retry: 2s delay
  → 3rd retry: 4s delay
  → Nth retry: min(2^(N-1), 30)s delay
  → Max retries: unlimited (never give up)

After successful reconnection:
  → Re-send register message (same projectName + cwd)
  → Hub restores routing, no duplicate "online" notification
  → pendingApproval preserved on Hub side, spoke can continue handling
```

### Hub Restart Recovery

```
Hub process exits (crash/manual restart)
  → All spokes detect disconnection
  → All spokes auto-reconnect
  → Hub restarts, accepts connections, rebuilds registry
  → WeChat notifications: each spoke comes back online
```

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Claude Code crashes (PTY exits) | Spoke keeps connection, Hub notified status=stopped |
| Spoke process killed | Hub heartbeat timeout detects, notify WeChat "offline" |
| Hub crashes | All spokes reconnect, spoke-side PTY unaffected |
| Brief network interruption | Spoke auto-reconnects, Hub preserves spoke state |

## Implementation Scope

### New files
- `src/bridge/hub-server.ts` — Hub TCP server, spoke registry, message routing engine

### Modified files
- `src/bridge/wechat-bridge.ts` — Add `--hub` mode path (HubServer instead of adapter)
- `src/companion/local-companion.ts` — Try Hub first, fallback to per-workspace endpoint
- `src/companion/local-companion-link.ts` — Add Hub protocol message types
- `src/bridge/bridge-types.ts` — Add Hub-related types
- `src/wechat/channel-config.ts` — Add Hub endpoint constants (fixed port)
- CLI entry points — Add `--hub` flag parsing

### Not in scope (future phases)
- Per-project workspace isolation in Hub mode
- Hub-level state persistence across restarts
- Multi-Hub (distributed) architecture
