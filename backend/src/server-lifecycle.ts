export type ServerShutdownHooks = {
  stopAccepting(callback: (error?: Error) => void): void;
  closeConnections(): void;
  closeConfirmation(): Promise<void>;
  drainAgent(): Promise<void>;
  closeBrowsers(): Promise<void>;
  closeLegalRetrieval?(): Promise<void>;
  closePersistence(): void;
};

export function createServerShutdown(hooks: ServerShutdownHooks): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    if (shutdownPromise) return shutdownPromise;
    let confirmationClosed: Promise<void>;
    try { confirmationClosed = Promise.resolve(hooks.closeConfirmation()); }
    catch (error) { confirmationClosed = Promise.reject(error); }
    shutdownPromise = new Promise<void>((resolve, reject) => {
      hooks.stopAccepting(error => {
        if (error) { reject(error); return; }
        void (async () => {
          let failure: unknown;
          try { await confirmationClosed; } catch (error) { failure ??= error; }
          try { await hooks.drainAgent(); } catch (error) { failure ??= error; }
          try { await hooks.closeBrowsers(); } catch (error) { failure ??= error; }
          if (hooks.closeLegalRetrieval) { try { await hooks.closeLegalRetrieval(); } catch (error) { failure ??= error; } }
          try { hooks.closePersistence(); } catch (error) { failure ??= error; }
          if (failure) reject(failure); else resolve();
        })();
      });
    });
    try { hooks.closeConnections(); }
    catch (error) { shutdownPromise = Promise.reject(error); }
    return shutdownPromise;
  };
}
