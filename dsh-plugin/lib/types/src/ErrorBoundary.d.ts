/**
 * Render-error boundary for tab panels: a throwing panel shows a placeholder
 * with a console record instead of blanking the whole sidebar (UF-001
 * failure branch).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
interface ErrorBoundaryState {
    failed: boolean;
}
/**
 * Wrap one tab panel; on render/update errors, render a placeholder.
 */
export declare class TabErrorBoundary extends Component<{
    children: ReactNode;
}, ErrorBoundaryState> {
    state: ErrorBoundaryState;
    componentDidCatch(error: unknown, info: ErrorInfo): void;
    render(): ReactNode;
}
export {};
//# sourceMappingURL=ErrorBoundary.d.ts.map