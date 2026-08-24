export const TERMINAL_DISPLACEMENT_YIELD_THRESHOLD = 2;

export interface TerminalDimensions {
  columns: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}

export interface TerminalArbitrationState {
  inputGeneration: number;
  reconnectGeneration: number;
  consecutiveDisplacements: number;
  yielded: boolean;
}

export interface TerminalInputActivity {
  generation: number;
  reclaimRequired: boolean;
}

interface QueuedTerminalInput {
  newUserInput?: boolean;
  onActivity?: (activity: TerminalInputActivity) => void;
  prepare: (
    activity: TerminalInputActivity,
    dimensions: TerminalDimensions | null,
  ) => void | Promise<void>;
  send: () => void | Promise<void>;
}

/**
 * Tracks client-local terminal ownership without adding a lease to the Herdr
 * protocol. A successful reconnect deliberately does not reset displacement
 * churn; only real local input starts a new ownership generation.
 */
export class TerminalArbitration {
  readonly state: TerminalArbitrationState = {
    inputGeneration: 0,
    reconnectGeneration: 0,
    consecutiveDisplacements: 0,
    yielded: false,
  };

  private dimensions: TerminalDimensions | null = null;
  private inputTail: Promise<void> = Promise.resolve();
  private pendingInputs = 0;

  cacheDimensions(dimensions: TerminalDimensions): void {
    this.dimensions = dimensions;
  }

  latestDimensions(): TerminalDimensions | null {
    return this.dimensions;
  }

  shouldSendResize(): boolean {
    return !this.state.yielded;
  }

  recordDisplacement(): boolean {
    if (this.state.reconnectGeneration !== this.state.inputGeneration) {
      this.state.reconnectGeneration = this.state.inputGeneration;
      this.state.consecutiveDisplacements = 0;
    }
    this.state.consecutiveDisplacements += 1;
    if (
      this.pendingInputs === 0
      && this.state.consecutiveDisplacements >= TERMINAL_DISPLACEMENT_YIELD_THRESHOLD
    ) {
      this.state.yielded = true;
    }
    return this.state.yielded;
  }

  recordUserInput(): TerminalInputActivity {
    const reclaimRequired = this.state.yielded;
    this.state.inputGeneration += 1;
    this.state.reconnectGeneration = this.state.inputGeneration;
    this.state.consecutiveDisplacements = 0;
    this.state.yielded = false;
    return {
      generation: this.state.inputGeneration,
      reclaimRequired,
    };
  }

  resumeManually(): void {
    this.state.reconnectGeneration = this.state.inputGeneration;
    this.state.consecutiveDisplacements = 0;
    this.state.yielded = false;
  }

  queueUserInput({
    newUserInput = true,
    onActivity,
    prepare,
    send,
  }: QueuedTerminalInput): Promise<void> {
    const activity = !newUserInput
      ? {
          generation: this.state.inputGeneration,
          reclaimRequired: this.state.yielded,
        }
      : this.recordUserInput();
    if (!newUserInput && this.state.yielded) {
      this.resumeManually();
    }
    this.pendingInputs += 1;
    onActivity?.(activity);
    const operation = async () => {
      await prepare(activity, this.dimensions);
      await send();
    };
    const pending = this.inputTail.then(operation, operation).finally(() => {
      this.pendingInputs -= 1;
    });
    this.inputTail = pending.catch(() => undefined);
    return pending;
  }
}
