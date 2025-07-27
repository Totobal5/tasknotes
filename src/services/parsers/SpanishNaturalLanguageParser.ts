import { format, isValid } from 'date-fns';
import { StatusConfig, PriorityConfig } from '../../types';
import * as chrono from 'chrono-node';
import { RRule } from 'rrule';
import { BaseNaturalLanguageParser, ParsedTaskData, RegexPattern } from './BaseNaturalLanguageParser';

/**
 * Parser de lenguaje natural específico para español
 */
export class SpanishNaturalLanguageParser extends BaseNaturalLanguageParser {
    
    constructor(statusConfigs: StatusConfig[] = [], priorityConfigs: PriorityConfig[] = [], defaultToScheduled = true) {
        super(statusConfigs, priorityConfigs, defaultToScheduled);
    }

    public parseInput(input: string): ParsedTaskData {
        const result: ParsedTaskData = {
            title: '',
            tags: [],
            contexts: [],
            projects: [],
        };

        const [workingText, details] = this.extractTitleAndDetails(input);
        if (details) {
            result.details = details;
        }

        let remainingText = workingText;
        
        remainingText = this.extractTags(remainingText, result);
        remainingText = this.extractContexts(remainingText, result);
        remainingText = this.extractProjects(remainingText, result);
        remainingText = this.extractPriority(remainingText, result);
        remainingText = this.extractStatus(remainingText, result);
        remainingText = this.extractExplicitDates(remainingText, result);
        remainingText = this.extractRecurrence(remainingText, result);
        remainingText = this.extractTimeEstimate(remainingText, result);
        remainingText = this.parseDatesAndTimes(remainingText, result);

        result.title = remainingText.trim();
        
        return this.validateAndCleanupResult(result);
    }

    protected buildPriorityPatterns(configs: PriorityConfig[]): RegexPattern[] {
        if (configs.length > 0) {
            return configs.flatMap(config => [
                { regex: new RegExp(`\\b${this.escapeRegex(config.value)}\\b`, 'i'), value: config.value },
                { regex: new RegExp(`\\b${this.escapeRegex(config.label)}\\b`, 'i'), value: config.value }
            ]);
        }
        // Patrones en español
        return [
            { regex: /\b(urgente|crítico|crítica|máxima|muy alta)\b/i, value: 'urgent' },
            { regex: /\b(alta|importante)\b/i, value: 'high' },
            { regex: /\b(media|normal|regular)\b/i, value: 'normal' },
            { regex: /\b(baja|menor|mínima)\b/i, value: 'low' }
        ];
    }

    protected buildStatusPatterns(configs: StatusConfig[]): RegexPattern[] {
        if (configs.length > 0) {
            return configs.flatMap(config => [
                { regex: new RegExp(`\\b${this.escapeRegex(config.value)}\\b`, 'i'), value: config.value },
                { regex: new RegExp(`\\b${this.escapeRegex(config.label)}\\b`, 'i'), value: config.value }
            ]);
        }
        // Patrones en español
        return [
            { regex: /\b(pendiente|por hacer|abierto|todo)\b/i, value: 'open' },
            { regex: /\b(en progreso|en proceso|haciendo|trabajando)\b/i, value: 'in-progress' },
            { regex: /\b(hecho|terminado|completado|finalizado)\b/i, value: 'done' },
            { regex: /\b(cancelado|cancelada)\b/i, value: 'cancelled' },
            { regex: /\b(esperando|bloqueado|bloqueada|en espera)\b/i, value: 'waiting' }
        ];
    }

