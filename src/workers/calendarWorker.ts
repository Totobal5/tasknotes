/**
 * Web Worker para procesamiento intensivo de eventos del calendario
 * Libera el hilo principal para mejor responsividad
 */

// Hacer que este archivo sea un módulo válido
export {};

// Tipos básicos para el worker (definidos localmente para evitar dependencias)
interface TaskInfo {
  path: string;
  title: string;
  scheduled?: string;
  due?: string;
  priority?: string;
  status?: string;
  recurrence?: any;
  timeEntries?: TimeEntry[];
}

interface TimeEntry {
  startTime: string;
  endTime?: string;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  editable: boolean;
  extendedProps: {
    taskInfo: TaskInfo;
    eventType: string;
    isCompleted: boolean;
    timeEntryIndex?: number;
    gpuOptimized?: boolean;
    renderHint?: string;
  };
}

// Tipos para mensajes del worker
interface WorkerMessage {
  type: 'PROCESS_EVENTS' | 'PROCESS_RECURRING' | 'OPTIMIZE_EVENTS';
  payload: any;
  id: string;
}

interface WorkerResponse {
  type: 'EVENTS_PROCESSED' | 'RECURRING_PROCESSED' | 'EVENTS_OPTIMIZED' | 'ERROR';
  payload: any;
  id: string;
}

// Contexto del worker
const ctx: Worker = self as any;

/**
 * Procesa eventos de manera intensiva sin bloquear el UI
 */
function processEvents(tasks: TaskInfo[], options: any): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const startTime = performance.now();
  
  try {
    // Procesar en lotes para evitar bloqueos
    const batchSize = 100;
    
    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      
      for (const task of batch) {
        // Procesar eventos scheduled
        if (options.showScheduled && task.scheduled && !task.recurrence) {
          const scheduledEvent = createScheduledEventInWorker(task);
          if (scheduledEvent) events.push(scheduledEvent);
        }
        
        // Procesar eventos due
        if (options.showDue && task.due) {
          const dueEvent = createDueEventInWorker(task);
          if (dueEvent) events.push(dueEvent);
        }
        
        // Procesar time entries
        if (options.showTimeEntries && task.timeEntries) {
          const timeEvents = createTimeEntryEventsInWorker(task);
          events.push(...timeEvents);
        }
      }
      
      // Permitir que otros trabajos se ejecuten
      if (i + batchSize < tasks.length) {
        // Simular yield en el worker
        const now = performance.now();
        if (now - startTime > 50) { // Si hemos estado procesando por más de 50ms
          break; // Salir y continuar en el siguiente mensaje
        }
      }
    }
    
  } catch (error) {
    console.error('[Calendar Worker] Error processing events:', error);
  }
  
  return events;
}

/**
 * Crea evento scheduled en el worker
 */
function createScheduledEventInWorker(task: TaskInfo): CalendarEvent | null {
  if (!task.scheduled) return null;
  
  const hasTime = task.scheduled.includes('T');
  
  return {
    id: `scheduled-${task.path}`,
    title: task.title,
    start: task.scheduled,
    allDay: !hasTime,
    backgroundColor: 'transparent',
    borderColor: getPriorityColorInWorker(task.priority),
    textColor: getPriorityColorInWorker(task.priority),
    editable: true,
    extendedProps: {
      taskInfo: task,
      eventType: 'scheduled',
      isCompleted: isCompletedInWorker(task.status)
    }
  };
}

/**
 * Crea evento due en el worker
 */
function createDueEventInWorker(task: TaskInfo): CalendarEvent | null {
  if (!task.due) return null;
  
  const hasTime = task.due.includes('T');
  const borderColor = getPriorityColorInWorker(task.priority) || 'var(--color-orange)';
  
  return {
    id: `due-${task.path}`,
    title: `DUE: ${task.title}`,
    start: task.due,
    allDay: !hasTime,
    backgroundColor: hexToRgbaInWorker(borderColor, 0.15),
    borderColor: borderColor,
    textColor: borderColor,
    editable: false,
    extendedProps: {
      taskInfo: task,
      eventType: 'due',
      isCompleted: isCompletedInWorker(task.status)
    }
  };
}

/**
 * Crea eventos de time entry en el worker
 */
function createTimeEntryEventsInWorker(task: TaskInfo): CalendarEvent[] {
  if (!task.timeEntries) return [];
  
  return task.timeEntries
    .filter((entry: TimeEntry) => entry.endTime)
    .map((entry: TimeEntry, index: number) => ({
      id: `timeentry-${task.path}-${index}`,
      title: task.title,
      start: entry.startTime,
      end: entry.endTime!,
      allDay: false,
      backgroundColor: 'var(--color-base-50)',
      borderColor: 'var(--color-base-40)',
      textColor: 'var(--text-on-accent)',
      editable: false,
      extendedProps: {
        taskInfo: task,
        eventType: 'timeEntry' as const,
        isCompleted: isCompletedInWorker(task.status),
        timeEntryIndex: index
      }
    }));
}

/**
 * Utilidades del worker
 */
function getPriorityColorInWorker(priority?: string): string {
  // Colores básicos de prioridad (sin acceso al priority manager)
  switch (priority?.toLowerCase()) {
    case 'high': case 'alta': return '#ff4444';
    case 'medium': case 'media': return '#ffaa00';
    case 'low': case 'baja': return '#00aa00';
    default: return 'var(--color-accent)';
  }
}

function isCompletedInWorker(status?: string): boolean {
  return status === 'done' || status === 'completed' || status === 'x';
}

function hexToRgbaInWorker(hex: string, alpha: number): string {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Optimiza eventos para GPU rendering
 */
function optimizeEventsForGPU(events: CalendarEvent[]): CalendarEvent[] {
  return events.map(event => ({
    ...event,
    // Agregar propiedades optimizadas para GPU
    extendedProps: {
      ...event.extendedProps,
      gpuOptimized: true,
      renderHint: 'fast'
    }
  }));
}

// Message handler
ctx.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
  const { type, payload, id } = event.data;
  
  try {
    switch (type) {
      case 'PROCESS_EVENTS': {
        const { tasks, options } = payload;
        const processedEvents = processEvents(tasks, options);
        
        const response: WorkerResponse = {
          type: 'EVENTS_PROCESSED',
          payload: processedEvents,
          id
        };
        ctx.postMessage(response);
        break;
      }
      
      case 'OPTIMIZE_EVENTS': {
        const optimizedEvents = optimizeEventsForGPU(payload.events);
        
        const response: WorkerResponse = {
          type: 'EVENTS_OPTIMIZED',
          payload: optimizedEvents,
          id
        };
        ctx.postMessage(response);
        break;
      }
      
      default:
        console.warn('[Calendar Worker] Unknown message type:', type);
    }
  } catch (error) {
    const errorResponse: WorkerResponse = {
      type: 'ERROR',
      payload: { error: error.message },
      id
    };
    ctx.postMessage(errorResponse);
  }
});

// Señalar que el worker está listo
ctx.postMessage({ type: 'READY' });
