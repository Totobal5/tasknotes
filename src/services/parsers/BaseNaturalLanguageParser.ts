import { StatusConfig, PriorityConfig } from '../../types';

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

export interface RegexPattern {
    regex: RegExp;
    value: string;
}

export abstract class BaseNaturalLanguageParser {
    protected readonly statusPatterns: RegexPattern[];
    protected readonly priorityPatterns: RegexPattern[];
    protected readonly defaultToScheduled: boolean;

    constructor(statusConfigs: StatusConfig[] = [], priorityConfigs: PriorityConfig[] = [], defaultToScheduled = true) {
        this.defaultToScheduled = defaultToScheduled;
        this.priorityPatterns = this.buildPriorityPatterns(priorityConfigs);
        this.statusPatterns = this.buildStatusPatterns(statusConfigs);
    }

    abstract parseInput(input: string): ParsedTaskData;
    
    protected abstract buildPriorityPatterns(configs: PriorityConfig[]): RegexPattern[];
    protected abstract buildStatusPatterns(configs: StatusConfig[]): RegexPattern[];
    protected abstract getRecurrencePatterns(): any[];
    
    // Métodos comunes que pueden ser reutilizados
    protected extractTitleAndDetails(input: string): [string, string | undefined] {
        const trimmedInput = input.trim();
        const firstLineBreak = trimmedInput.indexOf('\n');

        if (firstLineBreak !== -1) {
            const titleLine = trimmedInput.substring(0, firstLineBreak).trim();
            const details = trimmedInput.substring(firstLineBreak + 1).trim();
            return [titleLine, details];
        }
        
        return [trimmedInput, undefined];
    }

    protected extractTags(text: string, result: ParsedTaskData): string {
        const tagMatches = text.match(/#[\w/]+/g);
        if (tagMatches) {
            result.tags.push(...tagMatches.map(tag => tag.substring(1)));
            return this.cleanupWhitespace(text.replace(/#[\w/]+/g, ''));
        }
        return text;
    }

    protected extractContexts(text: string, result: ParsedTaskData): string {
        const contextMatches = text.match(/@\w+/g);
        if (contextMatches) {
            result.contexts.push(...contextMatches.map(context => context.substring(1)));
            return this.cleanupWhitespace(text.replace(/@\w+/g, ''));
        }
        return text;
    }

    protected extractProjects(text: string, result: ParsedTaskData): string {
        let workingText = text;
        
        const wikilinkProjectMatches = workingText.match(/\+\[\[[^\]]+\]\]/g);
        if (wikilinkProjectMatches) {
            result.projects.push(...wikilinkProjectMatches.map(project => project.slice(3, -2)));
            workingText = this.cleanupWhitespace(workingText.replace(/\+\[\[[^\]]+\]\]/g, ''));
        }
        
        const projectMatches = workingText.match(/\+[\w/]+/g);
        if (projectMatches) {
            result.projects.push(...projectMatches.map(project => project.substring(1)));
            workingText = this.cleanupWhitespace(workingText.replace(/\+[\w/]+/g, ''));
        }
        
        return workingText;
    }

    // Métodos utilitarios
    protected isValidDateString = (dateString: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(dateString);
    protected isValidTimeString = (timeString: string): boolean => /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeString);
    protected escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    protected cleanupWhitespace = (text: string): string => {
        return text.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').trim();
    };

    // Métodos de preview (comunes a todos los idiomas)
    public getPreviewData(parsed: ParsedTaskData): Array<{ icon: string; text: string }> {
        const parts: Array<{ icon: string; text: string }> = [];
        
        if (parsed.title) parts.push({ icon: 'edit-3', text: `"${parsed.title}"` });
        if (parsed.details) parts.push({ icon: 'file-text', text: `Details: "${parsed.details.substring(0, 50)}${parsed.details.length > 50 ? '...' : ''}"` });
        if (parsed.dueDate) {
            const dateStr = parsed.dueTime ? `${parsed.dueDate} at ${parsed.dueTime}` : parsed.dueDate;
            parts.push({ icon: 'calendar', text: `Due: ${dateStr}` });
        }
        if (parsed.scheduledDate) {
            const dateStr = parsed.scheduledTime ? `${parsed.scheduledDate} at ${parsed.scheduledTime}` : parsed.scheduledDate;
            parts.push({ icon: 'calendar-clock', text: `Scheduled: ${dateStr}` });
        }
        if (parsed.priority) parts.push({ icon: 'alert-triangle', text: `Priority: ${parsed.priority}` });
        if (parsed.status) parts.push({ icon: 'activity', text: `Status: ${parsed.status}` });
        if (parsed.contexts && parsed.contexts.length > 0) parts.push({ icon: 'map-pin', text: `Contexts: ${parsed.contexts.map(c => '@' + c).join(', ')}` });
        if (parsed.projects && parsed.projects.length > 0) {
            const projectDisplay = parsed.projects.map(p => {
                if (p.includes(' ') || p.includes('-') || p.match(/[A-Z]/)) {
                    return `+[[${p}]]`;
                } else {
                    return `+${p}`;
                }
            }).join(', ');
            parts.push({ icon: 'folder', text: `Projects: ${projectDisplay}` });
        }
        if (parsed.tags && parsed.tags.length > 0) parts.push({ icon: 'tag', text: `Tags: ${parsed.tags.map(t => '#' + t).join(', ')}` });
        if (parsed.estimate) parts.push({ icon: 'clock', text: `Estimate: ${parsed.estimate} min` });
        
        return parts;
    }

    public getPreviewText(parsed: ParsedTaskData): string {
        return this.getPreviewData(parsed).map(part => part.text).join(' • ');
    }
}
