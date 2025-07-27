// src/modals/TaskCreationModal.ts - INTEGRACIÓN MULTILINGÜE

import { App, Notice, setIcon, AbstractInputSuggest } from 'obsidian';
import TaskNotesPlugin from '../main';
import { TaskModal } from './TaskModal';
import { TaskInfo, TaskCreationData } from '../types';
import { getCurrentTimestamp } from '../utils/dateUtils';
import { generateTaskFilename, FilenameContext } from '../utils/filenameGenerator';
import { calculateDefaultDate } from '../utils/helpers';
import { combineDateAndTime } from '../utils/dateUtils';

// CAMBIO 1: Importar la interfaz común y el factory en lugar del parser directo
import { INaturalLanguageParser, ParsedTaskData as NLParsedTaskData } from '../services/INaturalLanguageParser';
import { NaturalLanguageParserFactory } from '../services/NaturalLanguageParserFactory';

// ... resto de imports y código existente ...

export class TaskCreationModal extends TaskModal {
    private options: TaskCreationOptions;
    
    // CAMBIO 2: Cambiar el tipo de nlParser a la interfaz común
    private nlParser: INaturalLanguageParser;
    
    private nlInput: HTMLTextAreaElement;
    private nlPreviewContainer: HTMLElement;
    private nlButtonContainer: HTMLElement;
    private nlpSuggest: NLPSuggest;

    constructor(app: App, plugin: TaskNotesPlugin, options: TaskCreationOptions = {}) {
        super(app, plugin);
        this.options = options;
        
        // CAMBIO 3: Usar el factory para crear el parser apropiado
        const factory = NaturalLanguageParserFactory.getInstance();
        this.nlParser = factory.getCurrentParser(
            plugin.settings.customStatuses,
            plugin.settings.customPriorities,
            plugin.settings.nlpDefaultToScheduled
        );
        
        // OPCIONAL: Log del idioma detectado para debug
        console.log(`TaskCreationModal using language: ${factory.getDetectedLanguage()}`);
    }

    // ... resto del código permanece igual ...
    // Los métodos parseNaturalLanguageInput, updatePreview, etc. no necesitan cambios
    // porque usan la interfaz común INaturalLanguageParser
}

// EJEMPLO DE USO AVANZADO (opcional):
export class TaskCreationModalWithLanguageSelector extends TaskModal {
    private options: TaskCreationOptions;
    private nlParser: INaturalLanguageParser;
    private currentLanguage: 'en' | 'es';
    private languageSelector: HTMLSelectElement;

    constructor(app: App, plugin: TaskNotesPlugin, options: TaskCreationOptions = {}) {
        super(app, plugin);
        this.options = options;
        
        const factory = NaturalLanguageParserFactory.getInstance();
        this.currentLanguage = factory.getDetectedLanguage();
        this.nlParser = factory.getCurrentParser(
            plugin.settings.customStatuses,
            plugin.settings.customPriorities,
            plugin.settings.nlpDefaultToScheduled
        );
    }

    protected createModalContent(): void {
        super.createModalContent();
        
        // Agregar selector de idioma
        this.createLanguageSelector();
    }

    private createLanguageSelector(): void {
        const container = this.modalEl.createDiv({ cls: 'language-selector-container' });
        
        const label = container.createEl('label', { text: 'Parser Language:' });
        this.languageSelector = container.createEl('select', { cls: 'language-selector' });
        
        const factory = NaturalLanguageParserFactory.getInstance();
        const supportedLanguages = factory.getSupportedLanguages();
        
        supportedLanguages.forEach(lang => {
            const option = this.languageSelector.createEl('option', {
                value: lang.code,
                text: `${lang.name} (${lang.nativeName})`
            });
            
            if (lang.code === this.currentLanguage) {
                option.selected = true;
            }
        });
        
        this.languageSelector.addEventListener('change', () => {
            this.switchLanguage(this.languageSelector.value as 'en' | 'es');
        });
    }

    private switchLanguage(newLanguage: 'en' | 'es'): void {
        const factory = NaturalLanguageParserFactory.getInstance();
        this.nlParser = factory.setLanguage(
            newLanguage,
            this.plugin.settings.customStatuses,
            this.plugin.settings.customPriorities,
            this.plugin.settings.nlpDefaultToScheduled
        );
        this.currentLanguage = newLanguage;
        
        // Actualizar preview si hay texto
        if (this.nlInput.value.trim()) {
            this.updatePreview();
        }
        
        // Mostrar notificación
        const langNames = { en: 'English', es: 'Español' };
        new Notice(`Parser language switched to ${langNames[newLanguage]}`);
    }
}

/*
EJEMPLOS DE ENTRADA EN ESPAÑOL QUE AHORA FUNCIONARÍAN:

1. "Llamar al médico mañana alta prioridad #salud"
   → title: "Llamar al médico", scheduledDate: "2024-03-16", priority: "high", tags: ["salud"]

2. "Reunión con equipo viernes 15:00 +proyecto-web @oficina"
   → title: "Reunión con equipo", scheduledDate: "2024-03-15", scheduledTime: "15:00", 
     projects: ["proyecto-web"], contexts: ["oficina"]

3. "Comprar víveres para el fin de semana baja prioridad"
   → title: "Comprar víveres para el fin de semana", priority: "low"

4. "Presentación del informe vence el 2024-03-15 urgente"
   → title: "Presentación del informe", dueDate: "2024-03-15", priority: "urgent"

5. "Revisar emails cada lunes diario +trabajo"
   → title: "Revisar emails", recurrence: "FREQ=WEEKLY;BYDAY=MO", projects: ["trabajo"]

6. "Ejercicio en el gym programado para mañana 6:00 #fitness"
   → title: "Ejercicio en el gym", scheduledDate: "2024-03-16", scheduledTime: "06:00", tags: ["fitness"]
*/
