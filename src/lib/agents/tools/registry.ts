import 'server-only';
import type { AiToolDefinition } from '@/lib/ai/types';
import type { ToolDefinition } from './types';
import { calculatorTool } from './calculator';
import { getCurrentDatetimeTool } from './datetime';
import {
  createProjectTool,
  listProjectsTool,
  resolveProjectTool,
  updateProjectTool,
  addProjectMemoryTool,
} from './projects';

import { githubScope, webSearchKey } from '@/lib/connectors/read-only';
import { githubReadTool, webSearchTool } from './external';

const TOOL_REGISTRY: Record<string, ToolDefinition<any, any>> = {
  [githubReadTool.name]: githubReadTool,
  [webSearchTool.name]: webSearchTool,
  [calculatorTool.name]: calculatorTool,
  [getCurrentDatetimeTool.name]: getCurrentDatetimeTool,
  [createProjectTool.name]: createProjectTool,
  [listProjectsTool.name]: listProjectsTool,
  [resolveProjectTool.name]: resolveProjectTool,
  [updateProjectTool.name]: updateProjectTool,
  [addProjectMemoryTool.name]: addProjectMemoryTool,
};

export function getTool(name: string): ToolDefinition<any, any> | undefined {
  return TOOL_REGISTRY[name];
}

export function getAllTools(workspaceId?: string): ToolDefinition<any, any>[] {
  return Object.values(TOOL_REGISTRY).filter(tool => {
    if (tool === githubReadTool) return !!workspaceId && !!githubScope(workspaceId);
    if (tool === webSearchTool) return !!workspaceId && !!webSearchKey(workspaceId);
    return true;
  });
}

/** Converts registered tools to the provider-agnostic wire shape AiRequest.tools expects. */
export function toAiToolDefinitions(tools: ToolDefinition<any, any>[]): AiToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputJsonSchema,
  }));
}
