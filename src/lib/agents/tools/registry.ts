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
import { githubReadTool, webSearchTool, githubPublishTool, githubInspectTool, webPageTool } from './external';

import { projectFileTool, projectEditTool, projectCommandTool } from './worktree';
import { namespaceRunnerEnabled } from '@/lib/execution/sandbox';
import { projectScope } from '@/lib/execution/files';
import { githubWriteScope } from '@/lib/connectors/github-changes';
import { githubHubTool } from './github-hub';
import { hubAiEnabled } from '@/lib/github-hub/store';
import { allowedResearchOrigins } from '@/lib/connectors/research';

const TOOL_REGISTRY: Record<string, ToolDefinition<any, any>> = {
  [githubHubTool.name]: githubHubTool,
  [githubReadTool.name]: githubReadTool,
  [githubInspectTool.name]: githubInspectTool,
  [githubPublishTool.name]: githubPublishTool,
  [projectFileTool.name]: projectFileTool,
  [projectEditTool.name]: projectEditTool,
  [projectCommandTool.name]: projectCommandTool,
  [webPageTool.name]: webPageTool,
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

export function getAllTools(workspaceId?: string, projectId?: string | null, durable = false): ToolDefinition<any, any>[] {
  return Object.values(TOOL_REGISTRY).filter(tool => {
    if (tool === githubHubTool) return !!workspaceId && hubAiEnabled();
    if (tool === githubPublishTool) return durable && !!githubWriteScope(workspaceId, projectId);
    if (tool === projectFileTool || tool === projectEditTool) return durable && !!projectScope(workspaceId, projectId);
    if (tool === projectCommandTool) return durable && !!projectScope(workspaceId, projectId) && namespaceRunnerEnabled();
    if (tool === webPageTool) return allowedResearchOrigins(workspaceId).size > 0;
    if (tool === githubReadTool || tool === githubInspectTool) return !!workspaceId && !!githubScope(workspaceId);
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
