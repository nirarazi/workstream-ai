import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Catches React render errors and displays them instead of a white screen.
 * This is diagnostic — helps us see the actual crash error.
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error("[ErrorBoundary] Caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
          <div className="max-w-2xl mx-auto">
            <h1 className="text-xl font-bold text-red-400 mb-4">Something crashed</h1>
            <div className="rounded border border-red-800 bg-red-950/50 p-4 mb-4">
              <p className="text-sm font-mono text-red-300 whitespace-pre-wrap break-all">
                {this.state.error?.message}
              </p>
            </div>
            {this.state.error?.stack && (
              <details className="mb-4">
                <summary className="text-sm text-gray-400 cursor-pointer">Stack trace</summary>
                <pre className="mt-2 text-xs text-gray-500 overflow-auto max-h-64 whitespace-pre-wrap">
                  {this.state.error.stack}
                </pre>
              </details>
            )}
            {this.state.errorInfo?.componentStack && (
              <details className="mb-4">
                <summary className="text-sm text-gray-400 cursor-pointer">Component stack</summary>
                <pre className="mt-2 text-xs text-gray-500 overflow-auto max-h-64 whitespace-pre-wrap">
                  {this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null, errorInfo: null });
              }}
              className="cursor-pointer rounded bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
            >
              Try to recover
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
