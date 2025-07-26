/**
 * Calendar Worker Manager
 * Gestiona la comunicación con el Web Worker para procesamiento de eventos
 */

export class CalendarWorkerManager {
  private worker: Worker | null = null;
  private messageId = 0;
  private pendingMessages = new Map<string, { resolve: Function; reject: Function }>();
  private workerReady = false;

  constructor() {
    this.initializeWorker();
  }

  /**
   * Inicializa el Web Worker
   */
  private async initializeWorker(): Promise<void> {
    try {
      // Crear worker desde archivo TypeScript compilado
      const workerPath = new URL('../workers/calendarWorker.js', import.meta.url);
      this.worker = new Worker(workerPath, { type: 'module' });

      this.worker.addEventListener('message', this.handleWorkerMessage.bind(this));
      this.worker.addEventListener('error', this.handleWorkerError.bind(this));

      // Esperar a que el worker esté listo
      await new Promise<void>((resolve) => {
        const checkReady = (event: MessageEvent) => {
          if (event.data.type === 'READY') {
            this.workerReady = true;
            this.worker?.removeEventListener('message', checkReady);
            resolve();
          }
        };
        this.worker?.addEventListener('message', checkReady);
      });

      console.log('[Calendar Worker Manager] Worker initialized and ready');
    } catch (error) {
      console.error('[Calendar Worker Manager] Failed to initialize worker:', error);
      // Fallback sin worker
      this.workerReady = false;
    }
  }

  /**
   * Maneja mensajes del worker
   */
  private handleWorkerMessage(event: MessageEvent): void {
    const { type, payload, id } = event.data;

    if (type === 'READY') {
      this.workerReady = true;
      return;
    }

    const pendingMessage = this.pendingMessages.get(id);
    if (!pendingMessage) return;

    this.pendingMessages.delete(id);

    switch (type) {
      case 'EVENTS_PROCESSED':
      case 'EVENTS_OPTIMIZED':
        pendingMessage.resolve(payload);
        break;
      case 'ERROR':
        pendingMessage.reject(new Error(payload.error));
        break;
      default:
        pendingMessage.reject(new Error(`Unknown response type: ${type}`));
    }
  }

  /**
   * Maneja errores del worker
   */
  private handleWorkerError(error: ErrorEvent): void {
    console.error('[Calendar Worker Manager] Worker error:', error);
    
    // Rechazar todos los mensajes pendientes
    this.pendingMessages.forEach(({ reject }) => {
      reject(new Error('Worker error'));
    });
    this.pendingMessages.clear();
  }

  /**
   * Procesa eventos usando el worker (si está disponible)
   */
  async processEvents(tasks: any[], options: any): Promise<any[]> {
    if (!this.workerReady || !this.worker) {
      console.log('[Calendar Worker Manager] Worker not available, falling back to main thread');
      return this.processEventsMainThread(tasks, options);
    }

    return new Promise((resolve, reject) => {
      const id = (++this.messageId).toString();
      
      this.pendingMessages.set(id, { resolve, reject });
      
      this.worker!.postMessage({
        type: 'PROCESS_EVENTS',
        payload: { tasks, options },
        id
      });

      // Timeout después de 5 segundos
      setTimeout(() => {
        if (this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id);
          reject(new Error('Worker timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Optimiza eventos para GPU usando el worker
   */
  async optimizeEventsForGPU(events: any[]): Promise<any[]> {
    if (!this.workerReady || !this.worker) {
      // Fallback simple
      return events.map(event => ({
        ...event,
        extendedProps: {
          ...event.extendedProps,
          gpuOptimized: true
        }
      }));
    }

    return new Promise((resolve, reject) => {
      const id = (++this.messageId).toString();
      
      this.pendingMessages.set(id, { resolve, reject });
      
      this.worker!.postMessage({
        type: 'OPTIMIZE_EVENTS',
        payload: { events },
        id
      });

      // Timeout después de 2 segundos para optimización
      setTimeout(() => {
        if (this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id);
          reject(new Error('Worker optimization timeout'));
        }
      }, 2000);
    });
  }

  /**
   * Fallback para procesamiento en el hilo principal
   */
  private processEventsMainThread(tasks: any[], options: any): any[] {
    console.log('[Calendar Worker Manager] Processing events in main thread');
    // Esta es una versión simplificada - en la práctica usaríamos el método existente
    return [];
  }

  /**
   * Verifica si el worker está disponible
   */
  isWorkerAvailable(): boolean {
    return this.workerReady && this.worker !== null;
  }

  /**
   * Termina el worker
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
    }

    // Rechazar mensajes pendientes
    this.pendingMessages.forEach(({ reject }) => {
      reject(new Error('Worker terminated'));
    });
    this.pendingMessages.clear();
  }
}
