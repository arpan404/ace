type AppConfirmHandler = (message: string) => Promise<boolean>;

let appConfirmHandler: AppConfirmHandler | null = null;

export function registerAppConfirmHandler(handler: AppConfirmHandler): () => void {
  appConfirmHandler = handler;
  return () => {
    if (appConfirmHandler === handler) {
      appConfirmHandler = null;
    }
  };
}

export function requestAppConfirm(message: string): Promise<boolean> {
  if (!appConfirmHandler) {
    return Promise.resolve(false);
  }
  return appConfirmHandler(message);
}
