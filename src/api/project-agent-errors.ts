/** Maps project-agent service errors to consistent HTTP status codes (B9c criterion #4). */
export function mapProjectAgentApiError(message: string): { status: number; error: string } {
  const msg = String(message || 'error').trim();
  if (/already added/i.test(msg)) {
    return { status: 409, error: msg };
  }
  if (/unknown (model|toolkit|agent|project)|project agent not found|not found/i.test(msg)) {
    return { status: 404, error: msg };
  }
  return { status: 400, error: msg };
}