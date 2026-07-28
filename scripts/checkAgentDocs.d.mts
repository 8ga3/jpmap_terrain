export interface AgentPair {
    name: string;
    canonical: string;
}

export interface MirrorCheckInput extends AgentPair {
    mirrorContent: string;
    canonicalContent: string;
}

export declare const AGENT_PAIRS: AgentPair[];

export declare const MAX_MIRROR_BODY_LINES: number;

export declare function parseFrontMatter(content: string): Record<string, string> | null;

export declare function bodyLines(content: string): string[];

export declare function relativeLinks(content: string): string[];

export declare function checkMirror(input: MirrorCheckInput): string[];

export declare function checkLinks(
    filePath: string,
    content: string,
    exists: (path: string) => boolean,
): string[];
