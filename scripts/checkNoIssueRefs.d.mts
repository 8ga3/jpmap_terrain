export interface IssueRefViolation {
    line: number;
    name: string;
    text: string;
}

export interface IssueRefFileViolation extends IssueRefViolation {
    file: string;
}

export declare const PATTERNS: { name: string; regex: RegExp }[];

export declare function findViolations(content: string): IssueRefViolation[];

export declare function listTrackedFiles(): string[];

export declare function collectAllViolations(
    files: string[],
    readFile?: (path: string, encoding: string) => string,
): IssueRefFileViolation[];
