import v1 from './tui'
import v2 from './cli'

// Keep sidebar routing separate: V1 rejects modules with both server and tui.
export default { id: v2.id, tui: v1.tui, setup: v2.setup }
