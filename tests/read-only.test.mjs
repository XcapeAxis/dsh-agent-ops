import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/index.js'

test('keeps resumable work visible without registering write or memory tools', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ops-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
    fs.rmSync(resolved, { recursive: true })
  })
  const dir = path.join(root, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const row = (id, rows) => fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({
    record: { identity: { cwd: root }, rows }
  }))
  row('session-title', { title: { val: 'Review export cues' }, sessionStats: { val: { turns: 1 } } })
  row('blank', { sessionStats: { val: { turns: 0 } } })
  row('archived', { title: { val: 'Old render notes' } })
  row('subagent', { title: { val: 'Test runner' }, subagent: { val: { identity: { label: 'runner' } } } })
  row('prompt', { sessionStats: { val: { turns: 0 } }, titleInput: { val: { first: { text: 'Check the pacing' } } } })
  row('unknown', {})

  const tools = new Map()
  const studio = { id: 'studio', title: 'Studio', path: root, sessionIds: [
    'session-title', 'session-blank', 'session-archived', 'session-subagent', 'session-prompt', 'session-unknown'
  ] }
  apply({
    tools: { register: def => tools.set(def.name, def) },
    sessions: { get: () => undefined, list: () => [] },
    workspaceRegistry: { list: () => [studio], archivedSessionIds: ['session-archived'] }
  }, { writes: 'all', memory: { enabled: true } })
  assert.deepEqual([...tools.keys()], ['workspace_list', 'session_list', 'session_info', 'now'])

  const run = (name, args) => tools.get(name).execute(args)
  const list = await run('session_list')
  assert.equal(list.archivedHidden, 1)
  assert.equal(list.subagentsHidden, 1)
  assert.deepEqual(list.groups[0].sessions.map(row => row.sessionId), [
    'session-title', 'session-blank', 'session-prompt', 'session-unknown'
  ])
  const now = await run('now')
  assert.equal(now.blankHidden, 1)
  assert.deepEqual(new Set(now.sessions.map(row => row.sessionId)), new Set([
    'session-title', 'session-prompt', 'session-unknown'
  ]))
  assert.equal(now.sessions.find(row => row.sessionId === 'session-prompt').firstPrompt, 'Check the pacing')
  const info = await run('session_info', { sessionId: 'session-title' })
  assert.equal(info.title, 'Review export cues')
  assert.equal(info.attached, false)
  assert.equal((await run('workspace_list')).count, 1)
})