    protected getRecurrencePatterns(): any[] {
        return [
            // "cada [ordinal] [día de la semana]" (ej: "cada segundo lunes")
            {
                regex: /\bcada\s+(primer|segundo|tercer|cuarto|último)\s+(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b/i,
                handler: (match: RegExpMatchArray) => {
                    const ordinal = match[1].toLowerCase();
                    const dayName = match[2].toLowerCase();
                    const dayMap: Record<string, string> = {
                        'lunes': 'MO', 'martes': 'TU', 'miércoles': 'WE', 
                        'jueves': 'TH', 'viernes': 'FR', 'sábado': 'SA', 'domingo': 'SU'
                    };
                    const rruleDay = dayMap[dayName];
                    const positionMap: Record<string, number> = { 
                        'primer': 1, 'segundo': 2, 'tercer': 3, 'cuarto': 4, 'último': -1 
                    };
                    const position = positionMap[ordinal] || 1;
                    return `FREQ=MONTHLY;BYDAY=${rruleDay};BYSETPOS=${position}`;
                }
            },
            // "cada [N] período" (ej: "cada 3 días")
            {
                regex: /\bcada\s+(\d+)\s+(días?|semanas?|meses?|años?)\b/i,
                handler: (match: RegExpMatchArray) => {
                    const interval = parseInt(match[1]);
                    const period = match[2].replace(/s$/, '').toLowerCase();
                    const freqMap: Record<string, string> = {
                        'día': 'DAILY', 'semana': 'WEEKLY', 
                        'mes': 'MONTHLY', 'año': 'YEARLY'
                    };
                    return `FREQ=${freqMap[period]};INTERVAL=${interval}`;
                }
            },
            // "cada [día de la semana]" (ej: "cada lunes")
            {
                regex: /\bcada\s+(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b/i,
                handler: (match: RegExpMatchArray) => {
                    const dayMap: Record<string, string> = {
                        'lunes': 'MO', 'martes': 'TU', 'miércoles': 'WE', 
                        'jueves': 'TH', 'viernes': 'FR', 'sábado': 'SA', 'domingo': 'SU'
                    };
                    const day = dayMap[match[1].toLowerCase()];
                    return `FREQ=WEEKLY;BYDAY=${day}`;
                }
            },
            // Días de la semana en plural (ej: "lunes", "martes")
            {
                regex: /\b(lunes|martes|miércoles|jueves|viernes|sábados|domingos)\b/i,
                handler: (match: RegExpMatchArray) => {
                    const dayMap: Record<string, string> = {
                        'lunes': 'MO', 'martes': 'TU', 'miércoles': 'WE', 
                        'jueves': 'TH', 'viernes': 'FR', 'sábados': 'SA', 'domingos': 'SU'
                    };
                    const day = dayMap[match[1].toLowerCase()];
                    return `FREQ=WEEKLY;BYDAY=${day}`;
                }
            },
            // Frecuencias generales
            { regex: /\b(diario|diariamente|cada día|todos los días)\b/i, handler: () => 'FREQ=DAILY' },
            { regex: /\b(semanal|semanalmente|cada semana|todas las semanas)\b/i, handler: () => 'FREQ=WEEKLY' },
            { regex: /\b(mensual|mensualmente|cada mes|todos los meses)\b/i, handler: () => 'FREQ=MONTHLY' },
            { regex: /\b(anual|anualmente|cada año|todos los años)\b/i, handler: () => 'FREQ=YEARLY' }
        ];
    }

    private extractPriority(text: string, result: ParsedTaskData): string {
        let foundMatch: { pattern: RegexPattern; index: number } | null = null;
        
        for (const pattern of this.priorityPatterns) {
            const match = text.match(pattern.regex);
            if (match && match.index !== undefined) {
                if (!foundMatch || match.index < foundMatch.index) {
                    foundMatch = { pattern, index: match.index };
                }
            }
        }
        
        if (foundMatch) {
            result.priority = foundMatch.pattern.value;
            return this.cleanupWhitespace(text.replace(foundMatch.pattern.regex, ''));
        }
        
        return text;
    }

    private extractStatus(text: string, result: ParsedTaskData): string {
        for (const pattern of this.statusPatterns) {
            if (pattern.regex.test(text)) {
                result.status = pattern.value;
                return this.cleanupWhitespace(text.replace(pattern.regex, ''));
            }
        }
        return text;
    }

    private extractExplicitDates(text: string, result: ParsedTaskData): string {
        let workingText = text;

        const triggerPatterns = [
            { type: 'due', regex: /\b(vence\s+(?:el\s+)?|fecha\s+límite\s+(?:el\s+)?|debe\s+(?:estar\s+)?(?:terminado|listo)\s+(?:el\s+)?(?:para\s+el\s+)?)/i },
            { type: 'scheduled', regex: /\b(programado\s+(?:para\s+(?:el\s+)?)?|empezar\s+(?:el\s+)?|comenzar\s+(?:el\s+)?|trabajar\s+(?:el\s+)?)/i }
        ];

        for (const triggerPattern of triggerPatterns) {
            const match = workingText.match(triggerPattern.regex);
            if (match) {
                const triggerEnd = match.index! + match[0].length;
                const remainingText = workingText.substring(triggerEnd);
                
                const chronoParsed = this.parseChronoFromPosition(remainingText);
                
                if (chronoParsed.success) {
                    if (triggerPattern.type === 'due') {
                        result.dueDate = chronoParsed.date;
                        if (chronoParsed.time) {
                            result.dueTime = chronoParsed.time;
                        }
                    } else {
                        result.scheduledDate = chronoParsed.date;
                        if (chronoParsed.time) {
                            result.scheduledTime = chronoParsed.time;
                        }
                    }
                    
                    workingText = workingText.replace(triggerPattern.regex, '');
                    if (chronoParsed.matchedText) {
                        workingText = workingText.replace(chronoParsed.matchedText, '');
                    }
                    workingText = this.cleanupWhitespace(workingText);
                    break;
                }
            }
        }

        return workingText;
    }

    private parseChronoFromPosition(text: string): { 
        success: boolean; 
        date?: string; 
        time?: string; 
        matchedText?: string 
    } {
        try {
            // Configurar chrono para español
            const customChrono = chrono.casual.clone();
            // Aquí podrías agregar configuraciones específicas para español si fuera necesario
            
            const parsed = customChrono.parse(text, new Date(), { forwardDate: true });
            
            if (parsed.length > 0) {
                const firstMatch = parsed[0];
                
                if (firstMatch.index <= 3) {
                    const parsedDate = firstMatch.start.date();
                    if (isValid(parsedDate)) {
                        const result: any = {
                            success: true,
                            date: format(parsedDate, 'yyyy-MM-dd'),
                            matchedText: firstMatch.text
                        };
                        
                        if (firstMatch.start.isCertain('hour')) {
                            result.time = format(parsedDate, 'HH:mm');
                        }
                        
                        return result;
                    }
                }
            }
        } catch (error) {
            console.debug('Error parsing date with chrono:', error);
        }
        
        return { success: false };
    }

    private extractRecurrence(text: string, result: ParsedTaskData): string {
        const recurrencePatterns = this.getRecurrencePatterns();

        for (const pattern of recurrencePatterns) {
            const match = text.match(pattern.regex);
            if (match) {
                const rruleString = pattern.handler(match);
                if (this.isValidRRuleString(rruleString)) {
                    result.recurrence = rruleString;
                    return this.cleanupWhitespace(text.replace(pattern.regex, ''));
                }
            }
        }

        return text;
    }

    private isValidRRuleString(rruleString: string): boolean {
        if (rruleString.includes('BYDAY=undefined') || rruleString.includes('BYDAY=;') || rruleString.includes('BYDAY=')) {
            const byDayMatch = rruleString.match(/BYDAY=([^;]*)/);
            if (byDayMatch && (!byDayMatch[1] || byDayMatch[1] === 'undefined' || byDayMatch[1].trim() === '')) {
                return false;
            }
        }
        
        if (!rruleString.includes('FREQ=')) {
            return false;
        }
        
        return true;
    }

    private extractTimeEstimate(text: string, result: ParsedTaskData): string {
        const patterns = [
            // Formato combinado: 1h30m
            { regex: /\b(\d+)h\s*(\d+)m\b/i, handler: (m: RegExpMatchArray) => parseInt(m[1]) * 60 + parseInt(m[2]) },
            // Horas: 1hr, 2 horas, 3h
            { regex: /\b(\d+)\s*(?:hr|hrs|hora|horas|h)\b/i, handler: (m: RegExpMatchArray) => parseInt(m[1]) * 60 },
            // Minutos: 30min, 45 m, 15 minutos
            { regex: /\b(\d+)\s*(?:min|mins|minuto|minutos|m)\b/i, handler: (m: RegExpMatchArray) => parseInt(m[1]) },
        ];
        
        let workingText = text;
        let totalEstimate = 0;

        for (const pattern of patterns) {
            const match = workingText.match(pattern.regex);
            if (match) {
                totalEstimate += pattern.handler(match);
                workingText = this.cleanupWhitespace(workingText.replace(pattern.regex, ''));
            }
        }

        if (totalEstimate > 0) {
            result.estimate = totalEstimate;
        }

        return workingText;
    }

    private parseDatesAndTimes(text: string, result: ParsedTaskData): string {
        let workingText = text;
        try {
            // Configurar chrono para español si es necesario
            const customChrono = chrono.casual.clone();
            const parsedResults = customChrono.parse(text, new Date(), { forwardDate: true });
            
            if (parsedResults.length === 0) {
                return text;
            }
            
            const primaryMatch = parsedResults[0];
            const dateText = primaryMatch.text;
            
            const startDate = primaryMatch.start.date();
            const endDate = primaryMatch.end?.date();

            let isDue = /vence|límite|para\s+el/i.test(primaryMatch.text);
            let isScheduled = /programado|empezar|comenzar|desde/i.test(primaryMatch.text);
            
            if (endDate && isValid(endDate) && endDate.getTime() !== startDate.getTime()) {
                result.scheduledDate = format(startDate, 'yyyy-MM-dd');
                if (primaryMatch.start.isCertain('hour')) {
                    result.scheduledTime = format(startDate, 'HH:mm');
                }
                result.dueDate = format(endDate, 'yyyy-MM-dd');
                if (primaryMatch.end?.isCertain('hour')) {
                    result.dueTime = format(endDate, 'HH:mm');
                }
            } 
            else if (isValid(startDate)) {
                const dateString = format(startDate, 'yyyy-MM-dd');
                const timeString = primaryMatch.start.isCertain('hour') ? format(startDate, 'HH:mm') : undefined;

                if (isDue && !isScheduled) {
                    result.dueDate = dateString;
                    result.dueTime = timeString;
                } else if (isScheduled && !isDue) {
                    result.scheduledDate = dateString;
                    result.scheduledTime = timeString;
                } else if (this.defaultToScheduled) {
                    result.scheduledDate = dateString;
                    result.scheduledTime = timeString;
                } else {
                    result.dueDate = dateString;
                    result.dueTime = timeString;
                }
            }

            workingText = this.cleanupWhitespace(workingText.replace(dateText, ''));

        } catch (error) {
            console.debug('Chrono-node parsing failed:', error);
        }

        return workingText;
    }

    private validateAndCleanupResult(result: ParsedTaskData): ParsedTaskData {
        if (!result.title.trim()) {
            result.title = 'Tarea sin título';
        }

        result.tags = [...new Set(result.tags.filter(Boolean))];
        result.contexts = [...new Set(result.contexts.filter(Boolean))];
        result.projects = [...new Set(result.projects.filter(Boolean))];

        if (result.dueDate && !this.isValidDateString(result.dueDate)) delete result.dueDate;
        if (result.scheduledDate && !this.isValidDateString(result.scheduledDate)) delete result.scheduledDate;
        if (result.dueTime && !this.isValidTimeString(result.dueTime)) delete result.dueTime;
        if (result.scheduledTime && !this.isValidTimeString(result.scheduledTime)) delete result.scheduledTime;
        
        return result;
    }
}
