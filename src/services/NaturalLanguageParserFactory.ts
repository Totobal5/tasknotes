import { StatusConfig, PriorityConfig } from '../types';
import { INaturalLanguageParser } from './INaturalLanguageParser';
import { NaturalLanguageParser } from './NaturalLanguageParser';
import { SpanishNaturalLanguageParserImpl } from './SpanishNaturalLanguageParserImpl';

export type SupportedLanguage = 'en' | 'es';

/**
 * Factory que crea el parser de lenguaje natural apropiado basado en el idioma detectado
 */
export class NaturalLanguageParserFactory {
    private static instance: NaturalLanguageParserFactory;
    private currentParser: INaturalLanguageParser | null = null;
    private detectedLanguage: SupportedLanguage = 'en';

    private constructor() {}

    public static getInstance(): NaturalLanguageParserFactory {
        if (!NaturalLanguageParserFactory.instance) {
            NaturalLanguageParserFactory.instance = new NaturalLanguageParserFactory();
        }
        return NaturalLanguageParserFactory.instance;
    }

    /**
     * Detecta el idioma del usuario basado en diferentes fuentes
     */
    public detectLanguage(): SupportedLanguage {
        let detectedLang: string = 'en';

        // 1. Intentar obtener el idioma desde Obsidian si está disponible
        try {
            // @ts-ignore - Obsidian might have language settings
            if (window.app?.vault?.adapter?.getBasePath) {
                const obsidianLang = localStorage.getItem('language');
                if (obsidianLang) {
                    detectedLang = obsidianLang;
                }
            }
        } catch (error) {
            console.debug('Could not get Obsidian language setting:', error);
        }

        // 2. Fallback al idioma del navegador
        if (detectedLang === 'en') {
            detectedLang = navigator.language || navigator.languages?.[0] || 'en';
        }

        // 3. Normalizar el código de idioma
        const langCode = this.normalizeLanguageCode(detectedLang);
        
        console.log(`Language detected: ${detectedLang} -> normalized to: ${langCode}`);
        
        this.detectedLanguage = langCode;
        return langCode;
    }

    /**
     * Normaliza los códigos de idioma a los soportados
     */
    private normalizeLanguageCode(lang: string): SupportedLanguage {
        const lowerLang = lang.toLowerCase();
        
        // Español y sus variantes
        if (lowerLang.startsWith('es') || 
            lowerLang.includes('spanish') || 
            lowerLang.includes('español') ||
            lowerLang.includes('spain') ||
            lowerLang.includes('mexico') ||
            lowerLang.includes('argentina') ||
            lowerLang.includes('colombia')) {
            return 'es';
        }
        
        // Por defecto, inglés
        return 'en';
    }

    /**
     * Crea el parser apropiado para el idioma detectado
     */
    public createParser(
        statusConfigs: StatusConfig[] = [], 
        priorityConfigs: PriorityConfig[] = [], 
        defaultToScheduled = true,
        forceLanguage?: SupportedLanguage
    ): INaturalLanguageParser {
        const language = forceLanguage || this.detectLanguage();
        
        switch (language) {
            case 'es':
                this.currentParser = new SpanishNaturalLanguageParserImpl(statusConfigs, priorityConfigs, defaultToScheduled);
                break;
            case 'en':
            default:
                this.currentParser = new NaturalLanguageParser(statusConfigs, priorityConfigs, defaultToScheduled);
                break;
        }

        console.log(`Created ${language} natural language parser`);
        return this.currentParser;
    }

    /**
     * Obtiene el parser actual (lazy loading)
     */
    public getCurrentParser(
        statusConfigs: StatusConfig[] = [], 
        priorityConfigs: PriorityConfig[] = [], 
        defaultToScheduled = true
    ): INaturalLanguageParser {
        if (!this.currentParser) {
            return this.createParser(statusConfigs, priorityConfigs, defaultToScheduled);
        }
        return this.currentParser;
    }

    /**
     * Obtiene el idioma detectado
     */
    public getDetectedLanguage(): SupportedLanguage {
        return this.detectedLanguage;
    }

    /**
     * Fuerza la recreación del parser con un idioma específico
     */
    public setLanguage(
        language: SupportedLanguage,
        statusConfigs: StatusConfig[] = [], 
        priorityConfigs: PriorityConfig[] = [], 
        defaultToScheduled = true
    ): INaturalLanguageParser {
        this.detectedLanguage = language;
        return this.createParser(statusConfigs, priorityConfigs, defaultToScheduled, language);
    }

    /**
     * Obtiene la lista de idiomas soportados
     */
    public getSupportedLanguages(): Array<{ code: SupportedLanguage; name: string; nativeName: string }> {
        return [
            { code: 'en', name: 'English', nativeName: 'English' },
            { code: 'es', name: 'Spanish', nativeName: 'Español' }
        ];
    }
}
