import { StatusConfig, PriorityConfig } from '../types';
import { BaseNaturalLanguageParser, RegexPattern } from './parsers/BaseNaturalLanguageParser';

/**
 * English natural language parser implementation.
 */
export class EnglishNaturalLanguageParser extends BaseNaturalLanguageParser {

    constructor(statusConfigs: StatusConfig[] = [], priorityConfigs: PriorityConfig[] = [], defaultToScheduled = true) {
        super(statusConfigs, priorityConfigs, defaultToScheduled);
    }

    /**
     * English-specific recurrence patterns
     */
    protected getRecurrencePatterns(): Array<{ pattern: RegExp; rruleFreq: string; interval?: number }> {
        return [
            { pattern: /\b(daily|every day)\b/i, rruleFreq: 'DAILY' },
            { pattern: /\bevery (\d+) days?\b/i, rruleFreq: 'DAILY', interval: 1 }, // Will be replaced by capture group
            { pattern: /\b(weekly|every week)\b/i, rruleFreq: 'WEEKLY' },
            { pattern: /\bevery (\d+) weeks?\b/i, rruleFreq: 'WEEKLY', interval: 1 }, // Will be replaced by capture group
            { pattern: /\bevery (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, rruleFreq: 'WEEKLY' },
            { pattern: /\b(monthly|every month)\b/i, rruleFreq: 'MONTHLY' },
            { pattern: /\bevery (\d+) months?\b/i, rruleFreq: 'MONTHLY', interval: 1 }, // Will be replaced by capture group
            { pattern: /\b(yearly|annually|every year)\b/i, rruleFreq: 'YEARLY' },
            { pattern: /\bevery (\d+) years?\b/i, rruleFreq: 'YEARLY', interval: 1 }, // Will be replaced by capture group
        ];
    }

    /**
     * English-specific date trigger patterns
     */
    protected getDateTriggerPatterns(): Array<{ regex: RegExp; type: 'due' | 'scheduled' }> {
        return [
            { regex: /\bdue\s+(on\s+|by\s+)?/i, type: 'due' },
            { regex: /\bby\s+/i, type: 'due' },
            { regex: /\bdeadline\s+/i, type: 'due' },
            { regex: /\bscheduled\s+(for\s+|on\s+)?/i, type: 'scheduled' },
            { regex: /\bon\s+/i, type: 'scheduled' },
            { regex: /\bat\s+/i, type: 'scheduled' },
            { regex: /\bstart\s+(on\s+)?/i, type: 'scheduled' },
        ];
    }

    /**
     * English-specific priority patterns
     */
    protected buildPriorityPatterns(configs: PriorityConfig[]): RegexPattern[] {
        if (configs.length > 0) {
            return configs.flatMap(config => [
                { regex: new RegExp(`\\b${this.escapeRegex(config.value)}\\b`, 'i'), value: config.value },
                { regex: new RegExp(`\\b${this.escapeRegex(config.label)}\\b`, 'i'), value: config.value }
            ]);
        }
        // English fallback patterns - order matters, most specific first
        return [
            { regex: /\b(urgent|critical|highest)\b/i, value: 'urgent' },
            { regex: /\b(high)\b/i, value: 'high' },
            { regex: /\b(important)\b/i, value: 'high' },
            { regex: /\b(medium|normal)\b/i, value: 'normal' },
            { regex: /\b(low|minor)\b/i, value: 'low' }
        ];
    }

    /**
     * English-specific status patterns
     */
    protected buildStatusPatterns(configs: StatusConfig[]): RegexPattern[] {
        if (configs.length > 0) {
            return configs.flatMap(config => [
                { regex: new RegExp(`\\b${this.escapeRegex(config.value)}\\b`, 'i'), value: config.value },
                { regex: new RegExp(`\\b${this.escapeRegex(config.label)}\\b`, 'i'), value: config.value }
            ]);
        }
        // English fallback patterns
        return [
            { regex: /\b(todo|to do|open)\b/i, value: 'open' },
            { regex: /\b(in progress|in-progress|doing)\b/i, value: 'in-progress' },
            { regex: /\b(done|completed|finished)\b/i, value: 'done' },
            { regex: /\b(cancelled|canceled)\b/i, value: 'cancelled' },
            { regex: /\b(waiting|blocked|on hold)\b/i, value: 'waiting' }
        ];
    }
}
