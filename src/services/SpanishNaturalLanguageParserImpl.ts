import { format, isValid } from 'date-fns';
import { StatusConfig, PriorityConfig } from '../types';
import * as chrono from 'chrono-node';
import { RRule } from 'rrule';
import { INaturalLanguageParser, ParsedTaskData } from './INaturalLanguageParser';

interface RegexPattern {
    regex: RegExp;
    value: string;
}

/**
 * Parser de lenguaje natural en español.
 * Implementa los mismos patrones que el parser en inglés pero con términos en español.
 */
export class SpanishNaturalLanguageParserImpl implements INaturalLanguageParser {
    private readonly statusPatterns: RegexPattern[];
    private readonly priorityPatterns: RegexPattern[];
    private readonly defaultToScheduled: boolean;

    constructor(statusConfigs: StatusConfig[] = [], priorityConfigs: PriorityConfig[] = [], defaultToScheduled = true) {
        this.defaultToScheduled = defaultToScheduled;
        
        // Pre-compilar patrones de regex para rendimiento
        this.priorityPatterns = this.buildPriorityPatterns(priorityConfigs);
        this.statusPatterns = this.buildStatusPatterns(statusConfigs);
    }

    /**
     * Parsear entrada de lenguaje natural en datos estructurados de tarea.
     */
    public parseInput(input: string): ParsedTaskData {
        if (!input?.trim()) {
            return { title: 'Tarea sin título', tags: [], contexts: [], projects: [] };
        }

        // 1. Inicializar resultado y extraer título/detalles
        const [workingText, details] = this.extractTitleAndDetails(input);
        const result: ParsedTaskData = { 
            title: '', 
            details, 
            tags: [], 
            contexts: [], 
            projects: [] 
        };

        // 2. Procesar texto, extrayendo componentes
        let remainingText = workingText;
        
        // Extraer patrones simples primero
        remainingText = this.extractTags(remainingText, result);
        remainingText = this.extractContexts(remainingText, result);
        remainingText = this.extractProjects(remainingText, result);

        // Extraer palabras clave configuradas
        remainingText = this.extractPriority(remainingText, result);
        remainingText = this.extractStatus(remainingText, result);

        // Extraer patrones de fecha explícitos primero
        remainingText = this.extractExplicitDates(remainingText, result);

        // Extraer recurrencia ANTES del análisis general de fechas
        remainingText = this.extractRecurrence(remainingText, result);

        // Extraer estimación de tiempo
        remainingText = this.extractTimeEstimate(remainingText, result);

        // Extraer todas las fechas y horas restantes
        remainingText = this.parseDatesAndTimes(remainingText, result);

        // 3. El resto es el título
        result.title = remainingText.trim();
        
        // 4. Validar y finalizar el resultado
        return this.validateAndCleanupResult(result);
    }
    
    /**
     * Divide la cadena de entrada en la primera línea (para análisis) y el resto (para detalles).
     */
    private extractTitleAndDetails(input: string): [string, string | undefined] {
        const trimmedInput = input.trim();
        const firstLineBreak = trimmedInput.indexOf('\n');

        if (firstLineBreak !== -1) {
            const titleLine = trimmedInput.substring(0, firstLineBreak).trim();
            const details = trimmedInput.substring(firstLineBreak + 1).trim();
            return [titleLine, details];
        }
        
        return [trimmedInput, undefined];
    }

