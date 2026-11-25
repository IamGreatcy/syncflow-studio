import { type ContentFormat, type MasterBrief, type MediaProbeInfo, type MetadataTemplate, type PlatformMetadataMap } from '@clipflow/shared';
import type { AppSettingsFull } from '../db/database.js';
export declare function inferYouTubeCategoryId(brief: MasterBrief, tpl?: MetadataTemplate): string;
export declare function generateMetadataDeterministic(params: {
    brief: MasterBrief;
    formats: ContentFormat[];
    templates: MetadataTemplate[];
    probe?: MediaProbeInfo;
}): PlatformMetadataMap;
export declare function generateMetadataWithAI(params: {
    brief: MasterBrief;
    formats: ContentFormat[];
    templates: MetadataTemplate[];
    probe?: MediaProbeInfo;
    settings: AppSettingsFull;
}): Promise<{
    metadata: PlatformMetadataMap;
    engineUsed: 'AI_GEMINI' | 'AI_OPENAI' | 'DETERMINISTIC';
    warning?: string;
}>;
//# sourceMappingURL=metadata-engine.d.ts.map