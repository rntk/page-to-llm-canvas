import React from 'react';
import { createLogger } from '../shared/runtime/log.js';

const log = createLogger();

/**
 * Presentational error state shared by expected surface failures and the
 * unexpected-render ErrorBoundary fallback.
 */
export function SurfaceError({
  message,
  details,
  onRetry,
  retryLabel = 'Try again',
  onDismiss,
  onReload,
}) {
  return (
    <div className="pagetollm-error-boundary" role="alert">
      <p>{message}</p>
      {details ? (
        <details className="pagetollm-error-details">
          <summary>Details</summary>
          <p>{details}</p>
        </details>
      ) : null}
      <p>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}{' '}
        {onDismiss ? (
          <button type="button" onClick={onDismiss}>
            Close
          </button>
        ) : onReload ? (
          <button type="button" onClick={onReload}>
            Reload
          </button>
        ) : null}
      </p>
    </div>
  );
}

/**
 * Shared boundary for surface roots and record views. Shows an error and a
 * recovery action when rendering fails.
 *
 * Class component because `componentDidCatch`/`getDerivedStateFromError`
 * have no hook equivalent.
 *
 * Content-script rails run in the host page, so callers provide `onRetry` and
 * `onDismiss` to recover without reloading it. Retry clears local error first.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    log.error('unhandled render error', error, info?.componentStack);
  }

  componentDidUpdate(previousProps, previousState) {
    if (
      this.state.error &&
      previousState.error &&
      haveResetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ error: null });
    }
  }

  handleRetry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render() {
    if (this.state.error) {
      const { label = 'This view', onDismiss } = this.props;
      return (
        <SurfaceError
          message={`${label} hit an unexpected error and could not continue.`}
          details={this.state.error?.message}
          onRetry={this.handleRetry}
          onDismiss={onDismiss}
          onReload={onDismiss ? undefined : () => window.location.reload()}
        />
      );
    }
    return this.props.children;
  }
}

function haveResetKeysChanged(previousKeys, nextKeys) {
  if (!Array.isArray(previousKeys) || !Array.isArray(nextKeys)) return false;
  return (
    previousKeys.length !== nextKeys.length ||
    previousKeys.some((previousKey, index) => !Object.is(previousKey, nextKeys[index]))
  );
}
