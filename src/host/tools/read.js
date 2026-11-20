/**
 * M1 · 只读工具（4 个）—— 「Agent 能看见」的基础。
 *
 * 与首版相比的**唯一实质变化**：会话多了身份。
 * 以前 `session_list` / `session_info` 只回 cwd / origin / attached，
 * 于是「这条会话在干什么」读不出来 —— 人记不住，Agent 也记不住。
 * 现在每条会话带上 `title`（来自官方 `sessionTitle` 服务，冷会话退回投影检查点）、
 * `lastActiveMs`、`archived`，并新增 `now`：一张按活跃度排序的「该回哪个会话」清单。
 *
 * 提供：
 * - `workspace_list`：列出所有工作区
 * - `session_list`：按工作区分组 + `ungrouped` 孤儿桶
 * - `session_info`：区分 found / known / attached，并带标题
 * - `now`：不分组的「现在」清单（未归档、按最近活动倒序）
 *
 * @module dsh-agent-ops/tools/read
 */

import { p, out, s, b, n, sa, obj, tool as makeTool } from '../shared/schema.js'
import { readSessionIndex } from '../session-index.js'

/**
 * 从 host 上下文解析一个**可选**服务。服务可能尚未注入，取不到就返回 undefined，
 * 绝不抛错（注册链与执行链都要 fail-open）。
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {any}
 */
