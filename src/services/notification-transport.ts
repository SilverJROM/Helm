export interface NotificationPayload {
  name: string;
  project: string;
  model: string;
  message: string;
}

export interface NotificationTransport {
  notify(payload: NotificationPayload): Promise<void> | void;
}

export const httpNotificationTransport: NotificationTransport = {
  async notify(payload): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    const response = await fetch('http://127.0.0.1:8701/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`notification transport returned HTTP ${response.status}`);
  },
};

/** Fire-and-forget by contract: alert delivery must never hold or fail the engine transition. */
export function notifyBlockedRun(
  transport: NotificationTransport,
  input: { runId: number; batchId?: string | null; project?: string | null; message: string },
): void {
  const project = String(input.project || 'Helm');
  const payload: NotificationPayload = {
    name: 'Helm blocked run',
    project,
    model: 'engine',
    message: `Run ${input.runId}${input.batchId ? ` (${input.batchId})` : ''} is BLOCKED. ${input.message}`,
  };
  try {
    void Promise.resolve(transport.notify(payload)).catch((error: any) => {
      console.warn(`[helm-notify] blocked-run notification failed: ${error?.message || error}`);
    });
  } catch (error: any) {
    console.warn(`[helm-notify] blocked-run notification failed: ${error?.message || error}`);
  }
}
