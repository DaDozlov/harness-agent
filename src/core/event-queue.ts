/** Items pushed while something runs, read as they arrive; ends once closed and drained. */
export class EventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}
