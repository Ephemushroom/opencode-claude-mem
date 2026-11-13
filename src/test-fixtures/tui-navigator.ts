import type { Context } from '@opencode/plugin/tui/context'

export default {
  id: 'fixture-session',
  async setup(ctx: Context) {
    const session = await ctx.client.session.create({
      location: { directory: process.cwd() },
      title: 'Sidebar fixture',
      model: { providerID: 'fixture', id: 'model' },
    })
    // An idle beta-19192 SSE connection needs a real event to complete its handshake.
    // Navigate after the initial host route has mounted, not during plugin setup.
    let count = 0
    const timer = setInterval(async () => {
      await ctx.client.session.update({
        sessionID: session.id,
        title: `Sidebar fixture ${++count}`,
      })
      ctx.ui.router.navigate({ type: 'session', sessionID: session.id })
      if (ctx.data.session.get(session.id)) {
        clearInterval(timer)
      }
    }, 500)
    return () => clearInterval(timer)
  },
}
