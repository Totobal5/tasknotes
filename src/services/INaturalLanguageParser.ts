import { StatusConfig, PriorityConfig } from '../types';

export interface ParsedTaskData {
    title: string;
    details?: string;
    dueDate?: string;
    scheduledDate?: string;
    dueTime?: string;
    scheduledTime?: string;
    priority?: string;
    status?: string;
    tags: string[];
    contexts: string[];
    projects: string[];
    recurrence?: string;
    estimate?: number; // in minutes
    isCompleted?: boolean;
}

/**
 * Interface que todos los parsers de lenguaje natural deben implementar
 */
export interface INaturalLanguageParser {
    parseInput(input: string): ParsedTaskData;
    getPreviewData(parsed: ParsedTaskData): Array<{ icon: string; text: string }>;
    getPreviewText(parsed: ParsedTaskData): string;
}