    /** Extrae #etiquetas del texto */
    private extractTags(text: string, result: ParsedTaskData): string {
        const tagMatches = text.match(/#[\w/]+/g);
        if (tagMatches) {
            result.tags.push(...tagMatches.map(tag => tag.substring(1)));
            return this.cleanupWhitespace(text.replace(/#[\w/]+/g, ''));
        }
        return text;
    }

    /** Extrae @contextos del texto */
    private extractContexts(text: string, result: ParsedTaskData): string {
        const contextMatches = text.match(/@\w+/g);
        if (contextMatches) {
            result.contexts.push(...contextMatches.map(context => context.substring(1)));
            return this.cleanupWhitespace(text.replace(/@\w+/g, ''));
        }
        return text;
    }

    /** Extrae +proyectos y +[[wikilinks]] del texto */
    private extractProjects(text: string, result: ParsedTaskData): string {
        let workingText = text;
        
        // Extraer patrones +[[wikilink]] primero (más específicos)
        const wikilinkProjectMatches = workingText.match(/\+\[\[[^\]]+\]\]/g);
        if (wikilinkProjectMatches) {
            result.projects.push(...wikilinkProjectMatches.map(project => project.slice(3, -2)));
            workingText = this.cleanupWhitespace(workingText.replace(/\+\[\[[^\]]+\]\]/g, ''));
        }
        
        // Extraer patrones +proyecto (proyectos de palabras simples)
        const projectMatches = workingText.match(/\+[\w/]+/g);
        if (projectMatches) {
            result.projects.push(...projectMatches.map(project => project.substring(1)));
            workingText = this.cleanupWhitespace(workingText.replace(/\+[\w/]+/g, ''));
        }
        
        return workingText;
    }

    /**
     * Construye patrones de prioridad en español.
     */
    private buildPriorityPatterns(configs: PriorityConfig[]): RegexPattern[] {
        if (configs.length > 0) {
            return configs.flatMap(config => [
                { regex: new RegExp(`\\b${this.escapeRegex(config.value)}\\b`, 'i'), value: config.value },
                { regex: new RegExp(`\\b${this.escapeRegex(config.label)}\\b`, 'i'), value: config.value }
            ]);
        }
        // Patrones de respaldo en español
        return [
            { regex: /\b(urgente|crítico|critico|máxima|maxima)\b/i, value: 'urgent' },
            { regex: /\b(alta|alto|importante)\b/i, value: 'high' },
            { regex: /\b(media|medio|normal)\b/i, value: 'normal' },
            { regex: /\b(baja|bajo|menor)\b/i, value: 'low' }
        ];
    }

    /** Extrae prioridad usando patrones precompilados */
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

    /**
     * Construye patrones de estado en español.
     */
    private buildStatusPatterns(configs: StatusConfig[]): RegexPattern[] {
        if (configs.length > 0) {
            return configs.flatMap(config => [
                { regex: new RegExp(`\\b${this.escapeRegex(config.value)}\\b`, 'i'), value: config.value },
                { regex: new RegExp(`\\b${this.escapeRegex(config.label)}\\b`, 'i'), value: config.value }
            ]);
        }
        // Patrones de respaldo en español
        return [
            { regex: /\b(pendiente|por hacer|abierto|abierta)\b/i, value: 'open' },
            { regex: /\b(en progreso|en proceso|haciendo)\b/i, value: 'in-progress' },
            { regex: /\b(hecho|hecha|completado|completada|terminado|terminada)\b/i, value: 'done' },
            { regex: /\b(cancelado|cancelada)\b/i, value: 'cancelled' },
            { regex: /\b(esperando|bloqueado|bloqueada|en espera)\b/i, value: 'waiting' }
        ];
    }

    /** Extrae estado usando patrones precompilados */
    private extractStatus(text: string, result: ParsedTaskData): string {
        for (const pattern of this.statusPatterns) {
            if (pattern.regex.test(text)) {
                result.status = pattern.value;
                return this.cleanupWhitespace(text.replace(pattern.regex, ''));
            }
        }
        return text;
    }

    /**
     * Extrae patrones de fecha explícitos con palabras disparadoras en español
     */
    private extractExplicitDates(text: string, result: ParsedTaskData): string {
        let workingText = text;

        const triggerPatterns = [
            { type: 'due', regex: /\b(vence\s+(el\s+)?|fecha\s+límite\s+|debe\s+estar\s+listo\s+(para\s+el\s+)?)\b/i },
            { type: 'scheduled', regex: /\b(programado\s+(para\s+)?|empezar\s+(el\s+)?|comenzar\s+(el\s+)?|trabajar\s+en\s+)\b/i }
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

    /**
     * Usa chrono-node para parsear fecha desde una posición específica
     */
    private parseChronoFromPosition(text: string): { 
        success: boolean; 
        date?: string; 
        time?: string; 
        matchedText?: string 
    } {
        try {
            const parsed = chrono.parse(text, new Date(), { forwardDate: true });
            
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

    /**
     * Extrae recurrencia del texto en español
     */
    private extractRecurrence(text: string, result: ParsedTaskData): string {
        const recurrencePatterns = [
            { regex: /\b(diario|todos los días|cada día)\b/i, rrule: 'FREQ=DAILY' },
            { regex: /\bcada (\d+) días?\b/i, rrule: 'FREQ=DAILY;INTERVAL=', captureInterval: true },
            { regex: /\b(semanal|cada semana|todas las semanas)\b/i, rrule: 'FREQ=WEEKLY' },
            { regex: /\bcada (\d+) semanas?\b/i, rrule: 'FREQ=WEEKLY;INTERVAL=', captureInterval: true },
            { regex: /\bcada (lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/i, rrule: 'FREQ=WEEKLY;BYDAY=', captureDay: true },
            { regex: /\b(mensual|cada mes|todos los meses)\b/i, rrule: 'FREQ=MONTHLY' },
            { regex: /\bcada (\d+) meses?\b/i, rrule: 'FREQ=MONTHLY;INTERVAL=', captureInterval: true },
            { regex: /\b(anual|cada año|todos los años|anualmente)\b/i, rrule: 'FREQ=YEARLY' },
            { regex: /\bcada (\d+) años?\b/i, rrule: 'FREQ=YEARLY;INTERVAL=', captureInterval: true }
        ];

        for (const pattern of recurrencePatterns) {
            const match = text.match(pattern.regex);
            if (match) {
                let rruleString = pattern.rrule;
                
                if (pattern.captureInterval && match[1]) {
                    rruleString += match[1];
                }
                
                if (pattern.captureDay && match[1]) {
                    const dayMap: Record<string, string> = {
                        'lunes': 'MO', 'martes': 'TU', 'miércoles': 'WE', 'miercoles': 'WE',
                        'jueves': 'TH', 'viernes': 'FR', 'sábado': 'SA', 'sabado': 'SA', 'domingo': 'SU'
                    };
                    rruleString += dayMap[match[1].toLowerCase()] || 'MO';
                }
                
                result.recurrence = rruleString;
                return this.cleanupWhitespace(text.replace(pattern.regex, ''));
            }
        }
        
        return text;
    }

    /**
     * Extrae estimación de tiempo en español
     */
    private extractTimeEstimate(text: string, result: ParsedTaskData): string {
        const timePatterns = [
            /\b(\d+)\s*(minutos?|mins?)\b/i,
            /\b(\d+)\s*(horas?|hrs?)\b/i,
            /\b(\d+)h\s*(\d+)m?\b/i, // formato "2h30m"
            /\b(\d+):\d{2}\b/ // formato "2:30"
        ];

        for (const pattern of timePatterns) {
            const match = text.match(pattern);
            if (match) {
                let minutes = 0;
                
                if (pattern.source.includes('horas?|hrs?')) {
                    minutes = parseInt(match[1]) * 60;
                } else if (pattern.source.includes('h\\s*')) {
                    minutes = parseInt(match[1]) * 60 + (match[2] ? parseInt(match[2]) : 0);
                } else if (pattern.source.includes(':\\d{2}')) {
                    const parts = match[0].split(':');
                    minutes = parseInt(parts[0]) * 60 + parseInt(parts[1]);
                } else {
                    minutes = parseInt(match[1]);
                }
                
                result.estimate = minutes;
                return this.cleanupWhitespace(text.replace(pattern, ''));
            }
        }
        
        return text;
    }

    /**
     * Parsea fechas y horas usando chrono-node
     */
    private parseDatesAndTimes(text: string, result: ParsedTaskData): string {
        if (!text.trim()) return text;

        let workingText = text;

        try {
            const parsed = chrono.parse(workingText, new Date(), { forwardDate: true });

            if (parsed.length > 0) {
                const chronoResult = parsed[0];
                const parsedDate = chronoResult.start.date();
                const dateText = chronoResult.text;

                if (isValid(parsedDate)) {
                    const dateString = format(parsedDate, 'yyyy-MM-dd');
                    const timeString = chronoResult.start.isCertain('hour') ? format(parsedDate, 'HH:mm') : undefined;

                    if (result.dueDate || result.scheduledDate) {
                        // Ya tenemos fechas asignadas, esta puede ser una estimación de tiempo
                    } else if (this.defaultToScheduled) {
                        result.scheduledDate = dateString;
                        if (timeString) result.scheduledTime = timeString;
                    } else {
                        result.dueDate = dateString;
                        if (timeString) result.dueTime = timeString;
                    }
                }

                workingText = this.cleanupWhitespace(workingText.replace(dateText, ''));
            }
        } catch (error) {
            console.debug('Error de análisis con chrono-node:', error);
        }

        return workingText;
    }

    /**
     * Valida y limpia el resultado final.
     */
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

    private isValidDateString = (dateString: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(dateString);
    private isValidTimeString = (timeString: string): boolean => /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeString);
    private escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    private cleanupWhitespace = (text: string): string => {
        return text.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').trim();
    };

    /**
     * Genera una vista previa amigable de los datos analizados.
     */
    public getPreviewData(parsed: ParsedTaskData): Array<{ icon: string; text: string }> {
        const parts: Array<{ icon: string; text: string }> = [];
        
        if (parsed.title) parts.push({ icon: 'edit-3', text: `"${parsed.title}"` });
        if (parsed.details) parts.push({ icon: 'file-text', text: `Detalles: "${parsed.details.substring(0, 50)}${parsed.details.length > 50 ? '...' : ''}"` });
        if (parsed.dueDate) {
            const dateStr = parsed.dueTime ? `${parsed.dueDate} a las ${parsed.dueTime}` : parsed.dueDate;
            parts.push({ icon: 'calendar', text: `Vence: ${dateStr}` });
        }
        if (parsed.scheduledDate) {
            const dateStr = parsed.scheduledTime ? `${parsed.scheduledDate} a las ${parsed.scheduledTime}` : parsed.scheduledDate;
            parts.push({ icon: 'calendar-clock', text: `Programado: ${dateStr}` });
        }
        if (parsed.priority) parts.push({ icon: 'alert-triangle', text: `Prioridad: ${parsed.priority}` });
        if (parsed.status) parts.push({ icon: 'activity', text: `Estado: ${parsed.status}` });
        if (parsed.contexts && parsed.contexts.length > 0) parts.push({ icon: 'map-pin', text: `Contextos: ${parsed.contexts.map(c => '@' + c).join(', ')}` });
        if (parsed.projects && parsed.projects.length > 0) {
            const projectDisplay = parsed.projects.map(p => {
                if (p.includes(' ') || p.includes('-') || p.match(/[A-Z]/)) {
                    return `+[[${p}]]`;
                } else {
                    return `+${p}`;
                }
            }).join(', ');
            parts.push({ icon: 'folder', text: `Proyectos: ${projectDisplay}` });
        }
        if (parsed.tags && parsed.tags.length > 0) parts.push({ icon: 'tag', text: `Etiquetas: ${parsed.tags.map(t => '#' + t).join(', ')}` });
        if (parsed.recurrence) {
            let recurrenceText = 'Recurrencia inválida';
            try {
                if (parsed.recurrence.includes('FREQ=')) {
                    recurrenceText = RRule.fromString(parsed.recurrence).toText();
                }
            } catch (error) {
                console.debug('Error parsing rrule for preview:', error);
            }
            parts.push({ icon: 'repeat', text: `Recurrencia: ${recurrenceText}` });
        }
        if (parsed.estimate) parts.push({ icon: 'clock', text: `Estimación: ${parsed.estimate} min` });
        
        return parts;
    }

    /**
     * Genera una vista previa de solo texto de los datos analizados.
     */
    public getPreviewText(parsed: ParsedTaskData): string {
        return this.getPreviewData(parsed).map(part => part.text).join(' • ');
    }
}
