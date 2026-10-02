/** What holds the port when `./run` looks at it. */
export type Holder = 'host server' | 'container server' | 'nothing'

export interface RunPortCase {
  name: string
  scenario: 'smoke' | 'docs'
  holder: Holder
  /** Each must appear in the output. `{port}` and `{container}` are filled in by the runner. */
  says: string[]
  /** None may appear. */
  never: string[]
}

export const runPortCases: RunPortCase[] = [
  {
    name: 'smoke, with a non-engine server on the host',
    scenario: 'smoke',
    holder: 'host server',
    says: ['Port {port} is answering, but it is not this engine.'],
    never: [' — it is '],
  },
  {
    name: 'docs, with a non-engine server on the host',
    scenario: 'docs',
    holder: 'host server',
    says: ['Port {port} is answering, but it is not this engine.'],
    never: [' — it is '],
  },
  {
    name: 'smoke, with a non-engine server in a container',
    scenario: 'smoke',
    holder: 'container server',
    says: ['Port {port} is answering, but it is not this engine — it is {container}.'],
    never: [],
  },
  {
    name: 'smoke, with nothing listening',
    scenario: 'smoke',
    holder: 'nothing',
    says: ['Nothing is answering on http://localhost:{port}.'],
    never: [],
  },
]
