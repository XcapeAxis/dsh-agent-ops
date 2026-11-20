import { registerReadTools } from './tools/read.js'

export const name = 'agent-ops'
export const inject = ['tools', 'sessions', 'workspaceRegistry']

export function apply (ctx) {
  registerReadTools(ctx)
}
