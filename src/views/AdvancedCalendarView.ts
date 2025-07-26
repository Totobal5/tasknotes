import { ItemView, WorkspaceLeaf, TFile, Notice, EventRef, Menu, Modal } from 'obsidian';
import { ICSEventInfoModal } from '../modals/ICSEventInfoModal';
import { TimeblockInfoModal } from '../modals/TimeblockInfoModal';
import { format, startOfDay, endOfDay } from 'date-fns';
import { Calendar } from '@fullcalendar/core';
import { 
    createDailyNote, 
    getDailyNote, 
    getAllDailyNotes,
    appHasDailyNotesPluginLoaded
} from 'obsidian-daily-notes-interface';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import multiMonthPlugin from '@fullcalendar/multimonth';
import interactionPlugin from '@fullcalendar/interaction';
import TaskNotesPlugin from '../main';
import {
    ADVANCED_CALENDAR_VIEW_TYPE,
    EVENT_DATA_CHANGED,
    EVENT_TASK_UPDATED,
    EVENT_TIMEBLOCKING_TOGGLED,
    TaskInfo,
    TimeBlock,
    FilterQuery,
    CalendarViewPreferences,
    ICSEvent
} from '../types';
import { TaskCreationModal } from '../modals/TaskCreationModal';
import { TaskEditModal } from '../modals/TaskEditModal';
import { UnscheduledTasksSelectorModal, ScheduleTaskOptions } from '../modals/UnscheduledTasksSelectorModal';
import { TimeblockCreationModal } from '../modals/TimeblockCreationModal';
import { FilterBar } from '../ui/FilterBar';
import { showTaskContextMenu } from '../ui/TaskCard';
import { 
    hasTimeComponent, 
    getDatePart, 
    getTimePart,
    parseDate,
    normalizeCalendarBoundariesToUTC,
    formatUTCDateForCalendar
} from '../utils/dateUtils';
import { 
    generateRecurringInstances,
    extractTimeblocksFromNote,
    timeblockToCalendarEvent,
    updateTimeblockInDailyNote
} from '../utils/helpers';

interface CalendarEvent {
    id: string;
    title: string;
    start: string;
    end?: string;
    allDay: boolean;
    backgroundColor?: string;
    borderColor?: string;
    textColor?: string;
    editable?: boolean;
    extendedProps: {
        taskInfo?: TaskInfo;
        icsEvent?: ICSEvent;
        timeblock?: TimeBlock;
        eventType: 'scheduled' | 'due' | 'timeEntry' | 'recurring' | 'ics' | 'timeblock' | 'info';
        isCompleted?: boolean;
        isRecurringInstance?: boolean;
        instanceDate?: string; // YYYY-MM-DD for this specific occurrence
        recurringTemplateTime?: string; // Original scheduled time
        subscriptionName?: string; // For ICS events
        attachments?: string[]; // For timeblocks
    };
}

export class AdvancedCalendarView extends ItemView {
    plugin: TaskNotesPlugin;
    private calendar: Calendar | null = null;
    private listeners: EventRef[] = [];
    private functionListeners: (() => void)[] = [];
    
    // Resize handling
    private resizeObserver: ResizeObserver | null = null;
    private resizeTimeout: number | null = null;
    
    // Filter system
    private filterBar: FilterBar | null = null;
    private currentQuery: FilterQuery;
    
    // View toggles (keeping for calendar-specific display options)
    private showScheduled: boolean;
    private showDue: boolean;
    private showTimeEntries: boolean;
    private showRecurring: boolean;
    private showICSEvents: boolean;
    private showTimeblocks: boolean;
    
    // Mobile collapsible header state
    private headerCollapsed = true;

    // Cache unificado para todas las vistas y tipos de eventos
    private unifiedEventCache: {
        [cacheKey: string]: {
            events: CalendarEvent[];
            lastUpdated: number;
            viewType: string;
            dateRange: { start: string; end: string };
        }
    } = {};

    // Persistent cache for recurring task instances - should survive view changes
    private recurringInstanceCache: {
        [taskId: string]: { range: string, instances: CalendarEvent[], lastUpdated: number, loggedHit?: boolean }
    } = {};

    // Temporary cache for filtered tasks - can be cleared on filter changes
    private taskCache: {
        [key: string]: TaskInfo[]
    } = {};

    private lastViewType: string | null = null;

    // DOM Performance monitoring
    private performanceMetrics = {
        renderStart: 0,
        renderEnd: 0,
        domOperations: 0,
        eventsProcessed: 0
    };

    // DOM optimization caches
    private eventElementPool: Map<string, HTMLElement> = new Map();
    private documentFragment: DocumentFragment | null = null;

