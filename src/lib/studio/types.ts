export type StudioProfile = {
  frameworks: string[]; languages: string[]; manager: string | null; dependencies: string[];
  scripts: string[]; paths: string[]; sampled: string[]; routes: string[]; config: string[]; envReferences: string[];
  inventory?: { entryPoints: string[]; components: string[]; styles: string[]; assets: string[]; platformSignals: string[] };
  findings: { kind: 'observed' | 'potential' | 'manual'; path: string; message: string; check?: 'literal_viewport' | 'literal_title' }[];
  limitations: string[];
};
export type StudioPlan = { title: string; objective: string; reason: string; outcome: string; path: string;
  risk: 'low' | 'medium'; complexity: 'small' | 'medium'; criteria: string; evidence?: { path: string; basis: string }; tools: string[]; dependencies: string[] };
export type StudioChange = { path: string; before: string; after: string; explanation: string; sourceBlob: string; proposedMessage: string };
export type StudioRepository = { owner: string; name: string; visibility: string; defaultBranch: string; login: string; description: string | null };

export const studioJobType = 'website_studio_draft';
export const studioToolName = 'website_studio_draft';