function service (ctx, name) {
  try {
    const direct = ctx?.[name]
    if (direct !== undefined && direct !== null) return direct
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * 已归档会话的 id 集合。官方来源是 `workspaceRegistry.archivedSessionIds`。
 *
 * @param {object} ctx
 * @returns {Set<string>}
 */
function archivedSet (ctx) {
  try {
    const raw = ctx?.workspaceRegistry?.archivedSessionIds
    return new Set(Array.isArray(raw) ? raw : [])
  } catch {
    return new Set()
  }
}

/**
 * 活会话的标题快照。官方契约：`sessionTitle.get(session)` 只认活着的会话对象。
 *
 * @param {object} ctx
 * @param {object} session
 * @returns {{title: string, source: string}|null}
 */
function liveTitle (ctx, session) {
  try {
    const snapshot = service(ctx, 'sessionTitle')?.get?.(session)
    const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
    if (title.length === 0) return null
    return { title, source: typeof snapshot?.source?.kind === 'string' ? snapshot.source.kind : '' }
  } catch {
    return null
  }
}

/**
 * 一条会话的身份视图：标题优先取活服务，取不到退回投影检查点。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {Map<string, any>} index
 * @param {Set<string>} archived
 */
function identityOf (ctx, sessionId, index, archived) {
  const live = ctx.sessions.get(sessionId)
  const known = index.get(sessionId)
  const fromLive = live === undefined ? null : liveTitle(ctx, live)
  return {
    sessionId,
    // 空字符串表示「不知道」，不用会话 id 冒充标题。
    title: fromLive?.title ?? known?.title ?? '',
    titleSource: fromLive?.source ?? (known?.title ? 'projection' : ''),
    attached: live !== undefined,
    archived: archived.has(sessionId),
    lastActiveMs: Number.isFinite(known?.lastActive) ? known.lastActive : 0,
    cwd: live?.header?.cwd ?? known?.cwd ?? '',
    // 子代理会话不是「该回去的那条对话」，默认不该占人的注意力。
    subagent: known?.subagent === true || live?.header?.origin === 'subagent',
    subagentLabel: known?.label ?? '',
    turns: known?.turns ?? 0
  }
}

/** 一条会话的紧凑视图（不含日志正文）。 */
function sessionView (session) {
  const header = session?.header ?? {}
  return {
    sessionId: header.id ?? session?.id ?? null,
    cwd: header.cwd ?? null,
    origin: header.origin ?? null,
    parentSession: header.parentSession ?? null,
    isSeeded: header.isSeeded ?? null
  }
}

/** 目录 basename，用于「不知道该归哪个工作区」时的项目名兜底。 */
function basenameOf (dir) {
  if (typeof dir !== 'string' || dir.length === 0) return ''
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * 把会话 id 映射到工作区标题（同一进程内用一次的临时索引，不做缓存）。
 *
 * @param {object} ctx
 * @returns {{bySession: Map<string, string>, byPath: Map<string, string>}}
 */
function projectMaps (ctx) {
  const bySession = new Map()
  const byPath = new Map()
  let list = []
  try {
    list = ctx.workspaceRegistry.list()
  } catch {
    list = []
  }
  for (const workspace of list) {
    byPath.set(String(workspace.path).toLowerCase(), workspace.title)
    for (const id of workspace.sessionIds ?? []) bySession.set(id, workspace.title)
  }
  return { bySession, byPath }
}

/** @param {object} ctx */
export function registerReadTools (ctx) {
  // ── workspace_list ────────────────────────────────────────────────────
  ctx.tools.register(makeTool({
    name: 'workspace_list',
    description:
      'List every Workspace registered in this DeepSeek Harness deployment, with its ' +
      'directory path, title, and the Session ids it groups. Use it before deciding ' +
      'which Workspace a new Session belongs to, or to answer "what projects am I ' +
      'working in". Read-only.',
    parameters: {},
    schema: out({
      count: n('Number of Workspaces.'),
      workspaces: {
        type: 'array',
        description: 'Workspaces in display order.',
        items: obj({
          id: s('Workspace id.'),
          path: s('Canonical directory path.'),
          title: s('Display title.'),
          sessionCount: n('Number of grouped Sessions (archived included).'),
          activeSessionCount: n('Grouped Sessions that are not archived.'),
          archivedSessionCount: n('Grouped Sessions that are archived.'),
          hasLedger: b('Whether <path>/ledger exists, i.e. this Workspace keeps a task ledger.'),
          sessionIds: sa('Session ids grouped under this Workspace.')
        })
      }
    }),
    async execute () {
      const archived = archivedSet(ctx)
      const fs = await import('node:fs')
      const path = await import('node:path')
      const workspaces = ctx.workspaceRegistry.list().map(entity => {
        const ids = [...entity.sessionIds]
        const archivedCount = ids.filter(id => archived.has(id)).length
        let hasLedger = false
        try {
          hasLedger = fs.existsSync(path.join(entity.path, 'ledger'))
        } catch {
          hasLedger = false
        }
        return {
          id: entity.id,
          path: entity.path,
          title: entity.title,
          sessionCount: ids.length,
          activeSessionCount: ids.length - archivedCount,
          archivedSessionCount: archivedCount,
          hasLedger,
          sessionIds: ids
        }
      })
      return { count: workspaces.length, workspaces }
    }
  }))

  // ── session_list ──────────────────────────────────────────────────────
  ctx.tools.register(makeTool({
    name: 'session_list',
    description:
      'List the Conversations (Sessions) attached in this deployment, grouped by ' +
      'Workspace, plus a separate list of attached Sessions that no Workspace groups ' +
      '(subagent Sessions, or Sessions from another cwd). Each Session carries its ' +
      'title so you can tell what it is for. Archived and subagent Sessions are ' +
      'hidden by default. Read-only. Use session_info for one Session, and ' +
      '"now" for one flat list sorted by recency.',
    parameters: {
      includeArchived: p.boolean('Include archived Sessions. Defaults to false.', false),
      includeSubagents: p.boolean('Include subagent Sessions. Defaults to false.', false)
    },
    schema: out({
      total: n('Sessions listed after filtering.'),
      archivedHidden: n('Archived Sessions omitted by the filter.'),
      subagentsHidden: n('Subagent Sessions omitted by the filter.'),
      untitled: n('Listed Sessions whose title is still unknown.'),
      groups: {
        type: 'array',
        description: 'One entry per Workspace.',
        items: obj({
          workspaceId: s('Workspace id.'),
          title: s('Workspace title.'),
          path: s('Workspace directory.'),
          sessions: {
            type: 'array',
            items: obj({
              sessionId: s('Session id.'),
              title: s('Session title, or empty string when unknown.'),
              titleSource: s('user | llm | projection | empty.'),
              cwd: s('Working directory, empty string when unknown.'),
              attached: b('Whether a live Agent currently holds this Session.'),
              archived: b('Whether this Session is archived.'),
              subagent: b('True when this Session is a subagent (not a conversation to return to).'),
              subagentLabel: s('Subagent label, empty when this is not a subagent.'),
              turns: n('Completed user turns, 0 when unknown.'),
              lastActiveMs: n('Epoch milliseconds of the last write, 0 when unknown.')
            })
          }
        })
      },
      ungrouped: {
        type: 'array',
        description: 'Sessions that no Workspace groups.',
        items: obj({
          sessionId: s('Session id.'),
          title: s('Session title, or empty string when unknown.'),
          titleSource: s('user | llm | projection | empty.'),
          cwd: s('Empty string when unknown.'),
          origin: s('Empty string when unknown.'),
          attached: b('Whether a live Agent currently holds this Session.'),
          subagent: b('True when this Session is a subagent.'),
          subagentLabel: s('Subagent label, empty when not a subagent.'),
          turns: n('Completed user turns, 0 when unknown.'),
          lastActiveMs: n('Epoch milliseconds of the last write, 0 when unknown.')
        })
      }
    }),
    async execute (args = {}) {
      const includeArchived = args?.includeArchived === true
      const includeSubagents = args?.includeSubagents === true
      const index = readSessionIndex()
      const archived = archivedSet(ctx)
      const workspaces = ctx.workspaceRegistry.list()
      const grouped = new Set(workspaces.flatMap(w => [...w.sessionIds]))

      let archivedHidden = 0
      let subagentsHidden = 0
      const keep = row => {
        if (row.archived && !includeArchived) {
          archivedHidden += 1
          return false
        }
        if (row.subagent && !includeSubagents) {
          subagentsHidden += 1
          return false
        }
        return true
      }

      const groups = workspaces.map(w => ({
        workspaceId: w.id,
        title: w.title,
        path: w.path,
        sessions: [...w.sessionIds]
          .map(id => identityOf(ctx, id, index, archived))
          .filter(keep)
      }))

      const ungrouped = []
      for (const session of ctx.sessions.list()) {
        const view = sessionView(session)
        if (view.sessionId === null || grouped.has(view.sessionId)) continue
        const row = identityOf(ctx, view.sessionId, index, archived)
        if (!keep(row)) continue
        ungrouped.push({
          sessionId: row.sessionId,
          title: row.title,
          titleSource: row.titleSource,
          cwd: row.cwd || view.cwd || '',
          origin: view.origin ?? '',
          attached: row.attached,
          subagent: row.subagent,
          subagentLabel: row.subagentLabel,
          turns: row.turns,
          lastActiveMs: row.lastActiveMs
        })
      }

      const listed = groups.reduce((sum, g) => sum + g.sessions.length, 0) + ungrouped.length
      const untitled = groups.reduce((sum, g) => sum + g.sessions.filter(x => x.title === '').length, 0) +
        ungrouped.filter(x => x.title === '').length
      return { total: listed, archivedHidden, subagentsHidden, untitled, groups, ungrouped }
    }
  }))

  // ── session_info ──────────────────────────────────────────────────────
  ctx.tools.register(makeTool({
    name: 'session_info',
    description:
      'Describe one Session: its title, working directory, origin, parent Session, ' +
      'whether it is blank, whether it is archived, when it last moved, and every ' +
      'Workspace that groups it. Pass the exact session id. Read-only; does not resume ' +
      'the Session or read its conversation log.',
    parameters: {
      sessionId: p.string('The Session id to describe.')
    },
    schema: out({
      found: b('Whether any registry knows this id.'),
      known: b('Whether the id appears in the global Workspace index.'),
      attached: b('Whether a live Agent currently holds this Session.'),
      archived: b('Whether this Session is archived.'),
      sessionId: s('Session id.'),
      title: s('Session title, or empty string when unknown.'),
      titleSource: s('user | llm | projection | empty.'),
      firstPrompt: s('First human input, truncated; empty string when none.'),
      subagent: b('True when this Session is a subagent.'),
      subagentLabel: s('Subagent label, empty when not a subagent.'),
      turns: n('Completed user turns, 0 when unknown.'),
      lastActiveMs: n('Epoch milliseconds of the last write, 0 when unknown.'),
      cwd: s('Empty string when unknown.'),
      origin: s('Empty string when unknown.'),
      parentSession: s('Empty string when none.'),
      isSeeded: b('Whether the Session was seeded.'),
      workspaces: {
        type: 'array',
        description: 'Workspaces that group this Session.',
        items: obj({
          id: s('Workspace id.'),
          title: s('Workspace title.'),
          path: s('Workspace directory.')
        })
      }
    }),
    async execute ({ sessionId }) {
      const index = readSessionIndex()
      const archived = archivedSet(ctx)
      const identity = identityOf(ctx, sessionId, index, archived)
      const known = index.get(sessionId)
      const owners = ctx.workspaceRegistry
        .list()
        .filter(w => w.sessionIds.includes(sessionId))
        .map(w => ({ id: w.id, title: w.title, path: w.path }))

      const live = ctx.sessions.get(sessionId)
      const header = live === undefined
        ? { cwd: identity.cwd, origin: '', parentSession: '', isSeeded: false }
        : sessionView(live)

      return {
        found: live !== undefined || owners.length > 0 || known !== undefined,
        known: owners.length > 0 || known !== undefined,
        attached: live !== undefined,
        archived: identity.archived,
        sessionId,
        title: identity.title,
        titleSource: identity.titleSource,
        firstPrompt: known?.firstPrompt ?? '',
        subagent: identity.subagent,
        subagentLabel: identity.subagentLabel,
        turns: identity.turns,
        lastActiveMs: identity.lastActiveMs,
        cwd: header.cwd ?? '',
        origin: header.origin ?? '',
        parentSession: header.parentSession ?? '',
        isSeeded: header.isSeeded === true,
        workspaces: owners
      }
    }
  }))

  // ── now ───────────────────────────────────────────────────────────────
  ctx.tools.register(makeTool({
    name: 'now',
    description:
      'One flat list answering "which Session should I go back to, and what is it for". ' +
      'Every non-archived Session, newest activity first, each row carrying its title and ' +
      'project. Archived Sessions, subagent Sessions, and confirmed blank cold Sessions ' +
      'are omitted by default. Read-only. Prefer this over session_list when several Sessions are in ' +
      'flight, or when the user asks 我现在该回哪个会话 / 这轮在哪儿继续.',
    parameters: {
      limit: p.number('Maximum rows. Defaults to 12.', false),
      includeArchived: p.boolean('Include archived Sessions. Defaults to false.', false),
      includeSubagents: p.boolean('Include subagent Sessions. Defaults to false.', false),
      workspace: p.string('Only Sessions whose project title or path contains this text.', false)
    },
    schema: out({
      count: n('Rows returned.'),
      considered: n('Sessions examined before the limit was applied.'),
      untitled: n('Rows whose title is still unknown (these are the holes to fix).'),
      subagentsHidden: n('Subagent Sessions omitted by the filter.'),
      blankHidden: n('Cold Sessions confirmed blank by their projection and omitted.'),
      generatedAt: s('ISO timestamp of this snapshot.'),
      sessions: {
        type: 'array',
        description: 'Sessions, most recently active first.',
        items: obj({
          sessionId: s('Session id.'),
          title: s('Session title, or empty string when unknown.'),
          titleSource: s('user | llm | projection | empty.'),
          project: s('Workspace title, or the directory basename.'),
          workspaceId: s('Workspace id, empty when ungrouped.'),
          cwd: s('Working directory.'),
          attached: b('Whether a live Agent currently holds this Session.'),
          subagent: b('True when this Session is a subagent.'),
          subagentLabel: s('Subagent label, empty when not a subagent.'),
          turns: n('Completed user turns, 0 when unknown.'),
          lastActiveMs: n('Epoch milliseconds of the last write, 0 when unknown.'),
          firstPrompt: s('First human input, truncated; empty string when none.')
        })
      }
    }),
    async execute (args = {}) {
      const includeArchived = args?.includeArchived === true
      const includeSubagents = args?.includeSubagents === true
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 12
      const needle = typeof args?.workspace === 'string' ? args.workspace.toLowerCase() : ''
      const index = readSessionIndex()
      const archived = archivedSet(ctx)
      const { bySession, byPath } = projectMaps(ctx)

      /** @type {Map<string, any>} */
      const rows = new Map()

      // 1) 工作区注册表里出现过的会话（哪怕从不曾活过，也属于某个项目）
      for (const workspace of ctx.workspaceRegistry.list()) {
        for (const id of workspace.sessionIds ?? []) {
          rows.set(id, { workspaceId: workspace.id, project: workspace.title })
        }
      }
      // 2) 投影检查点里的一切会话（含孤儿、含子代理）
      for (const [id, entry] of index) {
        if (!rows.has(id)) rows.set(id, { workspaceId: '', project: basenameOf(entry.cwd) })
        else if (rows.get(id).project === '') rows.get(id).project = basenameOf(entry.cwd)
      }

      const collected = []
      let subagentsHidden = 0
      let blankHidden = 0
      for (const [sessionId, seat] of rows) {
        const identity = identityOf(ctx, sessionId, index, archived)
        if (identity.archived && !includeArchived) continue
        if (identity.subagent && !includeSubagents) {
          subagentsHidden += 1
          continue
        }
        const known = index.get(sessionId)
        if (!identity.attached && !identity.title && known?.blank === true) {
          blankHidden += 1
          continue
        }
        const project = seat.project || basenameOf(identity.cwd) || byPath.get(String(identity.cwd).toLowerCase()) || ''
        collected.push({
          sessionId,
          title: identity.title,
          titleSource: identity.titleSource,
          project,
          workspaceId: seat.workspaceId,
          cwd: identity.cwd,
          attached: identity.attached,
          subagent: identity.subagent,
          subagentLabel: identity.subagentLabel,
          turns: identity.turns,
          lastActiveMs: identity.lastActiveMs,
          firstPrompt: known?.firstPrompt ?? ''
        })
      }

      const filtered = needle.length === 0
        ? collected
        : collected.filter(row => `${row.project} ${row.cwd} ${row.title}`.toLowerCase().includes(needle))

      filtered.sort((a, b2) => b2.lastActiveMs - a.lastActiveMs)
      const sessions = filtered.slice(0, limit)
      return {
        count: sessions.length,
        considered: filtered.length,
        untitled: filtered.filter(row => row.title === '').length,
        subagentsHidden,
        blankHidden,
        generatedAt: new Date().toISOString(),
        sessions
      }
    }
  }))
}
