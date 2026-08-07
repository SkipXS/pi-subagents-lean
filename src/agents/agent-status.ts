/**
 * Compatibility shim for the AgentStatus tool.
 *
 * The control-tool implementation lives with AgentContinue and StopAgent;
 * this path remains available for existing internal and external imports.
 */
export { executeAgentStatusTool } from "./agent-control-execution.js";