    // Performance optimization properties
    private refreshTimeout: number | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: TaskNotesPlugin) {
        super(leaf);
        this.plugin = plugin;
        
        // Initialize view toggles from settings defaults (will be overridden by saved preferences in onOpen)
        this.showScheduled = this.plugin.settings.calendarViewSettings.defaultShowScheduled;
        this.showDue = this.plugin.settings.calendarViewSettings.defaultShowDue;
        this.showTimeEntries = this.plugin.settings.calendarViewSettings.defaultShowTimeEntries;
        this.showRecurring = this.plugin.settings.calendarViewSettings.defaultShowRecurring;
        this.showICSEvents = this.plugin.settings.calendarViewSettings.defaultShowICSEvents;
        this.showTimeblocks = this.plugin.settings.calendarViewSettings.defaultShowTimeblocks;
        
        // Initialize with default query - will be properly set when plugin services are ready
        this.currentQuery = {
            type: 'group',
            id: 'temp',
            conjunction: 'and',
            children: [],
            sortKey: 'due',
            sortDirection: 'asc',
            groupKey: 'none'
        };
    }

    getViewType(): string {
        return ADVANCED_CALENDAR_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Advanced Calendar';
    }

    getIcon(): string {
        return 'calendar-range';
    }

    async onOpen() {
        await this.plugin.onReady();
        
        // Wait for migration to complete before initializing UI
        await this.plugin.waitForMigration();
        
        // Load saved filter state
        const savedQuery = this.plugin.viewStateManager.getFilterState(ADVANCED_CALENDAR_VIEW_TYPE);
        if (savedQuery) {
            this.currentQuery = savedQuery;
        } else if (this.plugin.filterService) {
            this.currentQuery = this.plugin.filterService.createDefaultQuery();
        }
        
        // Load saved view preferences (toggle states)
        const savedPreferences = this.plugin.viewStateManager.getViewPreferences<CalendarViewPreferences>(ADVANCED_CALENDAR_VIEW_TYPE);
        if (savedPreferences) {
            this.showScheduled = savedPreferences.showScheduled;
            this.showDue = savedPreferences.showDue;
            this.showTimeEntries = savedPreferences.showTimeEntries;
            this.showRecurring = savedPreferences.showRecurring;
            this.showICSEvents = savedPreferences.showICSEvents ?? this.plugin.settings.calendarViewSettings.defaultShowICSEvents;
            this.showTimeblocks = savedPreferences.showTimeblocks ?? this.plugin.settings.calendarViewSettings.defaultShowTimeblocks;
            this.headerCollapsed = savedPreferences.headerCollapsed ?? true;
        }
        
        const contentEl = this.contentEl;
        contentEl.empty();
        contentEl.addClass('tasknotes-plugin');
        contentEl.addClass('advanced-calendar-view');

        // Limpiar cachés antiguos de recurrencias al abrir la vista
        this.cleanupOldRecurringCache();

        // Create the calendar container
        await this.renderView();
        
        // Register event listeners
        this.registerEvents();
        
        // Initialize the calendar
        await this.initializeCalendar();

        this.contentEl.onWindowMigrated(async (win: Window) => {
            // Cleanup old calendar if it exists
            const contentEl = this.contentEl;
            contentEl.empty();
            contentEl.addClass('tasknotes-plugin');
            contentEl.addClass('advanced-calendar-view');
            // Re-render the view
            await this.renderView();
            this.registerEvents();
            await this.initializeCalendar();
        });
    }

    async renderView() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Create main layout container
        const mainContainer = contentEl.createDiv({ cls: 'advanced-calendar-view__container' });
        
        // Create header with controls
        await this.createHeader(mainContainer);
        
        // Create calendar container (now full width)
        mainContainer.createDiv({ 
            cls: 'advanced-calendar-view__calendar-container',
            attr: { id: 'advanced-calendar' }
        });       
    }

    async createHeader(container: HTMLElement) {
        const header = container.createDiv({ cls: 'advanced-calendar-view__header' });
        
        // Create mobile collapse toggle (only visible on mobile)
        const mobileToggle = header.createDiv({ cls: 'advanced-calendar-view__mobile-toggle' });
        const toggleBtn = mobileToggle.createEl('button', {
            text: this.headerCollapsed ? 'Show filters' : 'Hide filters',
            cls: 'advanced-calendar-view__collapse-btn'
        });
        toggleBtn.addEventListener('click', () => {
            this.headerCollapsed = !this.headerCollapsed;
            toggleBtn.textContent = this.headerCollapsed ? 'Show filters' : 'Hide filters';
            this.saveViewPreferences();
            this.updateHeaderVisibility();
        });
        
        // Create main header row that can contain both FilterBar and controls
        const mainRow = header.createDiv({ 
            cls: `advanced-calendar-view__main-row ${this.headerCollapsed ? 'collapsed' : 'expanded'}`
        });
        
        // Create FilterBar section
        const filterBarContainer = mainRow.createDiv({ cls: 'filter-bar-container' });
        
        // Wait for cache to be initialized with actual data
        await this.waitForCacheReady();
        
        // Get filter options from FilterService
        const filterOptions = await this.plugin.filterService.getFilterOptions();
        
        // Create new FilterBar
        this.filterBar = new FilterBar(
            this.app,
            filterBarContainer,
            this.currentQuery,
            filterOptions
        );
        
        // Get saved views for the FilterBar
        const savedViews = this.plugin.viewStateManager.getSavedViews();
        this.filterBar.updateSavedViews(savedViews);
        
        // Listen for saved view events
        this.filterBar.on('saveView', ({ name, query }) => {
            this.plugin.viewStateManager.saveView(name, query);
        });
        
        this.filterBar.on('deleteView', (viewId: string) => {
            this.plugin.viewStateManager.deleteView(viewId);
        });

        // Listen for global saved views changes
        this.plugin.viewStateManager.on('saved-views-changed', (updatedViews) => {
            this.filterBar?.updateSavedViews(updatedViews);
        });
        
        this.filterBar.on('reorderViews', (fromIndex: number, toIndex: number) => {
            this.plugin.viewStateManager.reorderSavedViews(fromIndex, toIndex);
        });
        
        this.filterBar.on('manageViews', () => {
            console.log('Manage views requested');
        });
        
        // Listen for filter changes
        this.filterBar.on('queryChange', async (newQuery: FilterQuery) => {
            this.currentQuery = newQuery;
            await this.plugin.viewStateManager.setFilterState(ADVANCED_CALENDAR_VIEW_TYPE, newQuery);
            this.createDebouncedRefresh();
        });

        // Set up view-specific options
        this.setupViewOptions();
        
    }
    
    private updateHeaderVisibility() {
        const mainRow = this.contentEl.querySelector('.advanced-calendar-view__main-row');
        if (mainRow) {
            mainRow.className = `advanced-calendar-view__main-row ${this.headerCollapsed ? 'collapsed' : 'expanded'}`;
        }
        
        // Update FullCalendar header toolbar visibility
        if (this.calendar) {
            this.calendar.setOption('headerToolbar', this.getHeaderToolbarConfig());
        }
    }

    private setupViewOptions(): void {
        if (!this.filterBar) return;

        const options = [
            {
                id: 'icsEvents',
                label: 'Calendar subscriptions',
                value: this.showICSEvents,
                onChange: (value: boolean) => {
                    this.showICSEvents = value;
                    this.saveViewPreferences();
                    this.createDebouncedRefresh();
                }
            },
            {
                id: 'timeEntries',
                label: 'Time entries',
                value: this.showTimeEntries,
                onChange: (value: boolean) => {
                    this.showTimeEntries = value;
                    this.saveViewPreferences();
                    this.createDebouncedRefresh();
                }
            },
            {
                id: 'timeblocks',
                label: 'Timeblocks',
                value: this.showTimeblocks,
                onChange: (value: boolean) => {
                    this.showTimeblocks = value;
                    this.saveViewPreferences();
                    this.createDebouncedRefresh();
                }
            },
            {
                id: 'scheduled',
                label: 'Scheduled dates',
                value: this.showScheduled,
                onChange: (value: boolean) => {
                    this.showScheduled = value;
                    this.saveViewPreferences();
                    this.createDebouncedRefresh();
                }
            },
            {
                id: 'due',
                label: 'Due dates',
                value: this.showDue,
                onChange: (value: boolean) => {
                    this.showDue = value;
                    this.saveViewPreferences();
                    this.createDebouncedRefresh();
                }
            }
        ];
        
        // Only add timeblocks option if enabled
        if (this.plugin.settings.calendarViewSettings.enableTimeblocking) {
            // timeblocks option is already included above
        } else {
            // Remove timeblocks option if timeblocking is disabled
            const timeblockIndex = options.findIndex(opt => opt.id === 'timeblocks');
            if (timeblockIndex !== -1) {
                options.splice(timeblockIndex, 1);
            }
        }

        this.filterBar.setViewOptions(options);
    }


    // View options handling for FilterBar integration
    getViewOptionsConfig() {
        const options = [
            { id: 'scheduled', label: 'Scheduled tasks', value: this.showScheduled },
            { id: 'due', label: 'Due dates', value: this.showDue },
            { id: 'timeEntries', label: 'Time entries', value: this.showTimeEntries },
            { id: 'recurring', label: 'Recurring tasks', value: this.showRecurring },
            { id: 'icsEvents', label: 'Calendar subscriptions', value: this.showICSEvents }
        ];
        
        // Add timeblocks option if enabled
        if (this.plugin.settings.calendarViewSettings.enableTimeblocking) {
            options.push({ id: 'timeblocks', label: 'Timeblocks', value: this.showTimeblocks });
        }
        
        return options;
    }
    
    onViewOptionChange(optionId: string, enabled: boolean) {
        switch (optionId) {
            case 'scheduled':
                this.showScheduled = enabled;
                break;
            case 'due':
                this.showDue = enabled;
                break;
            case 'timeEntries':
                this.showTimeEntries = enabled;
                break;
            case 'recurring':
                this.showRecurring = enabled;
                break;
            case 'icsEvents':
                this.showICSEvents = enabled;
                break;
            case 'timeblocks':
                this.showTimeblocks = enabled;
                break;
        }
        
        this.saveViewPreferences();
        this.refreshEvents();
        
        // Update FilterBar view options to reflect the change
        this.setupViewOptions();
    }
    
    private getHeaderToolbarConfig() {
        // Hide FullCalendar header on mobile when collapsed
        if (this.headerCollapsed && window.innerWidth <= 768) {
            return false; // This hides the entire header toolbar
        }
        
        const toolbarConfig = {
            left: 'prev,next today',
            center: 'title',
            right: 'refreshICS multiMonthYear,dayGridMonth,timeGridWeek,timeGridDay'
        };
        console.log('Header toolbar config:', toolbarConfig);
        return toolbarConfig;
    }

    private getCustomButtons() {
        const customButtons = {
            refreshICS: {
                text: 'Refresh',
                hint: 'Refresh Calendar Subscriptions',
                click: () => {
                    console.log('Refresh ICS button clicked!');
                    this.handleRefreshClick();
                }
            }
        };
        console.log('Custom buttons:', customButtons);
        return customButtons;
    }

    private async handleRefreshClick() {
        if (!this.plugin.icsSubscriptionService) {
            new Notice('ICS subscription service not available');
            return;
        }
        
        try {
            await this.plugin.icsSubscriptionService.refreshAllSubscriptions();
            
            // Al hacer refresh manual, también limpiar el caché de recurrencias
            // para asegurar que se recargan con datos frescos
            this.clearRecurringCache();
            
            new Notice('All calendar subscriptions refreshed successfully');
            // Force calendar to re-render with updated ICS events
            this.refreshEvents();
        } catch (error) {
            console.error('Error refreshing subscriptions:', error);
            new Notice('Failed to refresh some calendar subscriptions');
        }
    }

    

    openScheduleTasksModal() {
        const modal = new UnscheduledTasksSelectorModal(
            this.app,
            this.plugin,
            (task: TaskInfo | null, options?: ScheduleTaskOptions) => {
                if (task) {
                    this.scheduleTask(task, options);
                }
            }
        );
        modal.open();
    }

    async scheduleTask(task: TaskInfo, options?: ScheduleTaskOptions) {
        try {
            let scheduledDate: string;
            
            if (options?.date) {
                if (options.allDay) {
                    scheduledDate = format(options.date, 'yyyy-MM-dd');
                } else if (options.time) {
                    scheduledDate = format(options.date, 'yyyy-MM-dd') + 'T' + options.time;
                } else {
                    // Default to 9 AM if no time specified
                    scheduledDate = format(options.date, 'yyyy-MM-dd') + 'T09:00';
                }
            } else {
                // Default to today at 9 AM
                scheduledDate = format(new Date(), 'yyyy-MM-dd') + 'T09:00';
            }
            
            await this.plugin.taskService.updateProperty(task, 'scheduled', scheduledDate);
        } catch (error) {
            console.error('Error scheduling task:', error);
        }
    }

    async initializeCalendar() {
        const calendarEl = this.contentEl.querySelector('#advanced-calendar');
        if (!calendarEl) {
            console.error('Calendar element not found');
            return;
        }

        // Oculta el calendario durante la precarga
        (calendarEl as HTMLElement).style.visibility = 'hidden';

        const calendarSettings = this.plugin.settings.calendarViewSettings;

        // Forzar vista año en la primera carga
        const initialView = 'multiMonthYear';
        
        // Apply today highlight setting
        this.updateTodayHighlight();
        
        const customButtons = this.getCustomButtons();
        const headerToolbar = this.getHeaderToolbarConfig();
        
        console.log('Initializing calendar with customButtons:', customButtons);
        console.log('Initializing calendar with headerToolbar:', headerToolbar);
        
        this.calendar = new Calendar(calendarEl as HTMLElement, {
            plugins: [dayGridPlugin, timeGridPlugin, multiMonthPlugin, interactionPlugin],
            initialView: initialView, // calendarSettings.defaultView,
            headerToolbar: headerToolbar,
            customButtons: customButtons,
            height: '100%',
            editable: true,
            droppable: true,
            selectable: true,
            selectMirror: calendarSettings.selectMirror,
            
            // Week settings
            firstDay: calendarSettings.firstDay,
            weekNumbers: calendarSettings.weekNumbers,
            weekends: calendarSettings.showWeekends,
            
            // Current time indicator
            nowIndicator: calendarSettings.nowIndicator,
            
            // Enable clickable date titles
            navLinks: true,
            navLinkDayClick: this.handleDateTitleClick.bind(this),
            
            // Time view configuration
            slotMinTime: calendarSettings.slotMinTime,
            slotMaxTime: calendarSettings.slotMaxTime,
            scrollTime: calendarSettings.scrollTime,
            
            // Time grid configurations
            slotDuration: calendarSettings.slotDuration,
            slotLabelInterval: this.getSlotLabelInterval(calendarSettings.slotDuration),
            
            // Time format
            eventTimeFormat: this.getTimeFormat(calendarSettings.timeFormat),
            slotLabelFormat: this.getTimeFormat(calendarSettings.timeFormat),
            
            // Event handlers
            select: this.handleDateSelect.bind(this),
            eventClick: this.handleEventClick.bind(this),
            eventDrop: this.handleEventDrop.bind(this),
            eventResize: this.handleEventResize.bind(this),
            drop: this.handleExternalDrop.bind(this),
            eventReceive: this.handleEventReceive.bind(this),
            eventDidMount: this.handleEventDidMount.bind(this),
            
            // Event sources will be added dynamically
            events: this.getCalendarEvents.bind(this),

            lazyFetching: true,
            eventMaxStack: 3, // Limitar stack de eventos
            dayMaxEvents: 5, // Limitar eventos por día
            moreLinkClick: 'popover', // Mostrar más eventos en popover
            progressiveEventRendering: true
        });

        // Renderiza y precarga en Year, luego cambia a Month y muestra el calendario
        requestAnimationFrame(() => {
            if (this.calendar) {
                this.calendar.render();
                this.setupResizeHandling();
                this.refreshEvents();

                // Aplicar GPU acceleration inmediatamente después del render
                this.initializeGPUAcceleration();

                // Solo cambiar vista si realmente se necesita evitar el bucle infinito
                setTimeout(() => {
                    if (this.calendar && this.calendar.view.type === 'multiMonthYear') {
                        console.log('[Calendar Init] Switching from Year to Month view');
                        this.calendar.changeView('dayGridMonth');
                    }
                    (calendarEl as HTMLElement).style.visibility = 'visible';
                }, 100);
            }
        });
    }

    private saveViewPreferences(): void {
        const preferences: CalendarViewPreferences = {
            showScheduled: this.showScheduled,
            showDue: this.showDue,
            showTimeEntries: this.showTimeEntries,
            showRecurring: this.showRecurring,
            showICSEvents: this.showICSEvents,
            showTimeblocks: this.showTimeblocks,
            headerCollapsed: this.headerCollapsed
        };
        this.plugin.viewStateManager.setViewPreferences(ADVANCED_CALENDAR_VIEW_TYPE, preferences);
    }

    private clearCaches(): void {
        // Solo limpiar cache de tareas filtradas, NO el de recurrencias
        // El cache de recurrencias debe persistir entre cambios de vista
        this.taskCache = {};
        this.lastViewType = null;
        
        console.log('[Cache] Cleared task cache but preserved recurring instance cache');
    }

    /**
     * Limpia el caché de recurrencias - solo usar cuando sea absolutamente necesario
     * (ej: cuando cambian las tareas recurrentes o se fuerza un refresh completo)
     */
    private clearRecurringCache(): void {
        this.recurringInstanceCache = {};
        console.log('[Cache] Cleared recurring instance cache');
    }

    /**
     * Limpia cachés antiguos de recurrencias (más de 24 horas)
     */
    private cleanupOldRecurringCache(): void {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 horas
        
        let cleanedCount = 0;
        Object.keys(this.recurringInstanceCache).forEach(cacheKey => {
            const cacheEntry = this.recurringInstanceCache[cacheKey];
            if (cacheEntry && (now - cacheEntry.lastUpdated) > maxAge) {
                delete this.recurringInstanceCache[cacheKey];
                cleanedCount++;
            }
        });
        
        if (cleanedCount > 0) {
            console.log(`[Cache] Cleaned up ${cleanedCount} old recurring cache entries`);
        }
    }

    /**
     * Debounced refresh to prevent excessive re-renders during rapid view changes
     */
    private createDebouncedRefresh(): void {
        if (this.refreshTimeout) {
            window.clearTimeout(this.refreshTimeout);
        }
        
        this.refreshTimeout = window.setTimeout(() => {
            console.log('[View Change] Refreshing events after debounce');
            this.refreshEvents();
        }, 150); // 150ms debounce delay
    }

    private setupResizeHandling(): void {
        if (!this.calendar) return;

        // Clean up previous resize handling
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.resizeTimeout) {
            window.clearTimeout(this.resizeTimeout);
            this.resizeTimeout = null;
        }

        // Limpia listeners anteriores
        this.functionListeners.forEach(unsubscribe => unsubscribe());
        this.functionListeners = [];
        this.listeners.forEach(listener => this.plugin.emitter.offref(listener));
        this.listeners = [];

        // Usa el window correcto (soporta popout)
        const win = this.contentEl.ownerDocument.defaultView || window;

        // Debounced resize handler
        const debouncedResize = () => {
            if (this.resizeTimeout) {
                win.clearTimeout(this.resizeTimeout);
            }
            this.resizeTimeout = win.setTimeout(() => {
                if (this.calendar) {
                    this.calendar.updateSize();
                }
            }, 150);
        };

        // Use ResizeObserver to detect container size changes
        if (win.ResizeObserver) {
            this.resizeObserver = new win.ResizeObserver(debouncedResize);
            const calendarContainer = this.contentEl.querySelector('.advanced-calendar-view__calendar-container');
            if (calendarContainer) {
                this.resizeObserver.observe(calendarContainer);
            }
        }

        // Listen for workspace layout changes (Obsidian-specific)
        const layoutChangeListener = this.plugin.app.workspace.on('layout-change', debouncedResize);
        this.listeners.push(layoutChangeListener);

        // Listen for window resize as fallback
        win.addEventListener('resize', debouncedResize);
        this.functionListeners.push(() => win.removeEventListener('resize', debouncedResize));

        // Listen for active leaf changes that might affect calendar size
        const activeLeafListener = this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
            if (leaf === this.leaf) {
                setTimeout(debouncedResize, 100);
            }
        });
        this.listeners.push(activeLeafListener);
    }

    private getSlotLabelInterval(slotDuration: string): string {
        // Show labels every hour, but at least as often as the slot duration
        switch (slotDuration) {
            case '00:15:00': return '01:00:00'; // 15-min slots, hourly labels
            case '00:30:00': return '01:00:00'; // 30-min slots, hourly labels  
            case '01:00:00': return '01:00:00'; // 1-hour slots, hourly labels
            default: return '01:00:00';
        }
    }

    private getTimeFormat(timeFormat: '12' | '24'): any {
        if (timeFormat === '12') {
            return {
                hour: 'numeric',
                minute: '2-digit',
                omitZeroMinute: true,
                hour12: true
            };
        } else {
            return {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            };
        }
    }

    /**
     * Retrieves and assembles all calendar events to be displayed in the calendar view.
     *
     * This method gathers events from multiple sources, including:
     * - Filtered and grouped tasks (both recurring and non-recurring), generating event instances as needed.
     * - Time entry events associated with tasks, if enabled.
     * - ICS subscription events, if enabled and available.
     * - Timeblock events, if timeblocking is enabled in settings.
     *
     * The method applies user preferences for showing scheduled, due, recurring, time entry, ICS, and timeblock events.
     * It normalizes date boundaries to UTC to ensure correct handling of recurring rules and date ranges.
     * Errors encountered during event retrieval are logged to the console, but do not prevent other events from being processed.
     *
     * @returns {Promise<CalendarEvent[]>} A promise that resolves to an array of `CalendarEvent` objects to be displayed.
     */
    async getCalendarEvents(): Promise<CalendarEvent[]> {
        this.startPerformanceMonitoring();
        const events: CalendarEvent[] = [];
        
        try {
            console.time('getCalendarEvents:getTasks');
            const calendarView = this.calendar?.view;
            const viewType = calendarView?.type || 'dayGridMonth';
            const cacheKey = `${viewType}_${this.currentQuery.id}`;
            
            // Verificar cache unificado
            const now = Date.now();
            const cachedData = this.unifiedEventCache[cacheKey];
            if (cachedData && (now - cachedData.lastUpdated) < 120000) { // 2 minutos de validez
                console.log(`[Unified Cache] Using cached events for ${viewType}: ${cachedData.events.length} events`);
                this.endPerformanceMonitoring('getCalendarEvents-cached');
                return [...cachedData.events]; // Retornar copia para evitar mutaciones
            }
            
            let allTasks: TaskInfo[];
            
            // Usar caché de tareas filtradas si existe
            if (this.taskCache?.[cacheKey]) {
                allTasks = this.taskCache[cacheKey];
            } else {
                // Si no existe, obtener y cachear
                const groupedTasks = await this.plugin.filterService.getGroupedTasks(this.currentQuery);
                allTasks = Array.from(groupedTasks.values()).flat();
                
                // Guardar en caché
                if (!this.taskCache) this.taskCache = {};
                this.taskCache[cacheKey] = allTasks;
            }
            console.timeEnd('getCalendarEvents:getTasks');

            console.time('getCalendarEvents:dateNormalization');
            
            // Siempre usar el rango del año completo para la recolección de datos
            const year = calendarView?.currentStart.getFullYear() || new Date().getFullYear();
            const rawVisibleStart = new Date(Date.UTC(year, 0, 1));
            const rawVisibleEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
            
            console.log('Year view range (UTC):', 
                rawVisibleStart.toISOString(), 
                'to', 
                rawVisibleEnd.toISOString()
            );

            const { utcStart: visibleStart, utcEnd: visibleEnd } = {
                utcStart: rawVisibleStart,
                utcEnd: rawVisibleEnd
            };

            console.timeEnd('getCalendarEvents:dateNormalization');
            
            // Procesar tareas recurrentes de manera asíncrona para evitar congelamientos
            console.time('getCalendarEvents:recurringTasks');
            const recurringTasks = allTasks.filter(task => task.recurrence && task.scheduled && this.showRecurring);
            const recurringEvents = await this.processRecurringTasksAsync(recurringTasks, visibleStart, visibleEnd);
            events.push(...recurringEvents);
            console.timeEnd('getCalendarEvents:recurringTasks');

            // Procesar tareas no recurrentes de manera asíncrona
            console.time('getCalendarEvents:normalTasks');
            const normalEvents = await this.processNormalTasksAsync(allTasks);
            events.push(...normalEvents);
            console.timeEnd('getCalendarEvents:normalTasks');

            // Procesar time entries de manera asíncrona
            console.time('getCalendarEvents:timeEntries');
            if (this.showTimeEntries) {
                const timeEvents = await this.processTimeEntriesAsync(allTasks);
                events.push(...timeEvents);
            }
            console.timeEnd('getCalendarEvents:timeEntries');

            // Procesar eventos ICS
            console.time('getCalendarEvents:icsEvents');
            if (this.showICSEvents && this.plugin.icsSubscriptionService) {
                const icsEvents = this.plugin.icsSubscriptionService.getAllEvents();
                for (const icsEvent of icsEvents) {
                    const calendarEvent = this.createICSEvent(icsEvent);
                    if (calendarEvent) events.push(calendarEvent);
                }
            }
            console.timeEnd('getCalendarEvents:icsEvents');

            // Actualizar contador de eventos procesados
            this.performanceMetrics.eventsProcessed = events.length;
            
            // Guardar en cache unificado
            const cacheStartDate = calendarView?.activeStart || new Date();
            const cacheEndDate = calendarView?.activeEnd || new Date();
            this.unifiedEventCache[cacheKey] = {
                events: [...events], // Guardar copia
                lastUpdated: now,
                viewType: viewType,
                dateRange: {
                    start: cacheStartDate.toISOString(),
                    end: cacheEndDate.toISOString()
                }
            };
            console.log(`[Unified Cache] Cached ${events.length} events for ${viewType}`);
            
        } catch (error) {
            console.error('Error getting calendar events:', error);
        }

        this.endPerformanceMonitoring('getCalendarEvents');
        return events;
    }

    /**
     * Procesa tareas recurrentes de manera optimizada con cache inteligente
     */
    private async processRecurringTasksAsync(recurringTasks: TaskInfo[], visibleStart: Date, visibleEnd: Date): Promise<CalendarEvent[]> {
        if (recurringTasks.length === 0) {
            return [];
        }

        const events: CalendarEvent[] = [];
        const rangeKey = `${visibleStart.toISOString()}_${visibleEnd.toISOString()}`;
        
        // Categorizar tareas por estado de cache en una sola pasada
        const cachedTasks: TaskInfo[] = [];
        const uncachedTasks: TaskInfo[] = [];
        
        for (const task of recurringTasks) {
            const cacheKey = task.path;
            if (this.recurringInstanceCache[cacheKey] && 
                this.recurringInstanceCache[cacheKey].range === rangeKey) {
                cachedTasks.push(task);
            } else {
                uncachedTasks.push(task);
            }
        }
        
        console.log(`[Recurring Cache] ${cachedTasks.length} hits, ${uncachedTasks.length} misses for ${recurringTasks.length} tasks`);
        
        // Procesar tareas cacheadas síncronamente usando cache directo
        for (const task of cachedTasks) {
            const cacheKey = task.path;
            const cachedEvents = this.recurringInstanceCache[cacheKey].instances;
            events.push(...cachedEvents);
        }
        
        // Si no hay tareas sin cache, retornar inmediatamente
        if (uncachedTasks.length === 0) {
            console.log(`[Recurring Cache] All cache hits - returning ${events.length} cached events`);
            return events;
        }
        
        // Procesar tareas no cacheadas de manera asíncrona
        console.log(`[Recurring Cache] Processing ${uncachedTasks.length} uncached tasks asynchronously`);
        const batchSize = Math.min(5, Math.max(1, Math.ceil(uncachedTasks.length / 4))); // Batch size dinámico
        
        for (let i = 0; i < uncachedTasks.length; i += batchSize) {
            const batch = uncachedTasks.slice(i, i + batchSize);
            
            // Procesar el lote actual
            for (const task of batch) {
                const recurringEvents = this.generateRecurringTaskInstances(task, visibleStart, visibleEnd);
                events.push(...recurringEvents);
            }
            
            // Solo yield si hay más lotes por procesar
            if ((i + batchSize) < uncachedTasks.length) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }
        
        return events;
    }

    /**
     * Procesa tareas normales de manera asíncrona para evitar congelamientos
     */
    private async processNormalTasksAsync(allTasks: TaskInfo[]): Promise<CalendarEvent[]> {
        const events: CalendarEvent[] = [];
        const batchSize = 50; // Tareas normales son más rápidas, lotes más grandes
        
        const normalTasks = allTasks.filter(task => !task.recurrence);
        
        for (let i = 0; i < normalTasks.length; i += batchSize) {
            const batch = normalTasks.slice(i, i + batchSize);
            
            for (const task of batch) {
                if (this.showScheduled && task.scheduled) {
                    const scheduledEvent = this.createScheduledEvent(task);
                    if (scheduledEvent) events.push(scheduledEvent);
                }
                if (this.showDue && task.due) {
                    const dueEvent = this.createDueEvent(task);
                    if (dueEvent) events.push(dueEvent);
                }
            }
            
            // Dar oportunidad al hilo principal
            if (i + batchSize < normalTasks.length) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }
        
        return events;
    }

    /**
     * Procesa time entries de manera asíncrona para evitar congelamientos
     */
    private async processTimeEntriesAsync(allTasks: TaskInfo[]): Promise<CalendarEvent[]> {
        const events: CalendarEvent[] = [];
        const batchSize = 50;
        
        const tasksWithTimeEntries = allTasks.filter(task => task.timeEntries);
        
        for (let i = 0; i < tasksWithTimeEntries.length; i += batchSize) {
            const batch = tasksWithTimeEntries.slice(i, i + batchSize);
            
            for (const task of batch) {
                const timeEvents = this.createTimeEntryEvents(task);
                events.push(...timeEvents);
            }
            
            // Dar oportunidad al hilo principal
            if (i + batchSize < tasksWithTimeEntries.length) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }
        
        return events;
    }

    /**
     * Generates and caches recurring task instances as calendar events within a specified date range.
     *
     * This method checks if the recurring instances for the given task and date range are already cached.
     * If cached, it returns the cached instances. Otherwise, it generates up to a maximum number of recurring
     * instances, creates corresponding calendar events, stores them in the cache, and returns them.
     *
     * @param task - The task information object containing recurrence and scheduling details.
     * @param startDate - The start date of the range for which to generate recurring instances.
     * @param endDate - The end date of the range for which to generate recurring instances.
     * @returns An array of `CalendarEvent` objects representing the recurring task instances within the specified range.
     */
    generateRecurringTaskInstances(task: TaskInfo, startDate: Date, endDate: Date): CalendarEvent[] {
        const cacheKey = task.path;
        const rangeKey = `${startDate.toISOString()}_${endDate.toISOString()}`;
        
        // Usar cache existente si el rango coincide
        if (
            this.recurringInstanceCache[cacheKey] &&
            this.recurringInstanceCache[cacheKey].range === rangeKey
        ) {
            // Solo log en debug mode o para primera cache hit de la sesión
            if (!this.recurringInstanceCache[cacheKey].loggedHit) {
                console.log(`[Cache Hit] Using cached recurring instances for task: ${task.path}`);
                this.recurringInstanceCache[cacheKey].loggedHit = true;
            }
            return this.recurringInstanceCache[cacheKey].instances;
        }

        console.log(`[Cache Miss] Generating new recurring instances for task: ${task.path}`);
        const instances: CalendarEvent[] = [];
        const hasOriginalTime = hasTimeComponent(task.scheduled ?? "");
        const templateTime = this.getRecurringTime(task);

        // Generar todas las instancias para el rango
        const recurringDates = generateRecurringInstances(task, startDate, endDate);

        // Procesar las fechas de manera más eficiente
        for (const date of recurringDates) {
            const instanceDate = formatUTCDateForCalendar(date);
            const eventStart = hasOriginalTime ? `${instanceDate}T${templateTime}` : instanceDate;
            const recurringEvent = this.createRecurringEvent(task, eventStart, instanceDate, templateTime);
            if (recurringEvent) {
                instances.push(recurringEvent);
            }
        }

        // Guardar en cache con timestamp
        this.recurringInstanceCache[cacheKey] = {
            range: rangeKey,
            instances,
            lastUpdated: Date.now(),
            loggedHit: false // Reset log flag
        };

        console.log(`[Cache Store] Cached ${instances.length} recurring instances for task: ${task.path}`);
        return instances;
    }

    /**
     * DOM Performance Optimization Methods
     */
    
    /**
     * Inicia el monitoreo de performance para operaciones de renderizado
     */
    private startPerformanceMonitoring(): void {
        this.performanceMetrics.renderStart = performance.now();
        this.performanceMetrics.domOperations = 0;
        this.performanceMetrics.eventsProcessed = 0;
    }

    /**
     * Finaliza el monitoreo y reporta métricas de performance
     */
    private endPerformanceMonitoring(operation: string): void {
        this.performanceMetrics.renderEnd = performance.now();
        const duration = this.performanceMetrics.renderEnd - this.performanceMetrics.renderStart;
        
        console.log(`[DOM Performance] ${operation}:`, {
            duration: `${duration.toFixed(2)}ms`,
            domOperations: this.performanceMetrics.domOperations,
            eventsProcessed: this.performanceMetrics.eventsProcessed,
            avgPerEvent: `${(duration / Math.max(this.performanceMetrics.eventsProcessed, 1)).toFixed(2)}ms`
        });
    }

    /**
     * Renderiza eventos de manera optimizada usando DocumentFragment
     * para minimizar reflows y repaints
     */
    private renderEventsOptimized(events: CalendarEvent[]): void {
        this.startPerformanceMonitoring();

        // Usar requestIdleCallback si está disponible para renderizado no bloqueante
        if ('requestIdleCallback' in window) {
            this.renderEventsWithIdleCallback(events);
        } else {
            // Fallback para navegadores que no soportan requestIdleCallback
            this.renderEventsBatched(events);
        }
    }

    /**
     * Renderizado con requestIdleCallback para mejor responsividad
     */
    private renderEventsWithIdleCallback(events: CalendarEvent[]): void {
        const batchSize = 20; // Lotes optimizados para idle callback
        let processedCount = 0;

        const processNextBatch = (deadline: any) => {
            const startTime = performance.now();
            
            while ((deadline.timeRemaining() > 5 || deadline.didTimeout) && 
                   processedCount < events.length &&
                   (performance.now() - startTime) < 8) { // Máximo 8ms por iteración
                
                const batch = events.slice(processedCount, processedCount + batchSize);
                
                // Procesar lote con GPU acceleration aplicada
                batch.forEach(event => {
                    // Aplicar optimizaciones GPU si es posible
                    if (event.extendedProps) {
                        (event.extendedProps as any).gpuOptimized = true;
                        (event.extendedProps as any).renderHint = 'fast';
                    }
                    this.performanceMetrics.eventsProcessed++;
                });

                processedCount += batchSize;
                this.performanceMetrics.domOperations++;
            }

            if (processedCount < events.length) {
                // Continuar en el siguiente frame idle
                (window as any).requestIdleCallback(processNextBatch, { timeout: 1000 });
            } else {
                this.endPerformanceMonitoring('renderEventsOptimized');
                console.log(`[Idle Callback] Processed ${processedCount} events successfully`);
            }
        };

        (window as any).requestIdleCallback(processNextBatch, { timeout: 1000 });
    }

    /**
     * Renderizado por lotes tradicional (fallback)
     */
    private renderEventsBatched(events: CalendarEvent[]): void {
        const batchSize = 25; // Lotes más grandes para processing directo
        let processedCount = 0;

        const processBatch = () => {
            const endIndex = Math.min(processedCount + batchSize, events.length);
            
            // Procesar eventos directamente sin DocumentFragment para reducir overhead
            for (let i = processedCount; i < endIndex; i++) {
                const event = events[i];
                const eventId = event.id || `event-${Date.now()}-${Math.random()}`;
                this.performanceMetrics.eventsProcessed++;
            }

            processedCount = endIndex;
            this.performanceMetrics.domOperations++;

            if (processedCount < events.length) {
                // Continuar en el siguiente frame
                requestAnimationFrame(processBatch);
            } else {
                this.endPerformanceMonitoring('renderEventsOptimized');
            }
        };

        processBatch();
    }

    /**
     * Crea un elemento de evento optimizado, reutilizando elementos existentes cuando es posible
     */
    private createOptimizedEventElement(event: CalendarEvent): HTMLElement | null {
        const eventId = event.id || `event-${Date.now()}-${Math.random()}`;
        
        // Intentar reutilizar elemento existente del pool
        let eventElement = this.eventElementPool.get(eventId);
        
        if (!eventElement) {
            // Crear nuevo elemento si no existe en el pool
            eventElement = document.createElement('div');
            eventElement.className = 'fc-event fc-event-optimized';
            eventElement.setAttribute('data-event-id', eventId);
            
            // Agregar al pool para futura reutilización
            this.eventElementPool.set(eventId, eventElement);
        }

        // Actualizar contenido usando propiedades que no causan reflow
        this.updateEventElementOptimized(eventElement, event);
        
        return eventElement;
    }

    /**
     * Actualiza un elemento de evento usando propiedades CSS que no causan reflow
     */
    private updateEventElementOptimized(element: HTMLElement, event: CalendarEvent): void {
        // Usar transform para posicionamiento (no causa reflow)
        const style = element.style;
        
        // Aplicar GPU acceleration agresiva
        style.transform = 'translate3d(0, 0, 0)';
        style.webkitTransform = 'translate3d(0, 0, 0)';
        style.backfaceVisibility = 'hidden';
        style.webkitBackfaceVisibility = 'hidden';
        style.willChange = 'transform, opacity';
        
        // Actualizar contenido de texto
        element.textContent = event.title;
        
        // Aplicar estilos usando propiedades optimizadas
        style.backgroundColor = event.backgroundColor || 'transparent';
        style.borderColor = event.borderColor || 'var(--color-accent)';
        style.color = event.textColor || 'var(--text-normal)';
        
        // Usar opacity para mostrar/ocultar (no causa reflow)
        style.opacity = event.extendedProps?.isCompleted ? '0.6' : '1';
        
        // Aplicar transformaciones sin causar reflow
        if (event.extendedProps?.isCompleted) {
            style.textDecoration = 'line-through';
        } else {
            style.textDecoration = 'none';
        }
        
        // Forzar compositing layer con transform 3D
        style.transform = 'translate3d(0, 0, 0)';
    }

    /**
     * Sistema de reciclaje de elementos DOM para reutilizar elementos existentes
     */
    private recycleEventElements(events: CalendarEvent[]): void {
        this.startPerformanceMonitoring();
        
        const currentEventIds = new Set(events.map(e => e.id));
        const unusedElements: HTMLElement[] = [];
        
        // Identificar elementos no utilizados
        this.eventElementPool.forEach((element, eventId) => {
            if (!currentEventIds.has(eventId)) {
                unusedElements.push(element);
                // Ocultar elemento usando opacity (no causa reflow)
                element.style.opacity = '0';
                element.style.transform = 'translateZ(0) scale(0)';
            }
        });
        
        // Reutilizar elementos no utilizados para nuevos eventos
        const eventsNeedingElements = events.filter(e => !this.eventElementPool.has(e.id || ''));
        
        eventsNeedingElements.forEach((event, index) => {
            if (index < unusedElements.length) {
                const recycledElement = unusedElements[index];
                const eventId = event.id || `recycled-${Date.now()}-${index}`;
                
                // Actualizar elemento reciclado
                this.updateEventElementOptimized(recycledElement, event);
                
                // Actualizar mapping en el pool
                this.eventElementPool.set(eventId, recycledElement);
                
                // Mostrar elemento reciclado
                recycledElement.style.opacity = '1';
                recycledElement.style.transform = 'translateZ(0) scale(1)';
                
                this.performanceMetrics.eventsProcessed++;
            }
        });
        
        this.performanceMetrics.domOperations = unusedElements.length;
        this.endPerformanceMonitoring('recycleEventElements');
    }

    /**
     * Compromete el DocumentFragment al DOM de manera optimizada
     */
    private commitDocumentFragment(): void {
        if (!this.documentFragment) return;
        
        // Encontrar el contenedor de eventos del calendario
        const calendarContainer = this.contentEl.querySelector('.fc-daygrid-body, .fc-timegrid-body');
        
        if (calendarContainer) {
            // Insertar todo el fragment de una vez para minimizar reflows
            calendarContainer.appendChild(this.documentFragment);
            this.performanceMetrics.domOperations++;
        }
        
        // Limpiar fragment
        this.documentFragment = null;
    }

    /**
     * Limpia el pool de elementos cuando ya no son necesarios
     */
    private cleanupElementPool(): void {
        // Limpiar elementos del pool que no se han usado recientemente
        const now = Date.now();
        const maxAge = 30000; // 30 segundos
        
        this.eventElementPool.forEach((element, eventId) => {
            const lastUsed = parseInt(element.dataset.lastUsed || '0', 10);
            if (now - lastUsed > maxAge) {
                element.remove();
                this.eventElementPool.delete(eventId);
            }
        });
    }

    /**
     * Optimizaciones simples y efectivas sin interferir con FullCalendar
     */
    private optimizedEventRender(events: CalendarEvent[]): void {
        console.log(`[DOM Optimization] Large event set detected (${events.length} events), using simplified approach`);
        
        // Solo usar configuraciones optimizadas, sin interferir con el DOM
        this.applyPerformanceOptimizations();
    }

    /**
     * Aplica optimizaciones de performance sin interferir con el renderizado de FullCalendar
     */
    private applyPerformanceOptimizations(): void {
        if (!this.calendar) return;

        console.log(`[Performance] Applying dynamic optimizations for current view`);
        
        // 1. Usar refetch estándar pero con configuraciones optimizadas temporalmente
        const currentView = this.calendar.view.type;
        
        if (currentView === 'multiMonthYear') {
            // Para vista año, configuraciones moderadas pero optimizadas
            this.calendar.setOption('dayMaxEvents', 2); // 2 eventos visibles por día
            this.calendar.setOption('eventMaxStack', 2); // Stack de máximo 2
            this.calendar.setOption('moreLinkClick', 'popover'); // Mostrar resto en popover
            this.calendar.setOption('progressiveEventRendering', true);
            this.calendar.setOption('lazyFetching', true);
            console.log(`[Performance] Applied moderate Year view optimizations`);
        } else {
            // Para otras vistas, configuraciones normales
            this.calendar.setOption('dayMaxEvents', 5);
            this.calendar.setOption('eventMaxStack', 3);
            this.calendar.setOption('moreLinkClick', 'popover');
            console.log(`[Performance] Applied standard limits for ${currentView}`);
        }
        
        // 2. Usar el método nativo de FullCalendar que está optimizado
        this.calendar.refetchEvents();
        
        // 3. Mantener configuraciones optimizadas para vista año
        if (currentView !== 'multiMonthYear') {
            setTimeout(() => {
                if (this.calendar && this.calendar.view.type !== 'multiMonthYear') {
                    this.calendar.setOption('dayMaxEvents', 5);
                    this.calendar.setOption('eventMaxStack', 3);
                    console.log(`[Performance] Restored normal limits for ${this.calendar.view.type}`);
                }
            }, 150);
        } else {
            console.log(`[Performance] Keeping moderate optimizations for Year view`);
        }
    }

    /**
     * Inicializa GPU acceleration en todo el calendario
     */
    private initializeGPUAcceleration(): void {
        const calendarEl = this.contentEl.querySelector('#advanced-calendar') as HTMLElement;
        if (!calendarEl) return;
        
        console.log(`[GPU Acceleration] Initializing extreme GPU acceleration for entire calendar`);
        
        // Aplicar GPU acceleration al contenedor principal
        this.applyGPUAcceleration(calendarEl);
        
        // Aplicar a elementos FullCalendar específicos con un breve delay para que se rendericen
        setTimeout(() => {
            this.applyGPUToFullCalendarElements();
        }, 50);
    }

    /**
     * Aplica GPU acceleration a elementos específicos de FullCalendar
     */
    private applyGPUToFullCalendarElements(): void {
        const calendarEl = this.contentEl.querySelector('#advanced-calendar');
        if (!calendarEl) return;
        
        // Elementos clave de FullCalendar para GPU acceleration
        const selectors = [
            '.fc-view-harness',
            '.fc-daygrid',
            '.fc-timegrid', 
            '.fc-multimonth',
            '.fc-daygrid-week',
            '.fc-daygrid-day',
            '.fc-timegrid-col',
            '.fc-multimonth-month',
            '.fc-event',
            '.fc-event-main',
            '.fc-event-title',
            '.fc-more-link',
            '.fc-popover'
        ];
        
        selectors.forEach(selector => {
            const elements = calendarEl.querySelectorAll(selector);
            elements.forEach((element: Element) => {
                const el = element as HTMLElement;
                const style = el.style;
                
                style.transform = 'translate3d(0, 0, 0)';
                style.webkitTransform = 'translate3d(0, 0, 0)';
                style.backfaceVisibility = 'hidden';
                style.webkitBackfaceVisibility = 'hidden';
                style.willChange = 'transform';
                
                // Marcar elementos optimizados para CSS targeting
                if (selector === '.fc-event') {
                    el.setAttribute('data-gpu-optimized', 'true');
                    el.setAttribute('data-render-hint', 'fast');
                }
            });
        });
        
        console.log(`[GPU Acceleration] Applied to ${selectors.length} types of FullCalendar elements`);
    }

    /**
     * Aplica GPU acceleration extrema a elementos del calendario
     */
    private applyGPUAcceleration(element: HTMLElement): void {
        const style = element.style;
        
        // GPU acceleration base
        style.transform = 'translate3d(0, 0, 0)';
        style.webkitTransform = 'translate3d(0, 0, 0)';
        style.backfaceVisibility = 'hidden';
        style.webkitBackfaceVisibility = 'hidden';
        style.willChange = 'transform, opacity';
        style.perspective = '1000px';
        style.webkitPerspective = '1000px';
        
        // Aplicar a elementos hijos también
        const childElements = element.querySelectorAll('.fc-view-harness, .fc-daygrid, .fc-timegrid, .fc-multimonth, .fc-event');
        childElements.forEach((child: Element) => {
            const childEl = child as HTMLElement;
            const childStyle = childEl.style;
            
            childStyle.transform = 'translate3d(0, 0, 0)';
            childStyle.webkitTransform = 'translate3d(0, 0, 0)';
            childStyle.backfaceVisibility = 'hidden';
            childStyle.webkitBackfaceVisibility = 'hidden';
            childStyle.willChange = 'transform';
        });
        
        console.log(`[GPU Acceleration] Applied extreme GPU acceleration to calendar elements`);
    }

    createScheduledEvent(task: TaskInfo): CalendarEvent | null {
        if (!task.scheduled) return null;
        
        const hasTime = hasTimeComponent(task.scheduled);
        const startDate = task.scheduled;
        
        let endDate: string | undefined;
        if (hasTime && task.timeEstimate) {
            // Calculate end time based on time estimate
            const start = parseDate(startDate);
            const end = new Date(start.getTime() + (task.timeEstimate * 60 * 1000));
            endDate = format(end, "yyyy-MM-dd'T'HH:mm");
        }
        
        // Get priority-based color for border
        const priorityConfig = this.plugin.priorityManager.getPriorityConfig(task.priority);
        const borderColor = priorityConfig?.color || 'var(--color-accent)';
        
        // Check if task is completed
        const isCompleted = this.plugin.statusManager.isCompletedStatus(task.status);
        
        return {
            id: `scheduled-${task.path}`,
            title: task.title,
            start: startDate,
            end: endDate,
            allDay: !hasTime,
            backgroundColor: 'transparent',
            borderColor: borderColor,
            textColor: borderColor,
            editable: true, // Tasks are also editable
            extendedProps: {
                taskInfo: task,
                eventType: 'scheduled',
                isCompleted: isCompleted
            }
        };
    }

    createDueEvent(task: TaskInfo): CalendarEvent | null {
        if (!task.due) return null;
        
        const hasTime = hasTimeComponent(task.due);
        const startDate = task.due;
        
        let endDate: string | undefined;
        if (hasTime) {
            // Fixed duration for due events (30 minutes)
            const start = parseDate(startDate);
            const end = new Date(start.getTime() + (30 * 60 * 1000));
            endDate = format(end, "yyyy-MM-dd'T'HH:mm");
        }
        
        // Get priority-based color with faded background
        const priorityConfig = this.plugin.priorityManager.getPriorityConfig(task.priority);
        const borderColor = priorityConfig?.color || 'var(--color-orange)';
        
        // Create faded background color from priority color
        const fadedBackground = this.hexToRgba(borderColor, 0.15);
        
        // Check if task is completed
        const isCompleted = this.plugin.statusManager.isCompletedStatus(task.status);
        
        return {
            id: `due-${task.path}`,
            title: `DUE: ${task.title}`,
            start: startDate,
            end: endDate,
            allDay: !hasTime,
            backgroundColor: fadedBackground,
            borderColor: borderColor,
            textColor: borderColor,
            editable: false, // Due events are not editable via drag (different from scheduled)
            extendedProps: {
                taskInfo: task,
                eventType: 'due',
                isCompleted: isCompleted
            }
        };
    }

    hexToRgba(hex: string, alpha: number): string {
        // Remove # if present
        hex = hex.replace('#', '');
        
        // Parse hex color
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    createTimeEntryEvents(task: TaskInfo): CalendarEvent[] {
        if (!task.timeEntries) return [];
        
        // Check if task is completed
        const isCompleted = this.plugin.statusManager.isCompletedStatus(task.status);
        
        return task.timeEntries
            .filter(entry => entry.endTime) // Only completed time entries
            .map((entry, index) => ({
                id: `timeentry-${task.path}-${index}`,
                title: task.title,
                start: entry.startTime,
                end: entry.endTime!,
                allDay: false,
                backgroundColor: 'var(--color-base-50)',
                borderColor: 'var(--color-base-40)',
                textColor: 'var(--text-on-accent)',
                editable: false, // Time entries are read-only
                extendedProps: {
                    taskInfo: task,
                    eventType: 'timeEntry' as const,
                    isCompleted: isCompleted,
                    timeEntryIndex: index
                }
            }));
    }

    createICSEvent(icsEvent: ICSEvent): CalendarEvent | null {
        try {
            // Get subscription info for styling
            const subscription = this.plugin.icsSubscriptionService.getSubscriptions()
                .find(sub => sub.id === icsEvent.subscriptionId);
            
            if (!subscription || !subscription.enabled) {
                return null;
            }

            const backgroundColor = this.hexToRgba(subscription.color, 0.2);
            const borderColor = subscription.color;

            return {
                id: icsEvent.id,
                title: icsEvent.title,
                start: icsEvent.start,
                end: icsEvent.end,
                allDay: icsEvent.allDay,
                backgroundColor: backgroundColor,
                borderColor: borderColor,
                textColor: borderColor,
                editable: false, // ICS events are not editable
                extendedProps: {
                    icsEvent: icsEvent,
                    eventType: 'ics',
                    subscriptionName: subscription.name
                }
            };
        } catch (error) {
            console.error('Error creating ICS event:', error);
            return null;
        }
    }

    getRecurringTime(task: TaskInfo): string {
        if (!task.scheduled) return '09:00'; // default
        const timePart = getTimePart(task.scheduled);
        return timePart || '09:00';
    }

    createRecurringEvent(task: TaskInfo, eventStart: string, instanceDate: string, templateTime: string): CalendarEvent | null {
        const hasTime = hasTimeComponent(eventStart);
        
        // Calculate end time if time estimate is available
        let endDate: string | undefined;
        if (hasTime && task.timeEstimate) {
            const start = parseDate(eventStart);
            const end = new Date(start.getTime() + (task.timeEstimate * 60 * 1000));
            endDate = format(end, "yyyy-MM-dd'T'HH:mm");
        }
        
        // Get priority-based color for border
        const priorityConfig = this.plugin.priorityManager.getPriorityConfig(task.priority);
        const borderColor = priorityConfig?.color || 'var(--color-accent)';
        
        // Check if this instance is completed
        const isInstanceCompleted = task.complete_instances?.includes(instanceDate) || false;
        
        // Visual styling for recurring instances
        const backgroundColor = isInstanceCompleted ? 'rgba(0,0,0,0.3)' : 'transparent';
        // Text decoration handled in renderEvent hook
        
        return {
            id: `recurring-${task.path}-${instanceDate}`,
            title: task.title,
            start: eventStart,
            end: endDate,
            allDay: !hasTime,
            backgroundColor: backgroundColor,
            borderColor: borderColor,
            textColor: borderColor,
            editable: true, // Recurring tasks are editable
            extendedProps: {
                taskInfo: task,
                eventType: 'recurring',
                isCompleted: isInstanceCompleted,
                isRecurringInstance: true,
                instanceDate: instanceDate,
                recurringTemplateTime: templateTime
            }
        };
    }

    // Event handlers
    handleDateSelect(selectInfo: any) {
        const { start, end, allDay, jsEvent } = selectInfo;
        
        // Check if timeblocking is enabled and Shift key is held
        const isTimeblockMode = this.plugin.settings.calendarViewSettings.enableTimeblocking && 
                               this.showTimeblocks && 
                               jsEvent && jsEvent.shiftKey;
        
        if (isTimeblockMode) {
            // Create timeblock
            this.handleTimeblockCreation(start, end, allDay);
        } else {
            // Create task (default behavior)
            this.handleTaskCreation(start, end, allDay);
        }
        
        // Clear selection
        this.calendar?.unselect();
    }
    
    private parseSlotDurationToMinutes(slotDuration: string): number {
        // Parse slot duration format like '00:30:00' to minutes
        const parts = slotDuration.split(':');
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        return hours * 60 + minutes;
    }
    
    private handleTaskCreation(start: Date, end: Date, allDay: boolean) {
        // Pre-populate with selected date/time
        const scheduledDate = allDay 
            ? format(start, 'yyyy-MM-dd')
            : format(start, "yyyy-MM-dd'T'HH:mm");
            
        const durationMinutes = Math.round((end.getTime() - start.getTime()) / (1000 * 60));
        
        // Convert slot duration setting to minutes for comparison
        const slotDurationSetting = this.plugin.settings.calendarViewSettings.slotDuration;
        const slotDurationMinutes = this.parseSlotDurationToMinutes(slotDurationSetting);
        
        // Determine if this was a drag (intentional time selection) or just a click
        // If duration is greater than slot duration, it's an intentional drag
        const isDragOperation = !allDay && durationMinutes > slotDurationMinutes;
        
        const prePopulatedValues: any = {
            scheduled: scheduledDate
        };
        
        // Only override time estimate if it's an intentional drag operation
        if (allDay) {
            // For all-day events, don't override user's default time estimate
            // Let TaskCreationModal use the default setting
        } else if (isDragOperation) {
            // User dragged to select a specific duration, use that
            prePopulatedValues.timeEstimate = durationMinutes;
        }
        // For clicks (not drags), don't set timeEstimate to let default setting apply
        
        const modal = new TaskCreationModal(this.app, this.plugin, {
            prePopulatedValues
        });
        
        modal.open();
    }
    
    private handleTimeblockCreation(start: Date, end: Date, allDay: boolean) {
        // Don't create timeblocks for all-day selections
        if (allDay) {
            new Notice('Timeblocks must have specific times. Please select a time range in week or day view.');
            return;
        }
        
        const date = format(start, 'yyyy-MM-dd');
        const startTime = format(start, 'HH:mm');
        const endTime = format(end, 'HH:mm');
        
        const modal = new TimeblockCreationModal(this.app, this.plugin, {
            date,
            startTime,
            endTime
        });
        
        modal.open();
    }

    /**
     * Handle clicking on a date title to open/create daily note
     */
    async handleDateTitleClick(date: Date) {
        try {
            // Check if Daily Notes plugin is enabled
            if (!appHasDailyNotesPluginLoaded()) {
                new Notice('Daily Notes core plugin is not enabled. Please enable it in Settings > Core plugins.');
                return;
            }

            // Convert date to moment for the API
            const moment = (window as any).moment(date);
            
            // Get all daily notes to check if one exists for this date
            const allDailyNotes = getAllDailyNotes();
            let dailyNote = getDailyNote(moment, allDailyNotes);
            
            if (!dailyNote) {
                // Daily note doesn't exist, create it
                try {
                    dailyNote = await createDailyNote(moment);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    console.error('Failed to create daily note:', error);
                    new Notice(`Failed to create daily note: ${errorMessage}`);
                    return;
                }
            }
            
            // Open the daily note
            if (dailyNote) {
                await this.app.workspace.getLeaf(false).openFile(dailyNote);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to navigate to daily note:', error);
            new Notice(`Failed to navigate to daily note: ${errorMessage}`);
        }
    }

    async getTimeblockEvents(): Promise<CalendarEvent[]> {
        const events: CalendarEvent[] = [];
        
        try {
            // Check if Daily Notes plugin is enabled
            if (!appHasDailyNotesPluginLoaded()) {
                return events;
            }
            
            // Get calendar's visible date range
            const calendarView = this.calendar?.view;
            if (!calendarView) return events;
            
            const visibleStart = calendarView.activeStart;
            const visibleEnd = calendarView.activeEnd;
            
            // Get all daily notes
            const allDailyNotes = getAllDailyNotes();
            
            // Iterate through each day in the visible range
            const currentDate = new Date(visibleStart);
            while (currentDate <= visibleEnd) {
                const dateString = format(currentDate, 'yyyy-MM-dd');
                const moment = (window as any).moment(currentDate);
                const dailyNote = getDailyNote(moment, allDailyNotes);
                
                if (dailyNote) {
                    try {
                        const content = await this.app.vault.read(dailyNote);
                        const timeblocks = extractTimeblocksFromNote(content, dailyNote.path);
                        
                        // Convert timeblocks to calendar events
                        for (const timeblock of timeblocks) {
                            const calendarEvent = timeblockToCalendarEvent(timeblock, dateString);
                            events.push(calendarEvent);
                        }
                    } catch (error) {
                        console.error(`Error reading daily note ${dailyNote.path}:`, error);
                    }
                }
                
                // Move to next day
                currentDate.setDate(currentDate.getDate() + 1);
            }
        } catch (error) {
            console.error('Error getting timeblock events:', error);
        }
        
        return events;
    }

    handleEventClick(clickInfo: any) {
        const { taskInfo, icsEvent, timeblock, eventType, subscriptionName } = clickInfo.event.extendedProps;
        const jsEvent = clickInfo.jsEvent;
        
        if (eventType === 'timeEntry') {
            // Time entries open the task edit modal
            if (taskInfo && (jsEvent.button === 0 && !jsEvent.ctrlKey && !jsEvent.metaKey)) {
                const editModal = new TaskEditModal(this.app, this.plugin, { task: taskInfo });
                editModal.open();
            }
            return;
        }
        
        if (eventType === 'timeblock') {
            // Timeblocks are read-only for now, could add editing later
            this.showTimeblockInfo(timeblock, clickInfo.event.start);
            return;
        }
        
        if (eventType === 'ics') {
            // ICS events are read-only, show info modal
            this.showICSEventInfo(icsEvent, subscriptionName);
            return;
        }
        
        // Handle different click types - removed right-click handling to avoid conflicts with eventDidMount
        if (jsEvent.ctrlKey || jsEvent.metaKey) {
            // Ctrl/Cmd + Click: Open task in new tab
            const file = this.app.vault.getAbstractFileByPath(taskInfo.path);
            if (file instanceof TFile) {
                this.app.workspace.openLinkText(taskInfo.path, '', true);
            }
        } else if (jsEvent.button === 0) {
            // Left click only: Open edit modal
            const editModal = new TaskEditModal(this.app, this.plugin, { task: taskInfo });
            editModal.open();
        }
    }

    async handleEventDrop(dropInfo: any) {
        const { taskInfo, timeblock, eventType, isRecurringInstance, originalDate } = dropInfo.event.extendedProps;
        
        if (eventType === 'timeEntry' || eventType === 'ics') {
            // Time entries and ICS events cannot be moved
            dropInfo.revert();
            return;
        }
        
        // Handle timeblock drops
        if (eventType === 'timeblock') {
            await this.handleTimeblockDrop(dropInfo, timeblock, originalDate);
            return;
        }
        
        try {
            const newStart = dropInfo.event.start;
            const allDay = dropInfo.event.allDay;
            
            if (isRecurringInstance) {
                // For recurring instances, only allow time changes, not date changes
                const originalDate = getDatePart(taskInfo.scheduled!);
                let updatedScheduled: string;
                
                if (allDay) {
                    // If dragged to all-day section, remove time component entirely
                    updatedScheduled = originalDate;
                    new Notice('Updated recurring task to all-day. This affects all future instances.');
                } else {
                    // If dragged to a specific time, update the time
                    const newTime = format(newStart, 'HH:mm');
                    updatedScheduled = `${originalDate}T${newTime}`;
                    new Notice(`Updated recurring task time to ${newTime}. This affects all future instances.`);
                }
                
                // Update the template time in scheduled field
                await this.plugin.taskService.updateProperty(taskInfo, 'scheduled', updatedScheduled);
            } else {
                // Handle non-recurring events normally
                let newDateString: string;
                if (allDay) {
                    newDateString = format(newStart, 'yyyy-MM-dd');
                } else {
                    newDateString = format(newStart, "yyyy-MM-dd'T'HH:mm");
                }
                
                // Update the appropriate property
                const propertyToUpdate = eventType === 'scheduled' ? 'scheduled' : 'due';
                await this.plugin.taskService.updateProperty(taskInfo, propertyToUpdate, newDateString);
            }
            
        } catch (error) {
            console.error('Error updating task date:', error);
            dropInfo.revert();
        }
    }

    private async handleTimeblockDrop(dropInfo: any, timeblock: TimeBlock, originalDate: string): Promise<void> {
        try {
            const newStart = dropInfo.event.start;
            const newEnd = dropInfo.event.end;
            
            // Calculate new date and times
            const newDate = format(newStart, 'yyyy-MM-dd');
            const newStartTime = format(newStart, 'HH:mm');
            const newEndTime = format(newEnd, 'HH:mm');
            
            // Update timeblock in daily notes
            await updateTimeblockInDailyNote(
                this.app,
                timeblock.id,
                originalDate,
                newDate,
                newStartTime,
                newEndTime
            );
            
            // Refresh calendar to show updated timeblock
            this.refreshEvents();
            
            // Show success message
            if (originalDate !== newDate) {
                new Notice(`Moved timeblock "${timeblock.title}" to ${newDate}`);
            } else {
                new Notice(`Updated timeblock "${timeblock.title}" time`);
            }
            
        } catch (error) {
            console.error('Error moving timeblock:', error);
            new Notice(`Failed to move timeblock: ${error.message}`);
            dropInfo.revert();
        }
    }

    async handleEventResize(resizeInfo: any) {
        const { taskInfo, timeblock, eventType, originalDate } = resizeInfo.event.extendedProps;
        
        if (eventType === 'timeblock') {
            // Handle timeblock resize
            await this.handleTimeblockResize(resizeInfo, timeblock, originalDate);
            return;
        }
        
        if (eventType !== 'scheduled' && eventType !== 'recurring') {
            // Only scheduled and recurring events and timeblocks can be resized (not timeEntry, ics, due)
            resizeInfo.revert();
            return;
        }
        
        try {
            const start = resizeInfo.event.start;
            const end = resizeInfo.event.end;
            
            if (start && end) {
                const durationMinutes = Math.round((end.getTime() - start.getTime()) / (1000 * 60));
                await this.plugin.taskService.updateProperty(taskInfo, 'timeEstimate', durationMinutes);
            }
            
        } catch (error) {
            console.error('Error updating task duration:', error);
            resizeInfo.revert();
        }
    }

    private async handleTimeblockResize(resizeInfo: any, timeblock: TimeBlock, originalDate: string): Promise<void> {
        try {
            const start = resizeInfo.event.start;
            const end = resizeInfo.event.end;
            
            if (!start || !end) {
                resizeInfo.revert();
                return;
            }
            
            // Calculate new times
            const newStartTime = format(start, 'HH:mm');
            const newEndTime = format(end, 'HH:mm');
            
            // Validate that end is after start
            const [startHour, startMin] = newStartTime.split(':').map(Number);
            const [endHour, endMin] = newEndTime.split(':').map(Number);
            const startMinutes = startHour * 60 + startMin;
            const endMinutes = endHour * 60 + endMin;
            
            if (endMinutes <= startMinutes) {
                new Notice('End time must be after start time');
                resizeInfo.revert();
                return;
            }
            
            // Update timeblock in daily note (same date, just time change)
            await updateTimeblockInDailyNote(
                this.app,
                timeblock.id,
                originalDate,
                originalDate, // Same date
                newStartTime,
                newEndTime
            );
            
            // Refresh calendar
            this.refreshEvents();
            
            new Notice(`Updated timeblock "${timeblock.title}" duration`);
            
        } catch (error) {
            console.error('Error resizing timeblock:', error);
            new Notice(`Failed to resize timeblock: ${error.message}`);
            resizeInfo.revert();
        }
    }

    async handleExternalDrop(dropInfo: any) {
        try {
            
            // Get task path from drag data transfer
            let taskPath: string | undefined;
            
            // Try to get from dataTransfer first (most reliable)
            if (dropInfo.dataTransfer) {
                taskPath = dropInfo.dataTransfer.getData('text/plain') || 
                          dropInfo.dataTransfer.getData('application/x-task-path');
            }
            
            // Fallback to element data attribute
            if (!taskPath && dropInfo.draggedEl) {
                taskPath = dropInfo.draggedEl.dataset.taskPath;
            }
            
            if (!taskPath) {
                console.warn('No task path found in drop data', dropInfo);
                return;
            }
            
            // Get the task info
            const task = await this.plugin.cacheManager.getTaskInfo(taskPath);
            if (!task) {
                console.warn('Task not found:', taskPath);
                return;
            }
            
            // Get the drop date/time
            const dropDate = dropInfo.date;
            if (!dropDate) {
                console.warn('No drop date provided');
                return;
            }
            
            // Format the date for task scheduling
            let scheduledDate: string;
            if (dropInfo.allDay) {
                // All-day event - just the date
                scheduledDate = format(dropDate, 'yyyy-MM-dd');
            } else {
                // Specific time - include time
                scheduledDate = format(dropDate, "yyyy-MM-dd'T'HH:mm");
            }
            
            // Update the task's scheduled date
            await this.plugin.taskService.updateProperty(task, 'scheduled', scheduledDate);
            
            
            // Show success feedback
            new Notice(`Task "${task.title}" scheduled for ${format(dropDate, dropInfo.allDay ? 'MMM d, yyyy' : 'MMM d, yyyy h:mm a')}`);
            
            // Remove any event that FullCalendar might have created from the drop
            if (dropInfo.draggedEl) {
                // Remove the dragged element to prevent it from being rendered as an event
                dropInfo.draggedEl.remove();
            }
            
            // Refresh calendar to show the new event with proper task data
            this.refreshEvents();
            
        } catch (error) {
            console.error('Error handling external drop:', error);
            new Notice('Failed to schedule task');
            
            // Remove any event that might have been created on error
            if (dropInfo.draggedEl) {
                dropInfo.draggedEl.remove();
            }
        }
    }

    /**
     * Handle when FullCalendar tries to create an event from external drop
     * We prevent this since we handle the task scheduling ourselves
     */
    handleEventReceive(info: any) {
        // Remove the automatically created event since we handle scheduling ourselves
        info.event.remove();
    }

    handleEventDidMount(arg: any) {
        // Incrementar contador de operaciones DOM
        this.performanceMetrics.domOperations++;
        
        // Marcar elemento como usado recientemente
        if (arg.el) {
            arg.el.dataset.lastUsed = Date.now().toString();
        }
        
        // Check if we have extended props
        if (!arg.event.extendedProps) {
            return;
        }
        
        const { taskInfo, icsEvent, timeblock, eventType, isCompleted, isRecurringInstance, instanceDate, subscriptionName } = arg.event.extendedProps;
        
        // Set common event type attribute for all events
        arg.el.setAttribute('data-event-type', eventType || 'unknown');
        
        // Handle ICS events
        if (eventType === 'ics') {
            this.optimizeICSEventElement(arg, icsEvent, subscriptionName);
            return;
        }
        
        // Handle timeblock events
        if (eventType === 'timeblock') {
            this.optimizeTimeblockElement(arg, timeblock);
            return;
        }
        
        // Handle task events
        if (!taskInfo || !taskInfo.path) {
            return;
        }
        
        // Optimize task event element
        this.optimizeTaskEventElement(arg, taskInfo, eventType, isCompleted, isRecurringInstance, instanceDate);
    }

    /**
     * Optimiza elementos de eventos ICS usando CSS transforms
     */
    private optimizeICSEventElement(arg: any, icsEvent: any, subscriptionName?: string): void {
        const el = arg.el;
        
        // Usar transform para optimizar rendering
        el.style.transform = 'translateZ(0)'; // Forzar compositing layer
        
        // Add visual styling for ICS events usando propiedades optimizadas
        el.style.borderStyle = 'solid';
        el.style.borderWidth = '2px';
        el.setAttribute('data-ics-event', 'true');
        el.setAttribute('data-subscription', subscriptionName || 'Unknown');
        el.classList.add('fc-ics-event');
        
        // Add tooltip with subscription name
        el.title = `${icsEvent?.title || 'Event'} (from ${subscriptionName || 'Calendar subscription'})`;
        
        // Add context menu for ICS events
        el.addEventListener("contextmenu", (jsEvent: MouseEvent) => {
            jsEvent.preventDefault();
            jsEvent.stopPropagation();
            this.showICSEventContextMenu(jsEvent, icsEvent, subscriptionName);
        });
    }

    /**
     * Optimiza elementos de timeblock usando CSS transforms
     */
    private optimizeTimeblockElement(arg: any, timeblock: any): void {
        const el = arg.el;
        
        // Usar transform para optimizar rendering
        el.style.transform = 'translateZ(0)'; // Forzar compositing layer
        
        // Add data attributes for timeblocks
        el.setAttribute('data-timeblock-id', timeblock?.id || '');
        
        // Add visual styling for timeblocks usando propiedades optimizadas
        el.style.borderStyle = 'solid';
        el.style.borderWidth = '2px';
        el.classList.add('fc-timeblock-event');
        
        // Ensure timeblocks are editable (can be dragged/resized)
        if (arg.event.setProp) {
            arg.event.setProp('editable', true);
        }
        
        // Add tooltip
        const attachmentCount = timeblock?.attachments?.length || 0;
        const tooltipText = `${timeblock?.title || 'Timeblock'}${timeblock?.description ? ` - ${timeblock.description}` : ''}${attachmentCount > 0 ? ` (${attachmentCount} attachment${attachmentCount > 1 ? 's' : ''})` : ''}`;
        el.title = tooltipText;
    }

    /**
     * Optimiza elementos de eventos de tarea usando técnicas de performance DOM
     */
    private optimizeTaskEventElement(arg: any, taskInfo: any, eventType: string, isCompleted: boolean, isRecurringInstance: boolean, instanceDate?: string): void {
        const el = arg.el;
        
        // Usar transform para optimizar rendering
        el.style.transform = 'translateZ(0)'; // Forzar compositing layer
        
        // Add data attributes for tasks
        el.setAttribute('data-task-path', taskInfo.path);
        el.classList.add('fc-task-event');

        // Add tag classes to tasks
        if (taskInfo.tags && taskInfo.tags.length > 0) {
            taskInfo.tags.forEach((tag: string) => {
                const sanitizedTag = tag.replace(/[^a-zA-Z0-9-_]/g, ''); 
                if (sanitizedTag) {
                    el.classList.add(`fc-tag-${sanitizedTag}`); 
                }
            });
        }
        
        // Set editable based on event type
        if (arg.event.setProp) {
            switch (eventType) {
                case 'scheduled':
                case 'recurring':
                    arg.event.setProp('editable', true);
                    break;
                case 'due':
                case 'timeEntry':
                    arg.event.setProp('editable', false);
                    break;
                default:
                    arg.event.setProp('editable', true);
            }
        }
        
        // Apply visual styling for recurring instances usando transforms
        if (isRecurringInstance) {
            // Add dashed border for recurring instances
            el.style.borderStyle = 'dashed';
            el.style.borderWidth = '2px';
            
            // Add recurring badge (already in title with 🔄)
            el.setAttribute('data-recurring', 'true');
            el.classList.add('fc-recurring-event');
            
            // Apply dimmed appearance for completed instances using opacity (no reflow)
            if (isCompleted) {
                el.style.opacity = '0.6';
            }
        }
        
        // Apply strikethrough styling for completed tasks usando transforms
        if (isCompleted) {
            const titleElement = el.querySelector('.fc-event-title, .fc-event-title-container');
            if (titleElement) {
                titleElement.style.textDecoration = 'line-through';
            } else {
                // Fallback: apply to the entire event element
                el.style.textDecoration = 'line-through';
            }
            el.classList.add('fc-completed-event');
        }
        
        // Add optimized event listeners
        this.attachOptimizedEventListeners(el, taskInfo, eventType, isRecurringInstance, instanceDate, arg);
    }

    /**
     * Adjunta event listeners optimizados para evitar memory leaks
     */
    private attachOptimizedEventListeners(el: HTMLElement, taskInfo: any, eventType: string, isRecurringInstance: boolean, instanceDate: string | undefined, arg: any): void {
        // Add hover preview functionality for all task-related events
        if (eventType !== 'ics') {
            const hoverHandler = (event: MouseEvent) => {
                const file = this.plugin.app.vault.getAbstractFileByPath(taskInfo.path);
                if (file) {
                    this.plugin.app.workspace.trigger('hover-link', {
                        event,
                        source: 'tasknotes-advanced-calendar',
                        hoverParent: el,
                        targetEl: el,
                        linktext: taskInfo.path,
                        sourcePath: taskInfo.path
                    });
                }
            };
            
            el.addEventListener('mouseover', hoverHandler, { passive: true });
        }
        
        // Add context menu functionality
        const contextMenuHandler = (jsEvent: MouseEvent) => {
            jsEvent.preventDefault();
            jsEvent.stopPropagation();
            
            if (eventType === 'timeEntry') {
                // Special context menu for time entries
                const { timeEntryIndex } = arg.event.extendedProps;
                this.showTimeEntryContextMenu(jsEvent, taskInfo, timeEntryIndex);
            } else {
                // Standard task context menu for other event types
                const targetDate = isRecurringInstance && instanceDate 
                    ? parseDate(instanceDate) 
                    : (arg.event.start || new Date());
                    
                showTaskContextMenu(jsEvent, taskInfo.path, this.plugin, targetDate);
            }
        };
        
        el.addEventListener("contextmenu", contextMenuHandler);
    }

    private clearTaskCache(): void {
        this.taskCache = {};
    }

    registerEvents(): void {
        // Clean up any existing listeners
        this.listeners.forEach(listener => this.plugin.emitter.offref(listener));
        this.listeners = [];
        this.functionListeners.forEach(unsubscribe => unsubscribe());
        this.functionListeners = [];
        
        // Listen for data changes
        const dataListener = this.plugin.emitter.on(EVENT_DATA_CHANGED, async () => {
            this.clearTaskCache(); // Limpiar caché cuando cambian los datos
            this.refreshEvents();
            // Update FilterBar options when data changes (new properties, contexts, etc.)
            if (this.filterBar) {
                console.log('AdvancedCalendarView: Updating FilterBar options due to data change');
                const updatedFilterOptions = await this.plugin.filterService.getFilterOptions();
                console.log('AdvancedCalendarView: Got updated options with projects count:', updatedFilterOptions.projects.length);
                this.filterBar.updateFilterOptions(updatedFilterOptions);
            }
        });
        this.listeners.push(dataListener);
        
        // Listen for task updates
        const taskUpdateListener = this.plugin.emitter.on(EVENT_TASK_UPDATED, async () => {
            this.clearTaskCache(); // Limpiar caché cuando se actualiza una tarea
            this.refreshEvents();
            // Update FilterBar options when tasks are updated (may have new properties, contexts, etc.)
            if (this.filterBar) {
                const updatedFilterOptions = await this.plugin.filterService.getFilterOptions();
                this.filterBar.updateFilterOptions(updatedFilterOptions);
            }
        });
        this.listeners.push(taskUpdateListener);
        
        // Listen for filter service data changes
        const filterDataListener = this.plugin.filterService.on('data-changed', () => {
            this.refreshEvents();
        });
        this.functionListeners.push(filterDataListener);
        
        // Listen for ICS subscription changes
        if (this.plugin.icsSubscriptionService) {
            const icsDataListener = this.plugin.icsSubscriptionService.on('data-changed', () => {
                this.refreshEvents();
            });
            this.functionListeners.push(icsDataListener);
        }
        
        // Listen for timeblocking toggle changes
        const timeblockingToggleListener = this.plugin.emitter.on(EVENT_TIMEBLOCKING_TOGGLED, (enabled: boolean) => {
            // Update visibility and refresh if timeblocking was enabled
            this.showTimeblocks = enabled && this.plugin.settings.calendarViewSettings.defaultShowTimeblocks;
            this.refreshEvents();
            this.setupViewOptions(); // Re-render view options
        });
        this.listeners.push(timeblockingToggleListener);

        // Listen for settings changes to update today highlight
        const settingsListener = this.plugin.emitter.on('settings-changed', () => {
            this.updateTodayHighlight();
        });
        this.listeners.push(settingsListener);
    }
    
    /**
     * Refreshes the calendar events by clearing the recurring instance cache
     * and triggering a refetch of events from the calendar, if available.
     * 
     * This method ensures that any cached recurring event instances are removed,
     * and the calendar is updated to reflect the latest event data.
     * 
     * @async
     */
    async refreshEvents() {
        this.startPerformanceMonitoring();
        
        // Limpiar solo el cache de instancias recurrentes para refrescar eventos
        this.recurringInstanceCache = {};
        
        if (this.calendar) {
            // Usar optimizaciones DOM para el refresh
            const events = await this.getCalendarEvents();
            
            // Aplicar optimizaciones de renderizado si hay muchos eventos
            if (events.length > 100) {
                console.log(`[DOM Optimization] Large event set detected (${events.length} events), applying optimizations`);
                // Solo aplicar optimizaciones de configuración, no interferir con renderizado
                this.optimizedEventRender(events);
            } else {
                // Para conjuntos pequeños, usar el método estándar
                this.calendar.refetchEvents();
            }
        }
        
        this.endPerformanceMonitoring('refreshEvents');
    }

    async onClose() {
        // Clean up unified cache
        this.unifiedEventCache = {};

        // Clean up resize handling
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        
        if (this.resizeTimeout) {
            window.clearTimeout(this.resizeTimeout);
            this.resizeTimeout = null;
        }
        
        // Clean up debounce timeout
        if (this.refreshTimeout) {
            window.clearTimeout(this.refreshTimeout);
            this.refreshTimeout = null;
        }
        
        // Remove event listeners
        this.listeners.forEach(listener => this.plugin.emitter.offref(listener));
        this.functionListeners.forEach(unsubscribe => unsubscribe());
        
        // Clean up DOM optimization resources
        this.cleanupElementPool();
        this.eventElementPool.clear();
        this.documentFragment = null;
        
        // Clear caches
        this.taskCache = {};
        this.recurringInstanceCache = {};
        
        // Clean up FilterBar
        if (this.filterBar) {
            this.filterBar.destroy();
            this.filterBar = null;
        }
        
        // Destroy calendar
        if (this.calendar) {
            this.calendar.destroy();
            this.calendar = null;
        }
        
        // Clean up
        this.contentEl.empty();
    }

    private showICSEventInfo(icsEvent: ICSEvent, subscriptionName?: string): void {
        const modal = new ICSEventInfoModal(this.app, this.plugin, icsEvent, subscriptionName);
        modal.open();
    }

    private showTimeblockInfo(timeblock: TimeBlock, eventDate: Date): void {
        const modal = new TimeblockInfoModal(this.app, this.plugin, timeblock, eventDate);
        modal.open();
    }

    private showICSEventContextMenu(jsEvent: MouseEvent, icsEvent: ICSEvent, subscriptionName?: string): void {
        const menu = new Menu();

        // Show details option
        menu.addItem((item) =>
            item
                .setTitle("Show details")
                .setIcon("info")
                .onClick(() => {
                    this.showICSEventInfo(icsEvent, subscriptionName);
                })
        );

        // Copy title option
        menu.addItem((item) =>
            item
                .setTitle("Copy title")
                .setIcon("copy")
                .onClick(async () => {
                    try {
                        await navigator.clipboard.writeText(icsEvent.title);
                        new Notice('Event title copied to clipboard');
                    } catch (error) {
                        new Notice('Failed to copy to clipboard');
                    }
                })
        );

        // Copy URL option (if available)
        if (icsEvent.url) {
            menu.addItem((item) =>
                item
                    .setTitle("Copy URL")
                    .setIcon("link")
                    .onClick(async () => {
                        try {
                            await navigator.clipboard.writeText(icsEvent.url!);
                            new Notice('Event URL copied to clipboard');
                        } catch (error) {
                            new Notice('Failed to copy to clipboard');
                        }
                    })
            );
        }

        menu.showAtMouseEvent(jsEvent);
    }

    private showTimeEntryContextMenu(jsEvent: MouseEvent, taskInfo: TaskInfo, timeEntryIndex: number): void {
        const menu = new Menu();

        // Show task details option
        menu.addItem((item) =>
            item
                .setTitle("Open task")
                .setIcon("edit")
                .onClick(() => {
                    const editModal = new TaskEditModal(this.app, this.plugin, { task: taskInfo });
                    editModal.open();
                })
        );

        menu.addSeparator();

        // Delete time entry option
        menu.addItem((item) =>
            item
                .setTitle("Delete time entry")
                .setIcon("trash")
                .onClick(async () => {
                    try {
                        const timeEntry = taskInfo.timeEntries?.[timeEntryIndex];
                        if (!timeEntry) {
                            new Notice('Time entry not found');
                            return;
                        }

                        // Calculate duration for confirmation message
                        let durationText = '';
                        if (timeEntry.startTime && timeEntry.endTime) {
                            const start = new Date(timeEntry.startTime);
                            const end = new Date(timeEntry.endTime);
                            const durationMs = end.getTime() - start.getTime();
                            const durationMinutes = Math.round(durationMs / (1000 * 60));
                            const hours = Math.floor(durationMinutes / 60);
                            const minutes = durationMinutes % 60;
                            
                            if (hours > 0) {
                                durationText = ` (${hours}h ${minutes}m)`;
                            } else {
                                durationText = ` (${minutes}m)`;
                            }
                        }

                        // Show confirmation
                        const confirmed = await new Promise<boolean>((resolve) => {
                            const confirmModal = new Modal(this.app);
                            confirmModal.setTitle('Delete Time Entry');
                            confirmModal.setContent(`Are you sure you want to delete this time entry${durationText}? This action cannot be undone.`);
                            
                            const buttonContainer = confirmModal.contentEl.createDiv({ cls: 'modal-button-container' });
                            buttonContainer.style.display = 'flex';
                            buttonContainer.style.justifyContent = 'flex-end';
                            buttonContainer.style.gap = '8px';
                            buttonContainer.style.marginTop = '20px';
                            
                            const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
                            const deleteBtn = buttonContainer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
                            
                            cancelBtn.onclick = () => {
                                confirmModal.close();
                                resolve(false);
                            };
                            
                            deleteBtn.onclick = () => {
                                confirmModal.close();
                                resolve(true);
                            };
                            
                            confirmModal.open();
                        });

                        if (confirmed) {
                            await this.plugin.taskService.deleteTimeEntry(taskInfo, timeEntryIndex);
                            new Notice('Time entry deleted');
                            this.refreshEvents();
                        }
                    } catch (error) {
                        console.error('Error deleting time entry:', error);
                        new Notice('Failed to delete time entry');
                    }
                })
        );

        menu.showAtMouseEvent(jsEvent);
    }

    private updateTodayHighlight() {
        const calendarContainer = this.contentEl.querySelector('.advanced-calendar-view__calendar-container');
        if (!calendarContainer) return;

        const showTodayHighlight = this.plugin.settings.calendarViewSettings.showTodayHighlight;
        if (showTodayHighlight) {
            calendarContainer.removeClass('hide-today-highlight');
        } else {
            calendarContainer.addClass('hide-today-highlight');
        }
    }
    
    /**
     * Wait for cache to be ready with actual data
     */
    private async waitForCacheReady(): Promise<void> {
        // First check if cache is already initialized
        if (this.plugin.cacheManager.isInitialized()) {
            return;
        }

        // Cache not initialized yet, wait for it
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.plugin.cacheManager.isInitialized()) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
    }
}
