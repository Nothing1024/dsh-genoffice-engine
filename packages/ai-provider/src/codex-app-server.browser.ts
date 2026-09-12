/** Browser stub: Codex CLI/app-server is a Node spawn path and must stay off web bundles. */
export async function streamCodexAppServer(): Promise<never> {
  throw new Error('Codex app-server is desktop-only and is not available in the browser')
}

export async function chatCodexAppServer(): Promise<never> {
  throw new Error('Codex app-server is desktop-only and is not available in the browser')
}
