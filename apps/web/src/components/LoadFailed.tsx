import { type ApiFailure, describeFailure } from '../api/errors';
import { Alert } from './Alert';

interface Props {
  failure: ApiFailure;
  retrying: boolean;
  onRetry: () => void;
}

/** The error line plus a retry button that stays mounted (and focused) while retrying. */
export function LoadFailed({ failure, retrying, onRetry }: Props) {
  return (
    <div className="stack">
      <Alert>{describeFailure(failure)}</Alert>
      <button
        type="button"
        aria-disabled={retrying}
        onClick={() => {
          if (!retrying) onRetry();
        }}
      >
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
