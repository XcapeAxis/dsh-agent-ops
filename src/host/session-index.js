/**
 * 会话索引 —— 「这条会话叫什么、在哪个目录、多久没动」。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 官方的 `ctx.sessionTitle.get(session)` 只认**活着的**会话对象（有 Agent 持有）。
 * 但侧边栏里一多半会话是冷的：其 `ctx.sessions.get(id)` 是 `undefined`，
 * 于是标题读不到 —— 这正是「多线程时忘了回哪个会话」那类问题的机械原因。
 *
 * 冷会话的标题只存在于 DSH 的**投影检查点**里：
 *   <home>/storages/session_projcache/sessions/<uuid>.json
 *     → record.identity.cwd / record.identity.createdAt
 *     → record.rows.title.val            （提交过的标题）
 *     → record.rows.titleInput.first.text （首条人类输入，可当兜底提示）
 * 文件 mtime ≈ 该会话最后一次写入时间。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 * 1. **只读**。绝不写、不建、不删这件事目录里的任何东西。
 * 2. **不是第二个事实源**。它只是把官方已经算好的投影读出来；读不到就返回空，
 *    由调用方降级为「标题未知」，绝不猜、绝不用会话 id 冒充标题。
 * 3. **fail-open**。目录不存在 / JSON 坏了 / 权限不足，一律跳过该条，不抛错。
 *    （插件协议：注册链不能因为一个读文件失败而拖垮整棵树。）
 *
 * @module dsh-agent-ops/session-index
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 首条输入提示保留多少字符（够认出「这轮在干什么」，不搬正文）。 */
const HINT_LIMIT = 160

/**
 * 解析 DSH home。`DSH_HOME` 优先，否则退回 `~/.dsh`。
 *
 * @returns {string}
 */
function dshHome () {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * 从一条投影检查点里取出我们关心的字段。
 *
 * 关键一条：`rows.subagent.val.identity` 有值就说明这是**子代理会话**
 * （普通会话这里是 `{}`）。它给出 `label`，比从首条 prompt 里猜可靠得多。
 *
 * @param {unknown} record
 * @returns {{title: string|null, firstPrompt: string|null, cwd: string|null, createdAt: number|null, subagent: boolean, label: string|null, turns: number, blank: boolean}}
 */
function pick (record) {
  const identity = record?.identity ?? {}
  const rows = record?.rows ?? {}
  const title = typeof rows?.title?.val === 'string' && rows.title.val.trim().length > 0
    ? rows.title.val.trim()
    : null
  const rawHint = rows?.titleInput?.val?.first?.text ?? rows?.titleInput?.first?.text
  const firstPrompt = typeof rawHint === 'string' && rawHint.trim().length > 0
    ? rawHint.trim().slice(0, HINT_LIMIT)
    : null
  const subagentIdentity = rows?.subagent?.val?.identity
  const subagent = subagentIdentity !== undefined && subagentIdentity !== null
  const label = typeof subagentIdentity?.label === 'string' && subagentIdentity.label.trim().length > 0
    ? subagentIdentity.label.trim()
    : null
  const recordedTurns = rows?.sessionStats?.val?.turns
  return {
    title,
    firstPrompt,
    cwd: typeof identity.cwd === 'string' ? identity.cwd : null,
    createdAt: Number.isFinite(identity.createdAt) ? identity.createdAt : null,
    subagent,
    label,
    turns: Number.isFinite(recordedTurns) ? recordedTurns : 0,
    blank: recordedTurns === 0 && title === null && firstPrompt === null
  }
}

/**
 * 读出全部会话的索引。返回 Map，键是完整会话 id（`session-<uuid>`）。
 *
 * 任何一步失败都只会让结果变少，不会抛错。
 *
 * @returns {Map<string, {sessionId: string, title: string|null, firstPrompt: string|null, cwd: string|null, createdAt: number|null, lastActive: number|null}>}
 */
export function readSessionIndex () {
  /** @type {Map<string, any>} */
  const index = new Map()
  const dir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')

  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return index
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const base = name.slice(0, -'.json'.length)
    if (base.length === 0) continue
    // 磁盘上两种命名并存：老文件是裸 uuid，新文件已经带 `session-`。两种都要认。
    const sessionId = base.startsWith('session-') ? base : `session-${base}`
    const file = path.join(dir, name)

    let lastActive = null
    let parsed = null
    try {
      lastActive = Math.round(fs.statSync(file).mtimeMs)
      // 投影检查点可能较大（KB 级）；这里只需要三层字段，解析一次即可。
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      // 半写入 / 损坏 / 被占用：跳过这一条，不影响其它会话。
      continue
    }

    const fields = pick(parsed?.record ?? parsed)
    index.set(sessionId, { sessionId, lastActive, ...fields })
  }

  return index
}
