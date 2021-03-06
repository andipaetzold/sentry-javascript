import { getCurrentHub, Scope } from '@sentry/hub';
import { Mechanism, SentryEvent, SentryWrappedFunction } from '@sentry/types';
import { isFunction } from '@sentry/utils/is';
import { htmlTreeAsString } from '@sentry/utils/misc';

const debounceDuration: number = 1000;
let keypressTimeout: number | undefined;
let lastCapturedEvent: Event | undefined;
let ignoreOnError: number = 0;

/** JSDoc */
export function shouldIgnoreOnError(): boolean {
  return ignoreOnError > 0;
}
/** JSDoc */
export function ignoreNextOnError(): void {
  // onerror should trigger before setTimeout
  ignoreOnError += 1;
  setTimeout(() => {
    ignoreOnError -= 1;
  });
}

/**
 * Instruments the given function and sends an event to Sentry every time the
 * function throws an exception.
 *
 * @param fn A function to wrap.
 * @returns The wrapped function.
 */
export function wrap(
  fn: SentryWrappedFunction,
  options: {
    mechanism?: Mechanism;
  } = {},
  before?: SentryWrappedFunction,
): any {
  try {
    // We don't wanna wrap it twice
    if (fn.__sentry__) {
      return fn;
    }
    // If this has already been wrapped in the past, return that wrapped function
    if (fn.__sentry_wrapper__) {
      return fn.__sentry_wrapper__;
    }
  } catch (e) {
    // Just accessing custom props in some Selenium environments
    // can cause a "Permission denied" exception (see raven-js#495).
    // Bail on wrapping and return the function as-is (defers to window.onerror).
    return fn;
  }

  const wrapped: SentryWrappedFunction = (...args: any[]) => {
    if (before && isFunction(before)) {
      before.apply(undefined, args);
    }

    try {
      // Attempt to invoke user-land function
      // NOTE: If you are a Sentry user, and you are seeing this stack frame, it
      //       means Raven caught an error invoking your application code. This is
      //       expected behavior and NOT indicative of a bug with Raven.js.
      return fn.apply(undefined, args);
    } catch (ex) {
      ignoreNextOnError();

      getCurrentHub().withScope(async () => {
        getCurrentHub().configureScope((scope: Scope) => {
          scope.addEventProcessor(async (event: SentryEvent) => {
            const processedEvent = { ...event };

            if (options.mechanism) {
              processedEvent.exception = processedEvent.exception || {};
              processedEvent.exception.mechanism = options.mechanism;
            }

            return processedEvent;
          });
        });

        getCurrentHub().captureException(ex, { originalException: ex });
      });

      throw ex;
    }
  };

  for (const property in fn) {
    if (Object.prototype.hasOwnProperty.call(fn, property)) {
      wrapped[property] = fn[property];
    }
  }

  wrapped.prototype = fn.prototype;
  fn.__sentry_wrapper__ = wrapped;

  // Signal that this function has been wrapped/filled already
  // for both debugging and to prevent it to being wrapped/filled twice
  wrapped.__sentry__ = true;
  wrapped.__sentry_original__ = fn;

  return wrapped;
}

/**
 * Wraps addEventListener to capture UI breadcrumbs
 * @param eventName the event name (e.g. "click")
 * @returns wrapped breadcrumb events handler
 */
export function breadcrumbEventHandler(eventName: string): (event: Event) => void {
  return (event: Event) => {
    // reset keypress timeout; e.g. triggering a 'click' after
    // a 'keypress' will reset the keypress debounce so that a new
    // set of keypresses can be recorded
    keypressTimeout = undefined;

    // It's possible this handler might trigger multiple times for the same
    // event (e.g. event propagation through node ancestors). Ignore if we've
    // already captured the event.
    if (lastCapturedEvent === event) {
      return;
    }

    lastCapturedEvent = event;

    // try/catch both:
    // - accessing event.target (see getsentry/raven-js#838, #768)
    // - `htmlTreeAsString` because it's complex, and just accessing the DOM incorrectly
    //   can throw an exception in some circumstances.
    let target;
    try {
      target = htmlTreeAsString(event.target as Node);
    } catch (e) {
      target = '<unknown>';
    }

    getCurrentHub().addBreadcrumb(
      {
        category: `ui.${eventName}`, // e.g. ui.click, ui.input
        message: target,
      },
      {
        event,
        name: eventName,
      },
    );
  };
}

/**
 * Wraps addEventListener to capture keypress UI events
 * @returns wrapped keypress events handler
 */
export function keypressEventHandler(): (event: Event) => void {
  // TODO: if somehow user switches keypress target before
  //       debounce timeout is triggered, we will only capture
  //       a single breadcrumb from the FIRST target (acceptable?)
  return (event: Event) => {
    let target;

    try {
      target = event.target;
    } catch (e) {
      // just accessing event properties can throw an exception in some rare circumstances
      // see: https://github.com/getsentry/raven-js/issues/838
      return;
    }

    const tagName = target && (target as HTMLElement).tagName;

    // only consider keypress events on actual input elements
    // this will disregard keypresses targeting body (e.g. tabbing
    // through elements, hotkeys, etc)
    if (!tagName || (tagName !== 'INPUT' && tagName !== 'TEXTAREA' && !(target as HTMLElement).isContentEditable)) {
      return;
    }

    // record first keypress in a series, but ignore subsequent
    // keypresses until debounce clears
    if (!keypressTimeout) {
      breadcrumbEventHandler('input')(event);
    }
    clearTimeout(keypressTimeout);

    keypressTimeout = (setTimeout(() => {
      keypressTimeout = undefined;
    }, debounceDuration) as any) as number;
  };
}
