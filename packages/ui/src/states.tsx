import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

export type LoadingStateProps = HTMLAttributes<HTMLDivElement> & {
  /** Short accessible and visible description of the work in progress. */
  label?: string;
  /** Optional supporting text for longer loading operations. */
  detail?: string;
  /** Inline keeps the indicator compact; section centers it in its available space. */
  layout?: 'inline' | 'section';
};

/** Consistent, accessible loading presentation for pages and sections. */
export const LoadingState = forwardRef<HTMLDivElement, LoadingStateProps>(function LoadingState(
  { label = 'Loading', detail, layout = 'section', className = '', ...props }, ref,
) {
  return <div {...props} ref={ref} role="status" aria-live="polite" aria-busy="true"
    className={`ui-loading-state ui-loading-state-${layout} ${className}`}>
    <span aria-hidden className="ui-spinner" />
    <span className="ui-loading-copy"><span className="ui-loading-label">{label}</span>{detail && <span className="ui-loading-detail">{detail}</span>}</span>
  </div>;
});

export type EmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  /** Heading that explains why the section has no content. */
  title: string;
  /** Suggested next step or additional context. */
  description?: string;
  /** Optional decorative icon or illustration. */
  icon?: ReactNode;
  /** Optional action buttons or links. */
  children?: ReactNode;
  /** Compact is intended for small panels and individual columns. */
  layout?: 'compact' | 'section';
};

/** Consistent empty-state layout with optional icon and next-step actions. */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { title, description, icon, children, layout = 'section', className = '', ...props }, ref,
) {
  return <div {...props} ref={ref} className={`ui-empty-state ui-empty-state-${layout} ${className}`}>
    {icon && <span aria-hidden className="ui-empty-icon">{icon}</span>}
    <h3 className="ui-empty-title">{title}</h3>
    {description && <p className="ui-empty-description">{description}</p>}
    {children && <div className="ui-empty-actions">{children}</div>}
  </div>;
});
