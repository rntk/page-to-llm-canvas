import React from 'react';
import SurfaceError from './SurfaceError.jsx';

/**
 * Shared React error boundary used at surface roots and around record-driven
 * views. One malformed record shape or a
 * bug in a deeply-nested component used to blank the whole surface with no
 * message and no way out; this renders a plain-language error and a reload
 * affordance instead.
 *
 * Class component because `componentDidCatch`/`getDerivedStateFromError`
 * have no hook equivalent.
 *
 * `window` at the content-script rails is the HOST ARTICLE PAGE, not our
 * surface — a Reload button there would discard the reader's scroll position
 * and unsaved state. Callers on those rails should pass `onRetry` to recreate
 * the surface from freshly loaded data and `onDismiss` to tear down just the
 * rail. Try again always clears the boundary locally before invoking `onRetry`;
 * options/canvas roots also retain Reload as a fallback.
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
    console.error('PageToLLM: unhandled render error', error, info?.componentStack);
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
