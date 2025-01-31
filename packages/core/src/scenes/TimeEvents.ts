import type {Scene} from './Scene';
import {ValueDispatcher} from '../events';

/**
 * Represents a time event at runtime.
 */
export interface TimeEvent {
  /**
   * Name of the event.
   */
  name: string;
  /**
   * Time in seconds, relative to the beginning of the scene, at which the event
   * was registered.
   *
   * @remarks
   * In other words, the moment at which {@link flow.waitUntil} for this event
   * was invoked.
   */
  initialTime: number;
  /**
   * Time in seconds, relative to the beginning of the scene, at which the event
   * should end.
   */
  targetTime: number;
  /**
   * Duration of the event in seconds.
   */
  offset: number;
  /**
   * Stack trace at the moment of registration.
   */
  stack?: string;
}

/**
 * Represents a time event stored in a meta file.
 */
export interface SavedTimeEvent {
  name: string;
  targetTime: number;
}

/**
 * Manages time events for a given scene.
 */
export class TimeEvents {
  /**
   * Triggered when time events change.
   *
   * @eventProperty
   */
  public get onChanged() {
    return this.events.subscribable;
  }
  private readonly events = new ValueDispatcher<TimeEvent[]>([]);

  private registeredEvents: Record<string, TimeEvent> = {};
  private lookup: Record<string, TimeEvent> = {};
  private collisionLookup = new Set<string>();
  private previousReference: SavedTimeEvent[] = [];
  private didEventsChange = false;
  private preserveTiming = true;

  public constructor(private readonly scene: Scene) {
    this.previousReference = scene.meta.timeEvents.get();
    this.load(this.previousReference);

    scene.onReloaded.subscribe(this.handleReload);
    scene.onRecalculated.subscribe(this.handleRecalculated);
    scene.onReset.subscribe(this.handleReset);
    scene.meta.timeEvents.onChanged.subscribe(this.handleMetaChanged, false);
  }

  public get(name: string) {
    return this.registeredEvents[name] ?? null;
  }

  /**
   * Change the time offset of the given event.
   *
   * @param name - The name of the event.
   * @param offset - The time offset in seconds.
   * @param preserve - Whether the timing of the consecutive events should be
   *                   preserved. When set to `true` their offsets will be
   *                   adjusted to keep them in place.
   */
  public set(name: string, offset: number, preserve = true) {
    if (!this.lookup[name] || this.lookup[name].offset === offset) {
      return;
    }
    this.preserveTiming = preserve;
    this.lookup[name] = {
      ...this.lookup[name],
      targetTime: this.lookup[name].initialTime + offset,
      offset,
    };
    this.registeredEvents[name] = this.lookup[name];
    this.events.current = Object.values(this.registeredEvents);
    this.didEventsChange = true;
    this.scene.reload();
  }

  /**
   * Register a time event.
   *
   * @param name - The name of the event.
   *
   * @returns The absolute frame at which the event should occur.
   *
   * @internal
   */
  public register(name: string): number {
    if (this.collisionLookup.has(name)) {
      this.scene.logger.error({
        message: `name "${name}" has already been used for another event name.`,
        stack: new Error().stack,
      });
      return 0;
    }

    this.collisionLookup.add(name);

    const initialTime = this.scene.playback.framesToSeconds(
      this.scene.playback.frame - this.scene.firstFrame,
    );
    if (!this.lookup[name]) {
      this.didEventsChange = true;
      this.lookup[name] = {
        name,
        initialTime,
        targetTime: initialTime,
        offset: 0,
        stack: new Error().stack,
      };
    } else {
      let changed = false;
      const event = {...this.lookup[name]};

      const stack = new Error().stack;
      if (event.stack !== stack) {
        event.stack = stack;
        changed = true;
      }

      if (event.initialTime !== initialTime) {
        event.initialTime = initialTime;
        changed = true;
      }

      const offset = Math.max(0, event.targetTime - event.initialTime);
      if (this.preserveTiming && event.offset !== offset) {
        event.offset = offset;
        changed = true;
      }

      const target = event.initialTime + event.offset;
      if (!this.preserveTiming && event.targetTime !== target) {
        this.didEventsChange = true;
        event.targetTime = target;
        changed = true;
      }

      if (changed) {
        this.lookup[name] = event;
      }
    }

    this.registeredEvents[name] = this.lookup[name];

    return (
      this.scene.firstFrame +
      this.scene.playback.secondsToFrames(this.lookup[name].targetTime)
    );
  }

  /**
   * Called when the parent scene gets reloaded.
   */
  private handleReload = () => {
    this.registeredEvents = {};
    this.collisionLookup.clear();
  };

  /**
   * Called when the parent scene gets recalculated.
   */
  private handleRecalculated = () => {
    this.preserveTiming = true;
    this.events.current = Object.values(this.registeredEvents);

    if (
      this.didEventsChange ||
      (this.previousReference?.length ?? 0) !== this.events.current.length
    ) {
      this.didEventsChange = false;
      this.previousReference = Object.values(this.registeredEvents).map(
        event => ({
          name: event.name,
          targetTime: event.targetTime,
        }),
      );
      this.scene.meta.timeEvents.set(this.previousReference);
    }
  };

  private handleReset = () => {
    this.collisionLookup.clear();
  };

  /**
   * Called when the meta of the parent scene changes.
   */
  private handleMetaChanged = (data: SavedTimeEvent[]) => {
    // Ignore the event if `timeEvents` hasn't changed.
    // This may happen when another part of metadata has changed triggering
    // this event.
    if (data === this.previousReference) return;
    this.previousReference = data;
    this.load(data);
    this.scene.reload();
  };

  private load(events: SavedTimeEvent[]) {
    for (const event of events) {
      const previous = this.lookup[event.name] ?? {
        name: event.name,
        initialTime: 0,
        offset: 0,
      };

      this.lookup[event.name] = {
        ...previous,
        targetTime: event.targetTime,
      };
    }
  }
}
