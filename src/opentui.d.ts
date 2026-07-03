declare module '@opentui/solid' {
  export function createElement(kind: string): unknown
  export function setProp(element: unknown, name: string, value: unknown): void
  export function insert(parent: unknown, child: unknown): void
}
