import v1 from './index'
import v2 from './v2'

export { ClaudeMemPlugin } from './index'

// Hosts select a contract, not both: V1 reads server(), V2 reads setup().
export default { id: v2.id, server: v1.server, setup: v2.setup }
