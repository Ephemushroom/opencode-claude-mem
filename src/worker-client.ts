/**
 * Worker Client for Claude-Mem
 * Handles communication with the local worker service running on port 37777.
 */
export class WorkerClient {
  private static readonly PORT = 37777;
  private static readonly BASE_URL = `http://127.0.0.1:${WorkerClient.PORT}`;

  /**
   * Check if the worker is healthy
   */
  static async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`${this.BASE_URL}/api/health`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * Ensure the worker is running.
   */
  static async ensureRunning(projectRoot: string): Promise<boolean> {
    return await this.isHealthy();
  }

  /**
   * Initialize a session
   */
  static async sessionInit(contentSessionId: string, project: string, prompt: string): Promise<{ sessionDbId: number; promptNumber: number } | null> {
    try {
      const response = await fetch(`${this.BASE_URL}/api/sessions/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentSessionId, project, prompt })
      });
      if (!response.ok) return null;
      return (await response.json()) as { sessionDbId: number; promptNumber: number };
    } catch (error) {
      return null;
    }
  }

  /**
   * Send observation
   */
  static async sendObservation(contentSessionId: string, toolName: string, toolInput: any, toolResponse: any, cwd: string): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentSessionId,
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd
        })
      });
    } catch (error) {
      // silently fail
    }
  }

  /**
   * Trigger summarization
   */
  static async summarize(contentSessionId: string, lastUserMessage: string, lastAssistantMessage: string): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentSessionId,
          last_user_message: lastUserMessage,
          last_assistant_message: lastAssistantMessage
        })
      });
    } catch (error) {
      // silently fail
    }
  }

  /**
   * Complete session
   */
  static async completeSession(contentSessionId: string): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentSessionId })
      });
    } catch (error) {
      // silently fail
    }
  }

  /**
   * Get pre-formatted context for system prompt injection.
   * Uses /api/context/inject which returns rich markdown with observations + session summaries.
   */
  static async getContext(project: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.BASE_URL}/api/context/inject?project=${encodeURIComponent(project)}`
      );
      if (!response.ok) return null;
      const data: any = await response.json();
      if (typeof data === "string") return data;
      if (data && typeof data.content === "string") return data.content;
      const text = JSON.stringify(data, null, 2);
      return text === "{}" || text === "null" ? null : text;
    } catch (e) {
      return null;
    }
  }

  /**
   * Perform Search (used by mem-search tool)
   */
  static async search(query: string, project: string): Promise<string> {
    try {
      const response = await fetch(`${this.BASE_URL}/api/search?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}`);
      if (!response.ok) return "Search failed";
      const data = await response.json();
      return JSON.stringify(data, null, 2);
    } catch (e) {
      return `Error performing search: ${e}`;
    }
  }
}
