/** Put a full canonical agent ID before a result body. */
export function formatAgentIdFirstContent(agentId: string, body: string): string {
  return `Agent ID: ${agentId}\n\n${body}`;
}
