export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser. Accepts arbitrary byte chunks: UTF-8 characters,
 * lines, CRLF pairs and events may all be split across chunk boundaries.
 */
export class SseParser {
  private decoder = new TextDecoder("utf-8");
  private buffer = "";
  private dataLines: string[] = [];
  private eventName = "";

  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** Flushes the decoder and any last event without a trailing blank line. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.drain(true);
    if (this.buffer) {
      this.line(this.buffer, events);
      this.buffer = "";
    }
    this.dispatch(events);
    return events;
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      if (ch === "\r" && i === this.buffer.length - 1 && !final) break;
      this.line(this.buffer.slice(start, i), events);
      if (ch === "\r" && this.buffer[i + 1] === "\n") i++;
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  private line(line: string, events: SseEvent[]) {
    if (line === "") return this.dispatch(events);
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventName = value;
  }

  private dispatch(events: SseEvent[]) {
    if (this.dataLines.length > 0) {
      events.push({ event: this.eventName || "message", data: this.dataLines.join("\n") });
    }
    this.dataLines = [];
    this.eventName = "";
  }
}
