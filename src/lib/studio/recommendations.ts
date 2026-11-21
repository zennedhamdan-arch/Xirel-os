import type { StudioPlan, StudioProfile } from './types';

type Suggestion = Omit<StudioPlan, 'evidence' | 'tools' | 'dependencies'>;
/** Deterministic suggestions, not diagnoses or automatically approved tasks. */
export function studioRecommendations(profile: StudioProfile): Suggestion[] {
  return profile.findings.flatMap((finding): Suggestion[] => {
    if (finding.kind !== 'potential' || !profile.sampled.includes(finding.path)) return [];
    const common = { path: finding.path, reason: finding.message, risk: 'low' as const, complexity: 'small' as const };
    if (finding.check === 'literal_viewport') return [{ ...common, title: 'Review mobile viewport',
      objective: 'Inspect the pinned HTML head and prepare a viewport meta tag if the rendered application does not already provide one. Preserve the rest of the page.',
      outcome: 'The page can render to its device width without a duplicate viewport directive.',
      criteria: 'Inspect the rendered head and layout at a narrow viewport. Confirm exactly one suitable viewport declaration.' }];
    if (finding.check === 'literal_title') return [{ ...common, title: 'Review page title',
      objective: 'Inspect the pinned HTML head and prepare a concise, accurate page title if no title is already injected at runtime. Preserve the rest of the page.',
      outcome: 'The page has one descriptive title consistent with the content.',
      criteria: 'Confirm exactly one title in the rendered head and check it accurately describes the page.' }];
    return [];
  });
}
