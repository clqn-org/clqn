// An absolute loader URL also works when a CLI test runs from a temporary working directory.
export const sourceNodeArgs = ['--conditions=clqn-source', '--import', import.meta.resolve('tsx')];
